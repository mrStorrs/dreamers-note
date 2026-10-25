import crypto from "crypto";
import fs from "fs";
import path from "path";
import { compareVaultPaths, isAssetPath, scanVaultEntries, VaultEntry } from "./files";
import {
  clearExclusions,
  clearIndex,
  openIndexDatabase,
  purgeIndexedPath,
  readStoredFiles,
  secureRuntimeFiles,
  SqliteDatabase,
  upsertExclusion,
  withStructuredErrors,
  writeMeta,
  writeMetaValue,
  writeTombstone,
} from "./index-db";
import type { RebuildVaultIndexOptions, RebuildVaultIndexResult, RefreshVaultIndexResult, Tombstone } from "./index-contracts";
import { ensureIndexStorage } from "./index-schema";
import { parseMarkdownNote, ParsedMarkdownNote } from "./markdown";

interface IndexRunContext {
  scan: ReturnType<typeof scanVaultEntries>;
  warnings: RebuildVaultIndexResult["warnings"];
  knownNotePaths: string[];
  knownAssetPaths: string[];
}

interface IndexApplyPlan {
  mode: "rebuild" | "refresh";
  clearExistingIndex: boolean;
  updatedPaths: string[];
  deletedPaths: string[];
  excludedPaths: string[];
  renameMatches: Array<{ oldPath: string; newPath: string }>;
  previousByPath: Map<string, { relative_path: string; kind: "note" | "asset"; hash: string }>;
  shouldReindexAllNotes: boolean;
  tombstones: Tombstone[];
}

export function rebuildVaultIndexState(options: RebuildVaultIndexOptions) {
  return withStructuredErrors("index-rebuild-failed", () => {
    const db = openIndexDatabase(options.databasePath);
    ensureIndexStorage(db);
    try {
      const run = prepareIndexRun(options);
      applyIndexPlan(db, options, run, createRebuildPlan(run));
      return indexResult(run);
    } finally {
      db.close();
      secureRuntimeFiles(options.databasePath);
    }
  });
}

export function refreshVaultIndexState(options: RebuildVaultIndexOptions) {
  if (hasScopedSelection(options.selectedPaths)) {
    return {
      ok: false as const,
      error: { code: "index-refresh-unsupported-scope", message: "partial refresh with selected paths is not supported" },
    };
  }
  return withStructuredErrors("index-refresh-failed", () => {
    const db = openIndexDatabase(options.databasePath);
    ensureIndexStorage(db);
    try {
      const previousFiles = readStoredFiles(db);
      const run = prepareIndexRun(options);
      const plan = createRefreshPlan(run, previousFiles, graphResolutionNeedsRefresh(previousFiles, run.scan.files));
      applyIndexPlan(db, options, run, plan);
      return {
        ...indexResult(run),
        updatedPaths: plan.updatedPaths,
        deletedPaths: plan.deletedPaths,
        excludedPaths: plan.excludedPaths,
        tombstones: plan.tombstones.sort((left, right) => compareVaultPaths(left.relativePath, right.relativePath)),
      } as RefreshVaultIndexResult;
    } finally {
      db.close();
      secureRuntimeFiles(options.databasePath);
    }
  });
}

function indexResult(run: IndexRunContext): RebuildVaultIndexResult {
  return {
    indexedFiles: run.scan.files.map((file) => ({ relativePath: file.relativePath, kind: file.kind, hash: file.hash })),
    excludedFiles: run.scan.exclusions,
    warnings: run.warnings.sort(compareWarnings),
  };
}

function hasScopedSelection(selectedPaths?: string[]): boolean {
  return Boolean(selectedPaths?.length) && !(selectedPaths?.length === 1 && [".", "./"].includes(selectedPaths[0]));
}

function prepareIndexRun(options: RebuildVaultIndexOptions): IndexRunContext {
  const scan = scanVaultEntries(options);
  return {
    scan,
    warnings: [],
    knownNotePaths: scan.files.filter((file) => file.kind === "note").map((file) => file.relativePath),
    knownAssetPaths: scan.files.filter((file) => file.kind === "asset").map((file) => file.relativePath),
  };
}

function createRebuildPlan(run: IndexRunContext): IndexApplyPlan {
  return {
    mode: "rebuild",
    clearExistingIndex: true,
    updatedPaths: run.scan.files.map((file) => file.relativePath).sort(compareVaultPaths),
    deletedPaths: [],
    excludedPaths: [],
    renameMatches: [],
    previousByPath: new Map(),
    shouldReindexAllNotes: false,
    tombstones: [],
  };
}

function createRefreshPlan(
  run: IndexRunContext,
  previousFiles: Array<{ relative_path: string; kind: "note" | "asset"; hash: string }>,
  shouldReindexAllNotes: boolean,
): IndexApplyPlan {
  const previousByPath = new Map(previousFiles.map((file) => [file.relative_path, file]));
  const currentByPath = new Map(run.scan.files.map((file) => [file.relativePath, file]));
  const excludedPaths = new Set(run.scan.exclusions.map((item) => item.relativePath));
  const previouslyDeleted = previousFiles.filter((file) => !currentByPath.has(file.relative_path));
  const newFiles = run.scan.files.filter((file) => !previousByPath.has(file.relativePath));
  const renameMatches = matchRenames(previouslyDeleted, newFiles);
  const renamedOld = new Set(renameMatches.map((item) => item.oldPath));
  const renamedNew = new Set(renameMatches.map((item) => item.newPath));
  const deletedPaths = previouslyDeleted
    .filter((file) => !excludedPaths.has(file.relative_path) && !renamedOld.has(file.relative_path))
    .map((file) => file.relative_path)
    .sort(compareVaultPaths);
  const newlyExcluded = previouslyDeleted
    .filter((file) => excludedPaths.has(file.relative_path) && !renamedOld.has(file.relative_path))
    .map((file) => file.relative_path)
    .sort(compareVaultPaths);
  const updatedPaths = run.scan.files
    .filter((file) => !previousByPath.get(file.relativePath) || previousByPath.get(file.relativePath)?.hash !== file.hash || renamedNew.has(file.relativePath))
    .map((file) => file.relativePath)
    .sort(compareVaultPaths);
  return {
    mode: "refresh",
    clearExistingIndex: false,
    updatedPaths,
    deletedPaths,
    excludedPaths: newlyExcluded,
    renameMatches,
    previousByPath,
    shouldReindexAllNotes,
    tombstones: [],
  };
}

function applyIndexPlan(db: SqliteDatabase, options: RebuildVaultIndexOptions, run: IndexRunContext, plan: IndexApplyPlan): void {
  const updated = new Set(plan.updatedPaths);
  db.transaction(() => {
    if (plan.clearExistingIndex) clearIndex(db);
    else clearExclusions(db);
    writeMeta(db, options);
    writeMetaValue(db, "index_generation", indexGenerationForScan(run.scan.files, run.scan.exclusions));
    for (const exclusion of run.scan.exclusions) upsertExclusion(db, exclusion);
    applyRemovedPaths(db, plan);
    for (const file of run.scan.files) {
      if (plan.mode === "rebuild" || updated.has(file.relativePath) || (plan.shouldReindexAllNotes && file.kind === "note")) {
        if (plan.mode !== "rebuild") purgeIndexedPath(db, file.relativePath);
        indexEntry(db, file, options.approvedTags ?? [], run.knownNotePaths, run.knownAssetPaths, run.warnings);
      }
    }
  })();
}

function applyRemovedPaths(db: SqliteDatabase, plan: IndexApplyPlan): void {
  for (const path of plan.deletedPaths) {
    const previous = plan.previousByPath.get(path);
    purgeIndexedPath(db, path);
    plan.tombstones.push(writeTombstone(db, path, "deleted", previous?.hash));
  }
  for (const path of plan.excludedPaths) {
    const previous = plan.previousByPath.get(path);
    purgeIndexedPath(db, path);
    plan.tombstones.push(writeTombstone(db, path, "excluded", previous?.hash));
  }
  for (const move of plan.renameMatches) {
    const previous = plan.previousByPath.get(move.oldPath);
    purgeIndexedPath(db, move.oldPath);
    plan.tombstones.push(writeTombstone(db, move.oldPath, "renamed", previous?.hash, move.newPath));
  }
}

function indexEntry(
  db: SqliteDatabase,
  file: VaultEntry,
  approvedTags: Set<string> | string[],
  knownNotePaths: string[],
  knownAssetPaths: string[],
  warnings: RebuildVaultIndexResult["warnings"],
): void {
  db.prepare("insert or replace into files (relative_path, kind, hash, size, mtime_ms, indexed_at) values (?, ?, ?, ?, ?, ?)")
    .run(file.relativePath, file.kind, file.hash, file.size, file.mtimeMs, new Date(0).toISOString());
  if (isAssetPath(file.relativePath)) {
    db.prepare("insert or replace into assets (relative_path, filename, extension, hash, size) values (?, ?, ?, ?, ?)")
      .run(file.relativePath, path.posix.basename(file.relativePath), path.posix.extname(file.relativePath).replace(/^\./, ""), file.hash, file.size);
    return;
  }
  const parsed = parseMarkdownNote({
    relativePath: file.relativePath,
    text: fs.readFileSync(file.absolutePath, "utf8"),
    approvedTags,
    knownNotePaths,
    knownAssetPaths,
  });
  indexParsedNote(db, file, parsed, warnings);
}

function indexParsedNote(db: SqliteDatabase, file: VaultEntry, parsed: ParsedMarkdownNote, warnings: RebuildVaultIndexResult["warnings"]): void {
  db.prepare("insert or replace into notes (relative_path, title, approved_tags, unapproved_tags) values (?, ?, ?, ?)")
    .run(file.relativePath, parsed.title, JSON.stringify(parsed.approvedTags), JSON.stringify(parsed.unapprovedTagCandidates));
  const heading = db.prepare("insert into headings (relative_path, heading_path, level, text, line) values (?, ?, ?, ?, ?)");
  for (const item of parsed.headingPaths) heading.run(file.relativePath, item.path, item.level, item.text, item.line);
  const chunk = db.prepare("insert into chunks (chunk_id, relative_path, heading_path, ordinal, text) values (?, ?, ?, ?, ?)");
  const fts = db.prepare("insert into chunks_fts (chunk_id, relative_path, title, heading_path, tags, text) values (?, ?, ?, ?, ?, ?)");
  parsed.chunks.forEach((item, ordinal) => {
    const id = `${file.relativePath}#${item.id}`;
    chunk.run(id, file.relativePath, item.headingPath, ordinal, item.text);
    fts.run(id, file.relativePath, parsed.title, item.headingPath, parsed.approvedTags.join(" "), item.text);
  });
  const edge = db.prepare("insert into graph_edges (relative_path, kind, raw_target, target_path, target_heading, alias, resolved, is_embed) values (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const item of parsed.links) edge.run(file.relativePath, item.kind, item.rawTarget, item.targetPath ?? null, item.targetHeading ?? null, item.alias ?? null, item.resolved ? 1 : 0, item.isEmbed ? 1 : 0);
  const asset = db.prepare("insert into asset_references (relative_path, target, resolved_target_path, is_embed) values (?, ?, ?, ?)");
  for (const item of parsed.assetReferences) asset.run(file.relativePath, item.target, item.resolvedTargetPath ?? null, item.isEmbed ? 1 : 0);
  const warning = db.prepare("insert into parse_warnings (relative_path, code, message) values (?, ?, ?)");
  for (const item of parsed.warnings) {
    warning.run(file.relativePath, item.code, item.message);
    warnings.push({ relativePath: file.relativePath, code: item.code, message: item.message });
  }
}

function matchRenames(previousDeleted: Array<{ relative_path: string; kind: "note" | "asset"; hash: string }>, newFiles: VaultEntry[]) {
  const unmatched = new Set(newFiles.map((file) => file.relativePath));
  const matches: Array<{ oldPath: string; newPath: string }> = [];
  for (const oldFile of [...previousDeleted].sort((left, right) => compareVaultPaths(left.relative_path, right.relative_path))) {
    const match = newFiles.filter((file) => unmatched.has(file.relativePath)).sort((left, right) => compareVaultPaths(left.relativePath, right.relativePath))
      .find((file) => file.hash === oldFile.hash && file.kind === oldFile.kind);
    if (match) {
      unmatched.delete(match.relativePath);
      matches.push({ oldPath: oldFile.relative_path, newPath: match.relativePath });
    }
  }
  return matches;
}

function graphResolutionNeedsRefresh(previousFiles: Array<{ relative_path: string; kind: "note" | "asset" }>, currentFiles: VaultEntry[]): boolean {
  const previous = previousFiles.filter((file) => file.kind === "note").map((file) => file.relative_path).sort(compareVaultPaths);
  const current = currentFiles.filter((file) => file.kind === "note").map((file) => file.relativePath).sort(compareVaultPaths);
  return JSON.stringify(previous) !== JSON.stringify(current);
}

function indexGenerationForScan(files: VaultEntry[], exclusions: Array<{ relativePath: string; reason: string }>): string {
  return crypto.createHash("sha256").update(JSON.stringify({
    files: files.map((file) => ({ path: file.relativePath, hash: file.hash, kind: file.kind })),
    exclusions: exclusions.map((item) => ({ path: item.relativePath, reason: item.reason })),
  })).digest("hex");
}

function compareWarnings(left: { relativePath: string; code: string }, right: { relativePath: string; code: string }): number {
  return compareVaultPaths(left.relativePath, right.relativePath) || left.code.localeCompare(right.code);
}
