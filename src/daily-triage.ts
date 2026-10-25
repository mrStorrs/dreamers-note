import { spawnSync } from "child_process";
import path from "path";
import { compareVaultPaths, readVaultRegularFile, scanVaultEntries } from "./files";
import { classifyVaultPath } from "./path-safety";
import type { ChangeCreateInput } from "./change-contracts";
import type { Result } from "./types";
import type { VaultEnvironment } from "./vault-environment";

const DAILY_NOTES_ROOT = "00-inbox/daily-notes";
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 50;
const FRAGMENT_HEADING = /^##\s+(project|knowledge|area|source|person):\s+(.+?)\s*$/i;
const HASHTAG = /(?<!\w)#([a-zA-Z][a-zA-Z0-9_-]*)/g;
const TAGS_LINE = /\btags?\s*:\s*(.+)$/gim;
const MAX_DAILY_TRIAGE_RESULT_BYTES = 512 * 1024;

export interface DailyTriageInput {
  paths?: string[];
  archiveCheck?: boolean;
  cursor?: string;
  limit?: number;
}

export interface DailyTriageFragment {
  kind: "project" | "knowledge" | "area" | "source" | "person";
  title: string;
  sourcePath: string;
  sourceExcerpt: string;
  suggestedDestination: string;
  approvedTags: string[];
  proposedTags: string[];
}

export interface DailyTriageResult {
  items: Array<{
    path: string;
    fragments: DailyTriageFragment[];
    archive: {
      requested: boolean;
      path: string;
      ready: boolean;
      blockers: string[];
    };
  }>;
  nextCursor: string | null;
  changeInput: ChangeCreateInput | null;
}

interface ParsedDailyNote {
  path: string;
  fragments: DailyTriageFragment[];
}

export function planDailyTriage(
  environment: VaultEnvironment,
  input: DailyTriageInput = {},
): Result<DailyTriageResult> {
  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    return fail("daily-triage-limit-invalid", "daily triage limit is outside the safe range");
  }
  const selected = selectedDailyNotes(environment, input.paths ?? []);
  if (!selected.ok) {
    return selected;
  }
  const cursor = normalizeCursor(environment, input.cursor);
  if (!cursor.ok) {
    return cursor as Result<DailyTriageResult>;
  }
  const afterCursor = selected.value.filter((item) => !cursor.value || compareVaultPaths(item.path, cursor.value) > 0);
  const page = afterCursor.slice(0, limit);
  const hasMore = afterCursor.length > page.length;
  const changed = input.archiveCheck ? changedVaultPaths(environment.vaultPath) : new Set<string>();
  const items = page.map((note) => ({
    path: note.path,
    fragments: note.fragments,
    archive: archiveReadiness(environment, note, Boolean(input.archiveCheck), changed),
  }));
  const readyItems = items.filter((item) => item.archive.requested && item.archive.ready);
  const changeInput = input.archiveCheck && items.length > 0 && readyItems.length === items.length
    ? {
        summary: "Archive daily notes after reviewed extraction",
        moves: readyItems.map((item) => ({ from: item.path, to: item.archive.path })),
      }
    : null;
  const value: DailyTriageResult = {
    items,
    nextCursor: hasMore ? page[page.length - 1]?.path ?? null : null,
    changeInput,
  };
  if (serializedByteLength(value) > MAX_DAILY_TRIAGE_RESULT_BYTES) {
    return fail("daily-triage-output-too-large", "daily triage result exceeds the reviewable output limit");
  }
  return {
    ok: true,
    value,
  };
}

function selectedDailyNotes(
  environment: VaultEnvironment,
  requestedPaths: string[],
): Result<ParsedDailyNote[]> {
  const selectedPaths = requestedPaths.length === 0 ? [DAILY_NOTES_ROOT] : requestedPaths;
  const normalized = new Set<string>();
  for (const requestedPath of selectedPaths) {
    const classified = classifyVaultPath({
      vaultPath: environment.vaultPath,
      input: requestedPath,
      privateGlobs: environment.privateGlobs,
    });
    if (!classified.ok) {
      return fail("daily-triage-path-invalid", "daily triage path is not eligible");
    }
    if (requestedPaths.length > 0 && !isDirectDailyNotePath(classified.value.normalizedRelativePath)) {
      return fail("daily-triage-path-invalid", "daily triage paths must be daily notes");
    }
    normalized.add(classified.value.normalizedRelativePath);
  }

  let scan;
  try {
    scan = scanVaultEntries({
      vaultPath: environment.vaultPath,
      privateGlobs: environment.privateGlobs,
      selectedPaths: [...normalized],
    });
  } catch {
    return fail("daily-triage-scan-failed", "daily notes could not be inspected");
  }
  const notes = scan.files
    .filter((entry) => entry.kind === "note" && isDirectDailyNotePath(entry.relativePath))
    .sort((left, right) => compareVaultPaths(left.relativePath, right.relativePath));
  if (requestedPaths.length > 0 && notes.length !== normalized.size) {
    return fail("daily-triage-path-invalid", "one or more daily notes could not be read");
  }
  const parsed: ParsedDailyNote[] = [];
  for (const note of notes) {
    let content: Buffer | undefined;
    try {
      content = readVaultRegularFile(environment.vaultPath, note.relativePath);
    } catch {
      return fail("daily-triage-scan-failed", "daily notes could not be inspected");
    }
    if (!content) {
      return fail("daily-triage-scan-failed", "daily notes changed during inspection");
    }
    parsed.push({
      path: note.relativePath,
      fragments: parseFragments(note.relativePath, content.toString("utf8"), new Set(environment.approvedTags)),
    });
  }
  return { ok: true, value: parsed };
}

function normalizeCursor(environment: VaultEnvironment, cursor: string | undefined): Result<string> {
  if (!cursor) {
    return { ok: true, value: "" };
  }
  const classified = classifyVaultPath({
    vaultPath: environment.vaultPath,
    input: cursor,
    privateGlobs: environment.privateGlobs,
  });
  if (!classified.ok || !isDirectDailyNotePath(classified.value.normalizedRelativePath)) {
    return fail("daily-triage-cursor-invalid", "daily triage cursor is not eligible");
  }
  return { ok: true, value: classified.value.normalizedRelativePath };
}

function parseFragments(sourcePath: string, text: string, approvedTags: Set<string>): DailyTriageFragment[] {
  const lines = text.split(/\r?\n/);
  const starts: Array<{ index: number; kind: DailyTriageFragment["kind"]; title: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(FRAGMENT_HEADING);
    if (!match) {
      continue;
    }
    starts.push({
      index,
      kind: match[1].toLocaleLowerCase() as DailyTriageFragment["kind"],
      title: match[2].trim(),
    });
  }
  return starts.map((start, position) => {
    const end = starts[position + 1]?.index ?? lines.length;
    const body = lines.slice(start.index + 1, end).join("\n").trim();
    const tags = extractCandidateTags(body);
    return {
      kind: start.kind,
      title: start.title,
      sourcePath,
      sourceExcerpt: excerpt(body),
      suggestedDestination: fragmentDestination(start.kind, start.title),
      approvedTags: tags.filter((tag) => approvedTags.has(tag)),
      proposedTags: tags.filter((tag) => !approvedTags.has(tag)),
    };
  });
}

function archiveReadiness(
  environment: VaultEnvironment,
  note: ParsedDailyNote,
  requested: boolean,
  changedPaths: Set<string>,
): { requested: boolean; path: string; ready: boolean; blockers: string[] } {
  const archivePath = `99-archive/daily-notes/${path.posix.basename(note.path)}`;
  if (!requested) {
    return { requested: false, path: archivePath, ready: false, blockers: [] };
  }
  const blockers: string[] = [];
  if (note.fragments.length === 0) {
    blockers.push("daily note has no extractable fragments");
  } else if (!note.fragments.every((fragment) => changedPaths.has(fragment.suggestedDestination))) {
    blockers.push("extracted destinations are not visible in Git status or diff");
  }
  const destination = classifyVaultPath({
    vaultPath: environment.vaultPath,
    input: archivePath,
    privateGlobs: environment.privateGlobs,
  });
  if (!destination.ok) {
    blockers.push("archive destination is not eligible");
  } else {
    try {
      if (readVaultRegularFile(environment.vaultPath, destination.value.normalizedRelativePath) !== undefined) {
        blockers.push("archive destination already exists");
      }
    } catch {
      blockers.push("archive destination could not be inspected");
    }
  }
  return { requested: true, path: archivePath, ready: blockers.length === 0, blockers };
}

function changedVaultPaths(vaultPath: string): Set<string> {
  const changed = new Set<string>();
  for (const args of [["diff", "--name-only", "HEAD", "--"], ["ls-files", "--others", "--exclude-standard", "--"]]) {
    const result = spawnSync("git", ["-C", vaultPath, ...args], { encoding: "utf8" });
    if (result.status !== 0) {
      continue;
    }
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.trim()) {
        changed.add(line.trim());
      }
    }
  }
  return changed;
}

function extractCandidateTags(body: string): string[] {
  const tags = new Set<string>();
  for (const match of body.matchAll(HASHTAG)) {
    tags.add(match[1].toLocaleLowerCase());
  }
  for (const match of body.matchAll(TAGS_LINE)) {
    for (const value of match[1].split(/[,#\s]+/)) {
      if (value.trim()) {
        tags.add(value.trim().toLocaleLowerCase());
      }
    }
  }
  return [...tags].sort();
}

function fragmentDestination(kind: DailyTriageFragment["kind"], title: string): string {
  if (kind === "source") {
    return `03-sources/${slugify(title)}.md`;
  }
  if (kind === "knowledge" || kind === "area") {
    return classifiedDestination("02-knowledge", title);
  }
  if (kind === "project") {
    return classifiedDestination("01-projects", title);
  }
  return classifiedDestination("04-people", title);
}

function classifiedDestination(root: string, title: string): string {
  const parts = title.split("/").map(slugify).filter(Boolean);
  const main = parts.length >= 2 ? parts[0] : "uncategorized";
  const sub = parts.length >= 3 ? parts[1] : "general";
  const name = parts.length >= 3
    ? parts.slice(2).join("-")
    : parts[parts.length - 1] ?? "untitled";
  return `${root}/${main}/${sub}/${name}.md`;
}

function slugify(value: string): string {
  const normalized = value.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
  return normalized || "untitled";
}

function excerpt(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 180 ? `${compact.slice(0, 180)}...` : compact;
}

function isDirectDailyNotePath(relativePath: string): boolean {
  return path.posix.dirname(relativePath) === DAILY_NOTES_ROOT
    && relativePath.toLocaleLowerCase().endsWith(".md");
}

function serializedByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function fail<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message } };
}
