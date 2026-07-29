import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { loadVaultConfig } from "./config";
import { loadConventionPolicy } from "./conventions";
import {
  directoryIndexPathForDirectory,
  DirectoryIndexEnvironment,
  DirectoryIndexSnapshot,
  isEligibleDirectoryIndexDirectory,
  readDirectoryIndexSnapshot,
  renderDirectoryIndex,
} from "./directory-index";
import { compareVaultPaths } from "./files";
import { classifyVaultPath } from "./path-safety";
import { loadRuntimeConfig } from "./runtime";

interface MigrationOptions {
  rootDir: string;
  vaultPath?: string;
  write: boolean;
}

interface MigrationPlan {
  environment: DirectoryIndexEnvironment;
  snapshot: DirectoryIndexSnapshot;
  indexPaths: string[];
  ownerMoves: Array<{ source: string; destination: string; protectedContent: string }>;
  createdIndexes: number;
  refreshedIndexes: number;
  skippedPaths: string[];
  privatePathsSkipped: number;
}

interface LinkMap {
  exact: Map<string, string>;
  basenames: Map<string, string>;
}

export function runDirectoryIndexMigration(
  argv: string[],
  rootDir = process.cwd(),
): number {
  const options = parseMigrationOptions(argv, rootDir);
  if (!options) {
    return 2;
  }
  try {
    const plan = buildMigrationPlan(options);
    requireCleanGitWorktree(plan.environment.vaultPath);
    const rendered = renderMigration(plan);
    if (options.write) {
      applyMigration(plan, rendered.output);
    }
    printSummary(plan, rendered, options.write ? "write" : "dry-run");
    return 0;
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

function parseMigrationOptions(argv: string[], rootDir: string): MigrationOptions | undefined {
  let vaultPath: string | undefined;
  let mode: "dry-run" | "write" | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--vault") {
      const value = argv[index + 1];
      if (!value) {
        process.stderr.write("--vault requires a path\n");
        return undefined;
      }
      vaultPath = path.resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--write") {
      if (mode === "dry-run") {
        process.stderr.write("--write and --dry-run are mutually exclusive\n");
        return undefined;
      }
      mode = "write";
      continue;
    }
    if (argument === "--dry-run") {
      if (mode === "write") {
        process.stderr.write("--write and --dry-run are mutually exclusive\n");
        return undefined;
      }
      mode = "dry-run";
      continue;
    }
    process.stderr.write(`unknown option: ${argument}\n`);
    return undefined;
  }
  return {
    rootDir: path.resolve(rootDir),
    vaultPath,
    write: mode === "write",
  };
}

function buildMigrationPlan(options: MigrationOptions): MigrationPlan {
  const runtime = loadRuntimeConfig({ rootDir: options.rootDir });
  if (!runtime.ok) {
    throw new Error(runtime.error.message);
  }
  const conventions = loadConventionPolicy({ rootDir: options.rootDir });
  if (!conventions.ok) {
    throw new Error(conventions.error.message);
  }
  const configuredVault = options.vaultPath
    ? { ok: true as const, value: { vaultPath: options.vaultPath } }
    : loadVaultConfig({ rootDir: options.rootDir });
  if (!configuredVault.ok) {
    throw new Error(configuredVault.error.message);
  }
  const environment: DirectoryIndexEnvironment = {
    vaultPath: configuredVault.value.vaultPath,
    privateGlobs: runtime.value.privateGlobs,
    conventionPolicy: conventions.value,
  };
  if (!fs.existsSync(environment.vaultPath) || !fs.statSync(environment.vaultPath).isDirectory()) {
    throw new Error("vault directory does not exist");
  }
  const read = readDirectoryIndexSnapshot(environment);
  if (!read.ok) {
    throw new Error(read.error.message);
  }
  const snapshot = read.value;
  const indexPaths: string[] = [];
  const ownerMoves: Array<{ source: string; destination: string; protectedContent: string }> = [];
  let createdIndexes = 0;
  let refreshedIndexes = 0;
  const directories = [...snapshot.directories]
    .filter((directory) =>
      isEligibleDirectoryIndexDirectory(directory, environment.conventionPolicy))
    .sort(compareVaultPaths);
  for (const directory of directories) {
    const indexPath = directoryIndexPathForDirectory(directory, environment.conventionPolicy);
    const ownerPath = path.posix.join(directory, `${path.posix.basename(directory)}.md`);
    const existingIndex = snapshot.notes.get(indexPath);
    const ownerBody = snapshot.notes.get(ownerPath);
    if (existingIndex !== undefined && ownerBody !== undefined) {
      throw new Error(`index conflict: both ${indexPath} and its owner note exist`);
    }
    if (ownerBody !== undefined) {
      ownerMoves.push({
        source: ownerPath,
        destination: indexPath,
        protectedContent: `\n\n${ownerBody}`,
      });
    } else if (existingIndex === undefined) {
      createdIndexes += 1;
    } else {
      refreshedIndexes += 1;
    }
    indexPaths.push(indexPath);
  }
  const classifiedRoots = new Set(environment.conventionPolicy.classifiedNoteRoots);
  const classifiedExclusions = snapshot.exclusions.filter((item) =>
    classifiedRoots.has(item.relativePath.split("/")[0] ?? ""));
  return {
    environment,
    snapshot,
    indexPaths,
    ownerMoves,
    createdIndexes,
    refreshedIndexes,
    skippedPaths: classifiedExclusions
      .filter((item) => item.reason !== "private-path")
      .map((item) => item.relativePath)
      .sort(compareVaultPaths),
    privatePathsSkipped: classifiedExclusions.filter((item) => item.reason === "private-path").length,
  };
}

function renderMigration(plan: MigrationPlan): {
  output: Map<string, string>;
  linkRewrites: number;
  changedMarkdownFiles: number;
} {
  const projectedNotes = new Map(plan.snapshot.notes);
  for (const move of plan.ownerMoves) {
    projectedNotes.delete(move.source);
  }
  const projectedSnapshot: DirectoryIndexSnapshot = {
    notes: projectedNotes,
    directories: plan.snapshot.directories,
    exclusions: plan.snapshot.exclusions,
  };
  const renderedIndexes = new Map<string, string>();
  for (const indexPath of plan.indexPaths) {
    const directory = path.posix.dirname(indexPath);
    const ownerMove = plan.ownerMoves.find((move) => move.destination === indexPath);
    const rendered = renderDirectoryIndex(
      plan.environment,
      projectedSnapshot,
      directory,
      ownerMove?.protectedContent,
    );
    if (!rendered.ok) {
      throw new Error(`index conflict: ${rendered.error.message}`);
    }
    renderedIndexes.set(indexPath, rendered.value.body);
  }
  const linkMap = buildLinkMap(plan.ownerMoves);
  const existingIndexPaths = new Set(
    plan.indexPaths.filter((indexPath) =>
      fs.existsSync(path.join(plan.environment.vaultPath, indexPath))),
  );
  const output = new Map<string, string>();
  let linkRewrites = 0;
  let changedMarkdownFiles = 0;
  const projectedOutput = new Map(projectedNotes);
  for (const [indexPath, body] of renderedIndexes) {
    projectedOutput.set(indexPath, body);
  }
  for (const [relativePath, body] of [...projectedOutput].sort(([left], [right]) =>
    compareVaultPaths(left, right))) {
    const rewritten = existingIndexPaths.has(relativePath)
      ? rewriteOutsideProtectedSection(body, relativePath, linkMap, plan.environment)
      : rewriteLinks(body, relativePath, linkMap);
    output.set(relativePath, rewritten.body);
    linkRewrites += rewritten.count;
    const absolutePath = path.join(plan.environment.vaultPath, relativePath);
    const current = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, "utf8") : undefined;
    if (current !== rewritten.body) {
      changedMarkdownFiles += 1;
    }
  }
  return {
    output,
    linkRewrites,
    changedMarkdownFiles,
  };
}

function buildLinkMap(moves: Array<{ source: string; destination: string }>): LinkMap {
  const exact = new Map<string, string>();
  const targetsByBasename = new Map<string, Set<string>>();
  for (const move of moves) {
    const source = withoutMarkdownSuffix(move.source);
    const destination = withoutMarkdownSuffix(move.destination);
    exact.set(source, destination);
    const basename = path.posix.basename(source);
    const targets = targetsByBasename.get(basename) ?? new Set<string>();
    targets.add(destination);
    targetsByBasename.set(basename, targets);
  }
  const basenames = new Map<string, string>();
  for (const [basename, targets] of targetsByBasename) {
    if (targets.size === 1) {
      basenames.set(basename, [...targets][0]);
    }
  }
  return { exact, basenames };
}

function rewriteOutsideProtectedSection(
  body: string,
  currentPath: string,
  linkMap: LinkMap,
  environment: DirectoryIndexEnvironment,
): { body: string; count: number } {
  const heading = `## ${environment.conventionPolicy.directoryIndex.protectedSection}`;
  const headingPattern = new RegExp(`^${escapeRegExp(heading)}[ \\t]*\\r?$`, "m");
  const match = headingPattern.exec(body);
  if (!match) {
    return rewriteLinks(body, currentPath, linkMap);
  }
  const protectedStart = match.index + match[0].length;
  const remainder = body.slice(protectedStart);
  const nextHeading = /^## (?:Subfolders|Pages)[ \t]*\r?$/m.exec(remainder);
  const protectedEnd = protectedStart + (nextHeading?.index ?? remainder.length);
  const before = rewriteLinks(body.slice(0, protectedStart), currentPath, linkMap);
  const after = rewriteLinks(body.slice(protectedEnd), currentPath, linkMap);
  return {
    body: `${before.body}${body.slice(protectedStart, protectedEnd)}${after.body}`,
    count: before.count + after.count,
  };
}

function rewriteLinks(
  body: string,
  currentPath: string,
  linkMap: LinkMap,
): { body: string; count: number } {
  let count = 0;
  const wikilinks = body.replace(/(!?)\[\[([^\]]+)\]\]/g, (whole, embed: string, inner: string) => {
    const separatorIndex = inner.indexOf("|");
    const target = separatorIndex >= 0 ? inner.slice(0, separatorIndex) : inner;
    const alias = separatorIndex >= 0 ? inner.slice(separatorIndex + 1) : undefined;
    const [targetBase, anchor = ""] = target.split("#", 2);
    const replacement = resolveLinkTarget(targetBase, currentPath, linkMap);
    if (!replacement) {
      return whole;
    }
    count += 1;
    const display = alias ?? (embed ? "" : path.posix.basename(targetBase, ".md"));
    return `${embed}[[${replacement}${anchor ? `#${anchor}` : ""}${display ? `|${display}` : ""}]]`;
  });
  const markdown = wikilinks.replace(
    /(?<!!)\[([^\]]+)\]\(([^\s)]+)\)/g,
    (whole, label: string, target: string) => {
      const [targetBase, anchor = ""] = target.split("#", 2);
      const replacement = resolveLinkTarget(targetBase, currentPath, linkMap);
      if (!replacement) {
        return whole;
      }
      count += 1;
      return `[${label}](${replacement}.md${anchor ? `#${anchor}` : ""})`;
    },
  );
  return { body: markdown, count };
}

function resolveLinkTarget(target: string, currentPath: string, linkMap: LinkMap): string | undefined {
  if (!target || target.includes("://") || target.startsWith("#") || target.startsWith("/")) {
    return undefined;
  }
  const direct = normalizeLinkPath(target);
  const exact = linkMap.exact.get(direct);
  if (exact) {
    return exact;
  }
  if (!direct.includes("/")) {
    return linkMap.basenames.get(direct);
  }
  const relative = normalizeLinkPath(path.posix.join(path.posix.dirname(currentPath), target));
  return linkMap.exact.get(relative);
}

function normalizeLinkPath(value: string): string {
  return withoutMarkdownSuffix(path.posix.normalize(value.trim())).replace(/^\.\//, "");
}

function applyMigration(plan: MigrationPlan, output: Map<string, string>): void {
  for (const [relativePath, body] of output) {
    const classified = classifyVaultPath({
      vaultPath: plan.environment.vaultPath,
      input: relativePath,
      privateGlobs: plan.environment.privateGlobs,
    });
    if (!classified.ok) {
      throw new Error("migration produced an unsafe output path");
    }
    const current = fs.existsSync(classified.value.absolutePath)
      ? fs.readFileSync(classified.value.absolutePath, "utf8")
      : undefined;
    if (current === body) {
      continue;
    }
    fs.mkdirSync(path.dirname(classified.value.absolutePath), { recursive: true });
    fs.writeFileSync(classified.value.absolutePath, body, "utf8");
  }
  for (const move of plan.ownerMoves) {
    const source = classifyVaultPath({
      vaultPath: plan.environment.vaultPath,
      input: move.source,
      privateGlobs: plan.environment.privateGlobs,
    });
    if (!source.ok) {
      throw new Error("migration owner source became unsafe");
    }
    if (fs.existsSync(source.value.absolutePath)) {
      fs.unlinkSync(source.value.absolutePath);
    }
  }
}

function requireCleanGitWorktree(vaultPath: string): void {
  const inside = spawnSync("git", ["-C", vaultPath, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
  });
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    throw new Error("vault is not a git repository");
  }
  const status = spawnSync("git", ["-C", vaultPath, "status", "--short"], {
    encoding: "utf8",
  });
  if (status.status !== 0) {
    throw new Error("could not inspect vault Git status");
  }
  if (status.stdout.trim()) {
    throw new Error("vault worktree is dirty; commit or stash changes before migration");
  }
}

function printSummary(
  plan: MigrationPlan,
  rendered: { linkRewrites: number; changedMarkdownFiles: number },
  mode: "dry-run" | "write",
): void {
  process.stdout.write(`mode: ${mode}\n`);
  process.stdout.write(`eligible directories: ${plan.indexPaths.length}\n`);
  process.stdout.write(`created indexes: ${plan.createdIndexes}\n`);
  process.stdout.write(`refreshed indexes: ${plan.refreshedIndexes}\n`);
  process.stdout.write(`renamed owner notes: ${plan.ownerMoves.length}\n`);
  process.stdout.write(`link rewrites: ${rendered.linkRewrites}\n`);
  process.stdout.write(`changed markdown files: ${rendered.changedMarkdownFiles}\n`);
  process.stdout.write(`skipped paths: ${plan.skippedPaths.length}\n`);
  process.stdout.write(`private paths skipped: ${plan.privatePathsSkipped}\n`);
  process.stdout.write("warnings: 0\n");
  for (const skippedPath of plan.skippedPaths) {
    process.stdout.write(`- skipped: ${skippedPath}\n`);
  }
  process.stdout.write("index paths:\n");
  for (const indexPath of plan.indexPaths) {
    process.stdout.write(`- ${indexPath}\n`);
  }
}

function withoutMarkdownSuffix(value: string): string {
  return value.endsWith(".md") ? value.slice(0, -3) : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
