import fs from "fs";
import path from "path";
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
import type { ChangeCreateInput } from "./change-contracts";
import type { Result } from "./types";

interface LinkMap {
  exact: Map<string, string>;
  basenames: Map<string, string>;
}

export interface DirectoryIndexChangePlan {
  changeInput: ChangeCreateInput | null;
  changedPaths: string[];
}

interface DirectoryOwnerMove {
  source: string;
  destination: string;
  protectedContent: string;
}

interface DirectoryIndexOwnershipPlan {
  indexPaths: string[];
  ownerMoves: DirectoryOwnerMove[];
}

interface DirectoryIndexRenderOutput {
  output: Map<string, string>;
  linkRewrites: number;
}

const MAX_DIRECTORY_INDEX_RESULT_BYTES = 512 * 1024;

export function planDirectoryIndexChange(
  environment: DirectoryIndexEnvironment,
  input: { paths?: string[] } = {},
): Result<DirectoryIndexChangePlan> {
  const snapshot = readDirectoryIndexSnapshot(environment);
  if (!snapshot.ok) {
    return snapshot as Result<DirectoryIndexChangePlan>;
  }
  const directories = selectedDirectories(environment, input.paths ?? [], snapshot.value);
  if (!directories.ok) {
    return directories as Result<DirectoryIndexChangePlan>;
  }
  const ownership = planDirectoryIndexOwnership(environment, snapshot.value, directories.value);
  if (!ownership.ok) {
    return ownership as Result<DirectoryIndexChangePlan>;
  }
  const rendered = renderDirectoryIndexOutput(environment, snapshot.value, ownership.value);
  if (!rendered.ok) {
    return rendered as Result<DirectoryIndexChangePlan>;
  }
  const ownerByDestination = new Map(ownership.value.ownerMoves.map((move) => [move.destination, move]));
  const writes: NonNullable<ChangeCreateInput["writes"]> = [];
  for (const [relativePath, body] of rendered.value.output) {
    const ownerMove = ownerByDestination.get(relativePath);
    if (ownerMove) {
      writes.push({ path: ownerMove.source, body, beforeMove: true });
      continue;
    }
    if (snapshot.value.notes.get(relativePath) !== body) {
      writes.push({ path: relativePath, body });
    }
  }
  writes.sort((left, right) => compareVaultPaths(left.path, right.path));
  const moves: NonNullable<ChangeCreateInput["moves"]> = ownership.value.ownerMoves
    .map((move) => ({ from: move.source, to: move.destination }))
    .sort((left, right) => compareVaultPaths(left.from, right.from) || compareVaultPaths(left.to, right.to));
  const changedPaths = [...new Set([
    ...writes.map((write) => write.path),
    ...moves.flatMap((move) => [move.from, move.to]),
  ])].sort(compareVaultPaths);
  const changeInput: ChangeCreateInput | null = writes.length === 0 && moves.length === 0
    ? null
    : { summary: "Refresh directory homepages", writes, moves };
  if (changeInput && Buffer.byteLength(JSON.stringify(changeInput), "utf8") > MAX_DIRECTORY_INDEX_RESULT_BYTES) {
    return failDirectoryPlan("directory-index-output-too-large", "directory index change input exceeds the reviewable output limit");
  }
  return {
    ok: true,
    value: {
      changeInput,
      changedPaths,
    },
  };
}

function selectedDirectories(
  environment: DirectoryIndexEnvironment,
  paths: string[],
  snapshot: DirectoryIndexSnapshot,
): Result<string[]> {
  if (paths.length === 0) {
    return {
      ok: true,
      value: [...snapshot.directories]
        .filter((directory) => isEligibleDirectoryIndexDirectory(directory, environment.conventionPolicy))
        .sort(compareVaultPaths),
    };
  }
  const directories = new Set<string>();
  for (const requestedPath of paths) {
    const classified = classifyVaultPath({
      vaultPath: environment.vaultPath,
      input: requestedPath,
      privateGlobs: environment.privateGlobs,
    });
    if (!classified.ok) {
      return failDirectoryPlan("directory-index-path-invalid", "directory index path is not eligible");
    }
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(classified.value.absolutePath);
    } catch {
      return failDirectoryPlan("directory-index-path-invalid", "directory index path does not exist");
    }
    if (stat.isSymbolicLink()) {
      return failDirectoryPlan("directory-index-path-invalid", "directory index path is not eligible");
    }
    const directory = stat.isDirectory()
      ? classified.value.normalizedRelativePath
      : path.posix.dirname(classified.value.normalizedRelativePath);
    if (!isEligibleDirectoryIndexDirectory(directory, environment.conventionPolicy)) {
      return failDirectoryPlan("directory-index-path-invalid", "directory index path is outside eligible directories");
    }
    directories.add(directory);
  }
  return { ok: true, value: [...directories].sort(compareVaultPaths) };
}

function planDirectoryIndexOwnership(
  environment: DirectoryIndexEnvironment,
  snapshot: DirectoryIndexSnapshot,
  directories: string[],
): Result<DirectoryIndexOwnershipPlan> {
  const indexPaths: string[] = [];
  const ownerMoves: DirectoryOwnerMove[] = [];
  for (const directory of directories) {
    const indexPath = directoryIndexPathForDirectory(directory, environment.conventionPolicy);
    const ownerPath = path.posix.join(directory, `${path.posix.basename(directory)}.md`);
    const existingIndex = snapshot.notes.get(indexPath);
    const ownerBody = snapshot.notes.get(ownerPath);
    if (existingIndex !== undefined && ownerBody !== undefined) {
      return failDirectoryPlan("directory-index-owner-conflict", "directory homepage and legacy owner note both exist");
    }
    if (ownerBody !== undefined) {
      ownerMoves.push({
        source: ownerPath,
        destination: indexPath,
        protectedContent: `\n\n${ownerBody}`,
      });
    }
    indexPaths.push(indexPath);
  }
  return { ok: true, value: { indexPaths, ownerMoves } };
}

function renderDirectoryIndexOutput(
  environment: DirectoryIndexEnvironment,
  snapshot: DirectoryIndexSnapshot,
  ownership: DirectoryIndexOwnershipPlan,
): Result<DirectoryIndexRenderOutput> {
  const projectedNotes = new Map(snapshot.notes);
  for (const move of ownership.ownerMoves) {
    projectedNotes.delete(move.source);
  }
  const projectedSnapshot: DirectoryIndexSnapshot = {
    notes: projectedNotes,
    directories: snapshot.directories,
    exclusions: snapshot.exclusions,
  };
  const renderedIndexes = new Map<string, string>();
  for (const indexPath of ownership.indexPaths) {
    const ownerMove = ownership.ownerMoves.find((move) => move.destination === indexPath);
    const rendered = renderDirectoryIndex(
      environment,
      projectedSnapshot,
      path.posix.dirname(indexPath),
      ownerMove?.protectedContent,
    );
    if (!rendered.ok) {
      return rendered as Result<DirectoryIndexRenderOutput>;
    }
    renderedIndexes.set(indexPath, rendered.value.body);
  }
  const linkMap = buildLinkMap(ownership.ownerMoves);
  const existingIndexPaths = new Set(ownership.indexPaths.filter((indexPath) => snapshot.notes.has(indexPath)));
  const output = new Map(projectedNotes);
  for (const [indexPath, body] of renderedIndexes) {
    output.set(indexPath, body);
  }
  let linkRewrites = 0;
  for (const [relativePath, body] of [...output].sort(([left], [right]) => compareVaultPaths(left, right))) {
    const rewritten = existingIndexPaths.has(relativePath)
      ? rewriteOutsideProtectedSection(body, relativePath, linkMap, environment)
      : rewriteLinks(body, relativePath, linkMap);
    output.set(relativePath, rewritten.body);
    linkRewrites += rewritten.count;
  }
  return { ok: true, value: { output, linkRewrites } };
}

function failDirectoryPlan<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message } };
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

function withoutMarkdownSuffix(value: string): string {
  return value.endsWith(".md") ? value.slice(0, -3) : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
