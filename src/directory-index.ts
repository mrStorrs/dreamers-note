import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { ConventionPolicy } from "./conventions";
import { compareVaultPaths, readVaultRegularFile, scanVaultEntries, VaultExclusion } from "./files";
import { classifyVaultPath } from "./path-safety";
import type { Result } from "./types";

const FRONTMATTER_RE = /^---\r?\n.*?\r?\n---\r?\n/s;
const SUMMARY_METADATA_PREFIX_RE =
  /^(?:related|see also|parent|source|captured|created|updated|status|tags?)\s*:/i;
const WIKILINK_RE = /!?\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\([^)]+\)/g;
const DIRECTORY_INDEX_SYMLINK_SWAP_HOOK_ENV = "DREAMERS_NOTE_TEST_SWAP_DIRECTORY_INDEX_ENTRY_WITH_SYMLINK";

export interface DirectoryIndexEnvironment {
  vaultPath: string;
  privateGlobs: string[];
  conventionPolicy: ConventionPolicy;
}

export interface DirectoryIndexTarget {
  path: string;
  mode: "create" | "replace";
  body: string;
}

export interface DirectoryIndexDrift {
  path: string;
  kind: "missing" | "stale" | "malformed";
  evidencePaths: string[];
  currentHash: string | null;
  expectedHash: string | null;
}

export interface DirectoryIndexChangeInput {
  targets: Array<{
    path: string;
    mode: "create" | "replace";
    body?: string;
  }>;
  pathActions: Array<{
    type: "move" | "delete-file";
    scope: "vault" | "external";
    path: string;
    destinationPath?: string;
  }>;
}

export interface DirectoryIndexSnapshot {
  notes: ReadonlyMap<string, string>;
  directories: ReadonlySet<string>;
  exclusions: readonly VaultExclusion[];
}

interface VaultProjection {
  currentNotes: Map<string, string>;
  projectedNotes: Map<string, string>;
  currentDirectories: Set<string>;
  projectedDirectories: Set<string>;
  explicitHomepagePaths: Set<string>;
  exclusions: VaultExclusion[];
}

interface RenderedIndex {
  body: string;
  evidencePaths: string[];
}

type ProtectedContent =
  | { state: "ok"; content: string }
  | { state: "missing" | "ambiguous" };

export function planDirectoryIndexChanges(
  environment: DirectoryIndexEnvironment,
  input: DirectoryIndexChangeInput,
): Result<{ targets: DirectoryIndexTarget[] }> {
  const projection = buildProjection(environment, input);
  if (!projection.ok) {
    return projection;
  }
  const affectedDirectories = affectedDirectoriesForInput(environment.conventionPolicy, input);
  return renderTargets(environment, projection.value, [...affectedDirectories]);
}

export function planDirectoryIndexRepairs(
  environment: DirectoryIndexEnvironment,
  input: { paths: string[] },
): Result<{ targets: DirectoryIndexTarget[] }> {
  if (!Array.isArray(input.paths) || input.paths.length === 0) {
    return fail("invalid-arguments", "paths must be a non-empty string array");
  }
  const projection = buildProjection(environment, { targets: [], pathActions: [] });
  if (!projection.ok) {
    return projection;
  }
  const directories = new Set<string>();
  for (const requestedPath of input.paths) {
    const normalized = normalizeIndexPath(environment, requestedPath);
    if (!normalized.ok) {
      return normalized as Result<{ targets: DirectoryIndexTarget[] }>;
    }
    directories.add(path.posix.dirname(normalized.value));
  }
  return renderRepairTargets(environment, projection.value, [...directories]);
}

export function inspectDirectoryIndexDrift(
  environment: DirectoryIndexEnvironment,
): Result<{ items: DirectoryIndexDrift[] }> {
  const projection = buildProjection(environment, { targets: [], pathActions: [] });
  if (!projection.ok) {
    return projection;
  }
  const items: DirectoryIndexDrift[] = [];
  const eligibleDirectories = [...projection.value.currentDirectories]
    .filter((directory) => isEligibleDirectory(directory, environment.conventionPolicy))
    .sort(compareVaultPaths);
  for (const directory of eligibleDirectories) {
    const indexPath = indexPathForDirectory(directory, environment.conventionPolicy);
    const current = projection.value.currentNotes.get(indexPath);
    const protectedContent = current === undefined
      ? undefined
      : extractProtectedContent(current, environment.conventionPolicy);
    if (protectedContent && protectedContent.state !== "ok") {
      items.push({
        path: indexPath,
        kind: "malformed",
        evidencePaths: evidencePathsForDirectory(projection.value, directory, environment.conventionPolicy),
        currentHash: hashText(current ?? ""),
        expectedHash: null,
      });
      continue;
    }
    const rendered = renderDirectoryIndex(
      environment,
      snapshotFor(projection.value.currentNotes, projection.value.currentDirectories),
      directory,
    );
    if (!rendered.ok) {
      return rendered as Result<{ items: DirectoryIndexDrift[] }>;
    }
    if (current === undefined || current !== rendered.value.body) {
      items.push({
        path: indexPath,
        kind: current === undefined ? "missing" : "stale",
        evidencePaths: rendered.value.evidencePaths,
        currentHash: current === undefined ? null : hashText(current),
        expectedHash: hashText(rendered.value.body),
      });
    }
  }
  return {
    ok: true,
    value: {
      items,
    },
  };
}

export function readDirectoryIndexSnapshot(
  environment: DirectoryIndexEnvironment,
): Result<DirectoryIndexSnapshot> {
  const projection = buildProjection(environment, { targets: [], pathActions: [] });
  if (!projection.ok) {
    return projection;
  }
  return {
    ok: true,
    value: snapshotFor(
      projection.value.currentNotes,
      projection.value.currentDirectories,
      projection.value.exclusions,
    ),
  };
}

export function directoryIndexPathForDirectory(
  directory: string,
  policy: ConventionPolicy,
): string {
  return indexPathForDirectory(directory, policy);
}

export function isEligibleDirectoryIndexDirectory(
  directory: string,
  policy: ConventionPolicy,
): boolean {
  return isEligibleDirectory(directory, policy);
}

function buildProjection(
  environment: DirectoryIndexEnvironment,
  input: DirectoryIndexChangeInput,
): Result<VaultProjection> {
  try {
    const scan = scanVaultEntries({
      vaultPath: environment.vaultPath,
      privateGlobs: environment.privateGlobs,
    });
    const scannedNotes = new Map<string, string>();
    for (const entry of scan.files) {
      if (entry.kind !== "note") {
        continue;
      }
      maybeSwapDirectoryIndexEntryWithSymlink(entry.absolutePath, entry.relativePath);
      const content = readVaultRegularFile(environment.vaultPath, entry.relativePath);
      if (content === undefined) {
        throw new Error("vault file disappeared during directory index planning");
      }
      scannedNotes.set(entry.relativePath, content.toString("utf8"));
    }
    const currentNotes = new Map(
      [...scannedNotes].filter(([relativePath]) =>
        isClassifiedPath(relativePath, environment.conventionPolicy)),
    );
    const directories = new Set(
      scan.directories.filter((directory) =>
        isEligibleDirectory(directory, environment.conventionPolicy)),
    );
    const projectedNotes = new Map(currentNotes);
    const projectedDirectories = new Set(directories);
    const explicitHomepagePaths = new Set<string>();
    const writtenBodies = new Map<string, string>();

    for (const target of input.targets) {
      const relativePath = target.path;
      if (typeof target.body !== "string" || target.body.length === 0) {
        return fail("invalid-arguments", `target body must be non-empty for ${relativePath}`, relativePath);
      }
      writtenBodies.set(relativePath, target.body);
      if (!isClassifiedPath(relativePath, environment.conventionPolicy) || path.posix.extname(relativePath) !== ".md") {
        continue;
      }
      projectedNotes.set(relativePath, target.body);
      addDirectoryChain(projectedDirectories, path.posix.dirname(relativePath), environment.conventionPolicy);
      if (indexPathForDirectory(path.posix.dirname(relativePath), environment.conventionPolicy) === relativePath) {
        explicitHomepagePaths.add(relativePath);
      }
    }

    for (const action of input.pathActions) {
      if (action.type !== "move" || action.scope !== "vault" || !action.destinationPath) {
        continue;
      }
      const sourcePath = action.path;
      const destinationPath = action.destinationPath;
      const affectsClassifiedNotes =
        (isClassifiedPath(sourcePath, environment.conventionPolicy)
          || isClassifiedPath(destinationPath, environment.conventionPolicy))
        && path.posix.extname(sourcePath) === ".md"
        && path.posix.extname(destinationPath) === ".md";
      if (!affectsClassifiedNotes) {
        continue;
      }
      const body = projectedNotes.get(sourcePath) ?? writtenBodies.get(sourcePath) ?? scannedNotes.get(sourcePath);
      if (body === undefined) {
        return fail("proposal-source-missing", "move source path is missing");
      }
      projectedNotes.delete(sourcePath);
      if (isClassifiedPath(destinationPath, environment.conventionPolicy)) {
        projectedNotes.set(destinationPath, body);
        addDirectoryChain(projectedDirectories, path.posix.dirname(destinationPath), environment.conventionPolicy);
        if (
          writtenBodies.has(sourcePath)
          && indexPathForDirectory(path.posix.dirname(destinationPath), environment.conventionPolicy) === destinationPath
        ) {
          explicitHomepagePaths.add(destinationPath);
        }
      }
    }

    return {
      ok: true,
      value: {
        currentNotes,
        projectedNotes,
        currentDirectories: directories,
        projectedDirectories,
        explicitHomepagePaths,
        exclusions: scan.exclusions,
      },
    };
  } catch (error) {
    return fail(
      "directory-index-scan-failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function affectedDirectoriesForInput(
  policy: ConventionPolicy,
  input: DirectoryIndexChangeInput,
): Set<string> {
  const directories = new Set<string>();
  for (const target of input.targets ?? []) {
    addAffectedPath(directories, target.path, policy);
  }
  for (const action of input.pathActions ?? []) {
    if (action.type !== "move" || action.scope !== "vault") {
      continue;
    }
    addAffectedPath(directories, action.path, policy);
    if (action.destinationPath) {
      addAffectedPath(directories, action.destinationPath, policy);
    }
  }
  return directories;
}

function addAffectedPath(directories: Set<string>, relativePath: string, policy: ConventionPolicy): void {
  if (!isClassifiedPath(relativePath, policy) || path.posix.extname(relativePath) !== ".md") {
    return;
  }
  addDirectoryChain(directories, path.posix.dirname(relativePath), policy);
}

function addDirectoryChain(directories: Set<string>, initial: string, policy: ConventionPolicy): void {
  let directory = initial;
  while (isEligibleDirectory(directory, policy)) {
    directories.add(directory);
    const parent = path.posix.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
}

function renderTargets(
  environment: DirectoryIndexEnvironment,
  projection: VaultProjection,
  directories: string[],
): Result<{ targets: DirectoryIndexTarget[] }> {
  const targets: DirectoryIndexTarget[] = [];
  const baseline = snapshotFor(projection.currentNotes, projection.currentDirectories);
  const projected = snapshotFor(projection.projectedNotes, projection.projectedDirectories);
  for (const directory of [...new Set(directories)].sort(compareVaultPaths)) {
    if (!isEligibleDirectory(directory, environment.conventionPolicy)) {
      continue;
    }
    const indexPath = indexPathForDirectory(directory, environment.conventionPolicy);
    const current = projection.currentNotes.get(indexPath);
    const proposed = projection.projectedNotes.get(indexPath);
    const explicitHomepage = projection.explicitHomepagePaths.has(indexPath);
    const rendered = renderDirectoryIndex(environment, projected, directory);
    if (!rendered.ok) {
      return rendered as Result<{ targets: DirectoryIndexTarget[] }>;
    }
    if (explicitHomepage) {
      if (proposed === rendered.value.body) {
        continue;
      }
    } else {
      const baselineRendered = renderDirectoryIndex(environment, baseline, directory);
      if (!baselineRendered.ok) {
        return baselineRendered as Result<{ targets: DirectoryIndexTarget[] }>;
      }
      if (baselineRendered.value.body === rendered.value.body || current === rendered.value.body) {
        continue;
      }
    }
    targets.push({
      path: indexPath,
      mode: current === undefined ? "create" : "replace",
      body: rendered.value.body,
    });
  }
  return {
    ok: true,
    value: {
      targets,
    },
  };
}

export function renderDirectoryIndex(
  environment: DirectoryIndexEnvironment,
  snapshot: DirectoryIndexSnapshot,
  directory: string,
  protectedContentOverride?: string,
): Result<RenderedIndex> {
  const policy = environment.conventionPolicy;
  const indexPath = indexPathForDirectory(directory, policy);
  const source = snapshot.notes.get(indexPath);
  const extracted = protectedContentOverride !== undefined
    ? { state: "ok", content: protectedContentOverride } as const
    : source === undefined
      ? { state: "ok", content: "" } as const
      : extractProtectedContent(source, policy);
  if (extracted.state !== "ok") {
    return fail(
      extracted.state === "ambiguous"
        ? "directory-index-protected-section-ambiguous"
        : "directory-index-protected-section-missing",
      extracted.state === "ambiguous"
        ? `directory homepage has multiple ## ${policy.directoryIndex.protectedSection} sections`
        : `directory homepage has no ## ${policy.directoryIndex.protectedSection} section`,
      indexPath,
    );
  }
  const protectedContent = extracted.content;
  const subfolders = directSubfolders(snapshot.directories, directory, policy);
  const pages = directPages(snapshot.notes, directory, indexPath);
  const folderName = path.posix.basename(directory);
  const lead = directorySummary(folderName, protectedContent, subfolders, pages);
  const notesHeading = `## ${policy.directoryIndex.protectedSection}`;
  let body = `${lead}\n\n${notesHeading}`;
  body += protectedContent || "\n";
  const sections: string[] = [];
  if (subfolders.length > 0) {
    sections.push(renderSubfolders(subfolders, policy));
  }
  if (pages.length > 0) {
    sections.push(renderPages(pages));
  }
  for (const section of sections) {
    body += sectionSeparator(body);
    body += `${section}\n`;
  }
  if (!body.endsWith("\n") && !body.endsWith("\r")) {
    body += "\n";
  }
  return {
    ok: true,
    value: {
      body,
      evidencePaths: [
        ...subfolders.map((folder) => indexPathForDirectory(folder, policy)),
        ...pages.map((page) => page.path),
      ].slice(0, 8),
    },
  };
}

function renderRepairTargets(
  environment: DirectoryIndexEnvironment,
  projection: VaultProjection,
  directories: string[],
): Result<{ targets: DirectoryIndexTarget[] }> {
  const snapshot = snapshotFor(projection.currentNotes, projection.currentDirectories);
  const targets: DirectoryIndexTarget[] = [];
  for (const directory of [...new Set(directories)].sort(compareVaultPaths)) {
    if (!isEligibleDirectory(directory, environment.conventionPolicy)) {
      continue;
    }
    const indexPath = indexPathForDirectory(directory, environment.conventionPolicy);
    const current = projection.currentNotes.get(indexPath);
    const rendered = renderDirectoryIndex(environment, snapshot, directory);
    if (!rendered.ok) {
      return rendered as Result<{ targets: DirectoryIndexTarget[] }>;
    }
    if (current === rendered.value.body) {
      continue;
    }
    targets.push({
      path: indexPath,
      mode: current === undefined ? "create" : "replace",
      body: rendered.value.body,
    });
  }
  return {
    ok: true,
    value: { targets },
  };
}

function directSubfolders(
  directories: ReadonlySet<string>,
  parent: string,
  policy: ConventionPolicy,
): string[] {
  return [...directories]
    .filter((directory) => path.posix.dirname(directory) === parent && isEligibleDirectory(directory, policy))
    .sort(compareVaultPaths);
}

function directPages(
  notes: ReadonlyMap<string, string>,
  directory: string,
  indexPath: string,
): Array<{ path: string; title: string; summary: string }> {
  return [...notes.entries()]
    .filter(([relativePath]) =>
      path.posix.dirname(relativePath) === directory
      && relativePath !== indexPath
      && path.posix.extname(relativePath).toLowerCase() === ".md"
      && !path.posix.basename(relativePath).startsWith("_"))
    .sort(([left], [right]) =>
      path.posix.basename(left).toLowerCase().localeCompare(path.posix.basename(right).toLowerCase()))
    .map(([relativePath, body]) => {
      const fallback = path.posix.basename(relativePath, ".md");
      return {
        path: relativePath,
        title: noteTitle(body, fallback),
        summary: noteSummary(body, fallback),
      };
    });
}

function renderSubfolders(folders: string[], policy: ConventionPolicy): string {
  const lines = ["## Subfolders", ""];
  for (const folder of folders) {
    const label = displayName(path.posix.basename(folder));
    lines.push(
      `- [[${withoutSuffix(indexPathForDirectory(folder, policy))}|${label}]] - Contains pages and nested folders related to ${label}.`,
    );
  }
  return lines.join("\n");
}

function renderPages(pages: Array<{ path: string; title: string; summary: string }>): string {
  return [
    "## Pages",
    "",
    ...pages.map((page) => `- [[${withoutSuffix(page.path)}|${page.title}]] - ${page.summary}`),
  ].join("\n");
}

function directorySummary(
  rawFolderName: string,
  protectedContent: string,
  subfolders: string[],
  pages: Array<{ title: string }>,
): string {
  const folderName = displayName(rawFolderName);
  const notesSummary = firstSubstantiveSummary(protectedContent);
  if (notesSummary) {
    return subjectSummary(notesSummary, folderName);
  }
  const topics = uniqueTopics([
    ...subfolders.map((folder) => displayName(path.posix.basename(folder))),
    ...pages.map((page) => page.title),
  ]);
  if (topics.length > 0) {
    return `${folderName} collects notes on ${naturalList(topics)}.`;
  }
  return `${folderName} collects notes and references as they are added.`;
}

function subjectSummary(summary: string, folderName: string): string {
  const prefixes = [
    `${folderName} hub for `,
    `${folderName} is a hub for `,
    `${folderName} index for `,
    `${folderName} homepage for `,
    `${folderName} home page for `,
    `${folderName} directory homepage for `,
    `${folderName} is a directory homepage for `,
  ];
  for (const prefix of prefixes) {
    if (!summary.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())) {
      continue;
    }
    let subject = summary.slice(prefix.length).trim();
    if (!subject) {
      continue;
    }
    if (!/[.!?]$/.test(subject)) {
      subject += ".";
    }
    return `${folderName} covers ${subject}`;
  }
  const escapedFolder = folderName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const qualified = summary.match(
    new RegExp(`^${escapedFolder}\\s+(.+?)\\s+(?:hub|index|homepage|home page)\\s+for\\s+(.+)$`, "i"),
  );
  if (qualified) {
    const focus = qualified[1].trim().replace(/[.!?]+$/, "");
    const subject = qualified[2].trim().replace(/[.!?]+$/, "");
    if (focus && subject) {
      return `${folderName} covers ${subject}, with a focus on ${focus}.`;
    }
  }
  return summary;
}

function noteTitle(content: string, fallback: string): string {
  const body = stripFrontmatter(content);
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^# (.+?)\s*$/);
    if (match) {
      return cleanInlineText(match[1]) || displayName(fallback);
    }
  }
  return displayName(fallback);
}

function noteSummary(content: string, fallback: string): string {
  return firstSubstantiveSummary(content) ?? `Notes about ${displayName(fallback)}.`;
}

function firstSubstantiveSummary(content: string): string | undefined {
  const body = stripFrontmatter(content);
  for (const paragraph of contentParagraphs(body)) {
    if (isSummaryMetadata(paragraph)) {
      continue;
    }
    const summary = cleanInlineText(paragraph);
    if (summary) {
      return shorten(summary, 180);
    }
  }
  return undefined;
}

function stripFrontmatter(content: string): string {
  return content.replace(FRONTMATTER_RE, "");
}

function contentParagraphs(body: string): string[] {
  const paragraphs: string[] = [];
  let paragraph: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped) {
      if (paragraph.length > 0) {
        paragraphs.push(paragraph.join(" "));
        paragraph = [];
      }
      continue;
    }
    if (stripped.startsWith("#") || stripped.startsWith("<!--")) {
      if (paragraph.length > 0) {
        paragraphs.push(paragraph.join(" "));
        paragraph = [];
      }
      continue;
    }
    paragraph.push(stripped);
  }
  if (paragraph.length > 0) {
    paragraphs.push(paragraph.join(" "));
  }
  return paragraphs;
}

function isSummaryMetadata(paragraph: string): boolean {
  if (SUMMARY_METADATA_PREFIX_RE.test(paragraph)) {
    return true;
  }
  const withoutLinks = paragraph
    .replace(WIKILINK_RE, "")
    .replace(MARKDOWN_LINK_RE, "");
  return Boolean(paragraph) && !withoutLinks.replace(/[ \t\r\n,;|/\-*]/g, "");
}

function cleanInlineText(value: string): string {
  return value
    .replace(WIKILINK_RE, (_match, target: string, alias: string | undefined) => alias || target)
    .replace(MARKDOWN_LINK_RE, "$1")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function shorten(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  const cut = value.lastIndexOf(" ", limit - 3);
  return `${value.slice(0, cut > 0 ? cut : limit - 3).trimEnd()}...`;
}

function displayName(value: string): string {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toLocaleUpperCase()}${part.slice(1).toLocaleLowerCase()}`)
    .join(" ");
}

function uniqueTopics(topics: string[]): string[] {
  const seen = new Set<string>();
  return topics.filter((topic) => {
    const key = topic.toLocaleLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function naturalList(items: string[]): string {
  let displayed = items.slice(0, 4);
  if (items.length > 4) {
    displayed = [...items.slice(0, 3), "related topics"];
  }
  if (displayed.length === 1) {
    return displayed[0];
  }
  if (displayed.length === 2) {
    return `${displayed[0]} and ${displayed[1]}`;
  }
  return `${displayed.slice(0, -1).join(", ")}, and ${displayed[displayed.length - 1]}`;
}

function extractProtectedContent(content: string, policy: ConventionPolicy): ProtectedContent {
  const heading = `## ${policy.directoryIndex.protectedSection}`;
  const headingPattern = new RegExp(`^${escapeRegExp(heading)}[ \\t]*\\r?$`, "gm");
  const matches = [...content.matchAll(headingPattern)];
  if (matches.length === 0) {
    return { state: "missing" };
  }
  if (matches.length > 1) {
    return { state: "ambiguous" };
  }
  const match = matches[0];
  const afterHeading = (match.index ?? 0) + match[0].length;
  const remainder = content.slice(afterHeading);
  const nextHeading = /^## (?:Subfolders|Pages)[ \t]*\r?$/m.exec(remainder);
  return {
    state: "ok",
    content: remainder.slice(0, nextHeading?.index ?? remainder.length),
  };
}

function evidencePathsForDirectory(
  projection: VaultProjection,
  directory: string,
  policy: ConventionPolicy,
): string[] {
  const snapshot = snapshotFor(projection.projectedNotes, projection.projectedDirectories);
  return [
    ...directSubfolders(snapshot.directories, directory, policy)
      .map((folder) => indexPathForDirectory(folder, policy)),
    ...directPages(
      snapshot.notes,
      directory,
      indexPathForDirectory(directory, policy),
    ).map((page) => page.path),
  ].slice(0, 8);
}

function normalizeIndexPath(
  environment: DirectoryIndexEnvironment,
  input: string,
): Result<string> {
  const classified = classifyVaultPath({
    vaultPath: environment.vaultPath,
    input,
    privateGlobs: environment.privateGlobs,
  });
  if (!classified.ok) {
    if (["private-path", "excluded-root", "symlink", "symlink-path"].includes(classified.error.code)) {
      return fail("directory-index-path-rejected", "path is excluded, private, or unsafe");
    }
    return fail(classified.error.code, classified.error.message);
  }
  const relativePath = classified.value.normalizedRelativePath;
  const directory = path.posix.dirname(relativePath);
  if (
    !isEligibleDirectory(directory, environment.conventionPolicy)
    || indexPathForDirectory(directory, environment.conventionPolicy) !== relativePath
  ) {
    return fail("directory-index-path-invalid", "path is not a configured directory homepage", relativePath);
  }
  return {
    ok: true,
    value: relativePath,
  };
}

function indexPathForDirectory(directory: string, policy: ConventionPolicy): string {
  const folderName = path.posix.basename(directory);
  return path.posix.join(
    directory,
    policy.directoryIndex.filenamePattern.replace("<folder-name>", folderName),
  );
}

function isEligibleDirectory(directory: string, policy: ConventionPolicy): boolean {
  const parts = directory.split("/").filter(Boolean);
  return parts.length >= 2 && policy.classifiedNoteRoots.includes(parts[0]);
}

function isClassifiedPath(relativePath: string, policy: ConventionPolicy): boolean {
  const root = relativePath.split("/").filter(Boolean)[0] ?? "";
  return policy.classifiedNoteRoots.includes(root);
}

function withoutSuffix(relativePath: string): string {
  return relativePath.endsWith(".md") ? relativePath.slice(0, -3) : relativePath;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maybeSwapDirectoryIndexEntryWithSymlink(absolutePath: string, relativePath: string): void {
  const hook = process.env[DIRECTORY_INDEX_SYMLINK_SWAP_HOOK_ENV];
  if (!hook) {
    return;
  }
  const [target, referent] = hook.split("::", 2);
  if (target !== relativePath || !referent) {
    return;
  }
  fs.unlinkSync(absolutePath);
  fs.symlinkSync(referent, absolutePath);
}

function snapshotFor(
  notes: ReadonlyMap<string, string>,
  directories: ReadonlySet<string>,
  exclusions: readonly VaultExclusion[] = [],
): DirectoryIndexSnapshot {
  return {
    notes,
    directories,
    exclusions,
  };
}

function sectionSeparator(body: string): string {
  if (body.endsWith("\n\n") || body.endsWith("\r\n\r\n")) {
    return "";
  }
  if (body.endsWith("\n") || body.endsWith("\r")) {
    return "\n";
  }
  return "\n\n";
}

function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fail<T>(
  code: string,
  message: string,
  rejectedPath?: string,
): Result<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      path: rejectedPath,
    },
  };
}
