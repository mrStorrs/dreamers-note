import crypto from "crypto";
import fs from "fs";
import path from "path";
import { chunkContentHash, embedTexts, embeddingPolicyHash, serializeEmbedding } from "./embeddings";
import { compareVaultPaths, isAssetPath, scanVaultEntries, VaultEntry } from "./files";
import {
  clearExclusions,
  clearIndex,
  openIndexDatabase,
  purgeIndexedPath,
  readMeta,
  readStoredFiles,
  recordOperation,
  secureRuntimeFiles,
  SqliteDatabase,
  upsertExclusion,
  withStructuredErrors,
  writeMeta,
  writeMetaValue,
  writeTombstone,
} from "./index-db";
import { ensureIndexStorage } from "./index-schema";
import type { RebuildVaultIndexOptions, RebuildVaultIndexResult, RefreshVaultIndexResult, Tombstone } from "./index-contracts";
import { parseMarkdownNote, ParsedMarkdownNote } from "./markdown";

interface EmbeddingSession {
  state: "disabled" | "ready" | "unavailable";
  policyHash: string;
  lastError?: string;
  config?: RebuildVaultIndexOptions["embeddingConfig"];
}

interface IndexRunContext {
  scan: ReturnType<typeof scanVaultEntries>;
  warnings: RebuildVaultIndexResult["warnings"];
  embeddingSession: EmbeddingSession;
  knownNotePaths: string[];
  knownAssetPaths: string[];
}

interface IndexApplyPlan {
  mode: "rebuild" | "refresh";
  operationDetail: string;
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
      return {
        indexedFiles: run.scan.files.map((file) => ({
          relativePath: file.relativePath,
          kind: file.kind,
          hash: file.hash,
        })),
        excludedFiles: run.scan.exclusions,
        warnings: run.warnings.sort(compareWarnings),
      };
    } finally {
      db.close();
      secureRuntimeFiles(options.databasePath);
    }
  });
}

export function refreshVaultIndexState(options: RebuildVaultIndexOptions) {
  if (hasScopedSelection(options.selectedPaths)) {
    return {
      ok: false,
      error: {
        code: "index-refresh-unsupported-scope",
        message: "partial refresh with selectedPaths is not implemented safely yet",
      },
    } as const;
  }
  return withStructuredErrors("index-refresh-failed", () => {
    const db = openIndexDatabase(options.databasePath);
    ensureIndexStorage(db);
    try {
      const previousFiles = readStoredFiles(db);
      const run = prepareIndexRun(options);
      const shouldRefreshAllNotes = graphResolutionNeedsRefresh(previousFiles, run.scan.files);
      const shouldRefreshAllEmbeddings = embeddingRefreshRequired(db, run.embeddingSession);
      const plan = createRefreshPlan(run, previousFiles, shouldRefreshAllNotes || shouldRefreshAllEmbeddings);
      applyIndexPlan(db, options, run, plan);

      return {
        indexedFiles: run.scan.files.map((file) => ({
          relativePath: file.relativePath,
          kind: file.kind,
          hash: file.hash,
        })),
        excludedFiles: run.scan.exclusions,
        warnings: run.warnings.sort(compareWarnings),
        updatedPaths: plan.updatedPaths,
        deletedPaths: plan.deletedPaths,
        excludedPaths: plan.excludedPaths,
        tombstones: plan.tombstones.sort((left, right) => compareVaultPaths(left.relativePath, right.relativePath)),
      };
    } finally {
      db.close();
      secureRuntimeFiles(options.databasePath);
    }
  });
}

function hasScopedSelection(selectedPaths?: string[]): boolean {
  if (!selectedPaths || selectedPaths.length === 0) {
    return false;
  }
  return !(selectedPaths.length === 1 && (selectedPaths[0] === "." || selectedPaths[0] === "./"));
}

function prepareIndexRun(options: RebuildVaultIndexOptions): IndexRunContext {
  const scan = scanVaultEntries(options);
  return {
    scan,
    warnings: [],
    embeddingSession: createEmbeddingSession(options),
    knownNotePaths: scan.files.filter((file) => file.kind === "note").map((file) => file.relativePath),
    knownAssetPaths: scan.files.filter((file) => file.kind === "asset").map((file) => file.relativePath),
  };
}

function createRebuildPlan(run: IndexRunContext): IndexApplyPlan {
  return {
    mode: "rebuild",
    operationDetail: `${run.scan.files.length} indexed, ${run.scan.exclusions.length} excluded`,
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
  const currentExclusionPaths = new Set(run.scan.exclusions.map((file) => file.relativePath));
  const previousDeleted = previousFiles.filter((file) => !currentByPath.has(file.relative_path));
  const newFiles = run.scan.files.filter((file) => !previousByPath.has(file.relativePath));
  const renameMatches = matchRenames(previousDeleted, newFiles);
  const renamedOldPaths = new Set(renameMatches.map((match) => match.oldPath));
  const renamedNewPaths = new Set(renameMatches.map((match) => match.newPath));
  const deletedPaths = previousDeleted
    .filter((file) => !currentExclusionPaths.has(file.relative_path) && !renamedOldPaths.has(file.relative_path))
    .map((file) => file.relative_path)
    .sort(compareVaultPaths);
  const excludedPaths = previousDeleted
    .filter((file) => currentExclusionPaths.has(file.relative_path) && !renamedOldPaths.has(file.relative_path))
    .map((file) => file.relative_path)
    .sort(compareVaultPaths);
  const updatedPaths = run.scan.files
    .filter((file) => {
      const previous = previousByPath.get(file.relativePath);
      return !previous || previous.hash !== file.hash || renamedNewPaths.has(file.relativePath);
    })
    .map((file) => file.relativePath)
    .sort(compareVaultPaths);

  return {
    mode: "refresh",
    operationDetail: `${updatedPaths.length} updated, ${deletedPaths.length} deleted`,
    clearExistingIndex: false,
    updatedPaths,
    deletedPaths,
    excludedPaths,
    renameMatches,
    previousByPath,
    shouldReindexAllNotes,
    tombstones: [],
  };
}

function applyIndexPlan(
  db: SqliteDatabase,
  options: RebuildVaultIndexOptions,
  run: IndexRunContext,
  plan: IndexApplyPlan,
): void {
  const updatedPathSet = new Set(plan.updatedPaths);
  db.transaction(() => {
    if (plan.clearExistingIndex) {
      clearIndex(db);
    } else {
      clearExclusions(db);
    }
    writeMeta(db, options);
    writeMetaValue(db, "index_generation", indexGenerationForScan(run.scan.files, run.scan.exclusions));
    writeEmbeddingMeta(db, run.embeddingSession);
    for (const exclusion of run.scan.exclusions) {
      upsertExclusion(db, exclusion);
    }
    applyRemovedPaths(db, plan);
    for (const file of run.scan.files) {
      if (plan.mode === "rebuild" || updatedPathSet.has(file.relativePath) || (plan.shouldReindexAllNotes && file.kind === "note")) {
        if (plan.mode !== "rebuild") {
          purgeIndexedPath(db, file.relativePath);
        }
        indexEntry(db, file, options.approvedTags ?? [], run.knownNotePaths, run.knownAssetPaths, run.warnings, run.embeddingSession);
      }
    }
    writeEmbeddingMeta(db, run.embeddingSession);
    recordOperation(db, plan.mode, plan.operationDetail);
  })();
}

function applyRemovedPaths(db: SqliteDatabase, plan: IndexApplyPlan): void {
  for (const deletedPath of plan.deletedPaths) {
    const previous = plan.previousByPath.get(deletedPath);
    purgeIndexedPath(db, deletedPath);
    plan.tombstones.push(writeTombstone(db, deletedPath, "deleted", previous?.hash));
  }
  for (const excludedPath of plan.excludedPaths) {
    const previous = plan.previousByPath.get(excludedPath);
    purgeIndexedPath(db, excludedPath);
    plan.tombstones.push(writeTombstone(db, excludedPath, "excluded", previous?.hash));
  }
  for (const match of plan.renameMatches) {
    const previous = plan.previousByPath.get(match.oldPath);
    purgeIndexedPath(db, match.oldPath);
    plan.tombstones.push(writeTombstone(db, match.oldPath, "renamed", previous?.hash, match.newPath));
  }
}

function indexEntry(
  db: SqliteDatabase,
  file: VaultEntry,
  approvedTags: Set<string> | string[],
  knownNotePaths: string[],
  knownAssetPaths: string[],
  warnings: RebuildVaultIndexResult["warnings"],
  embeddingSession: EmbeddingSession,
): void {
  db.prepare(
    [
      "insert or replace into files",
      "(relative_path, kind, hash, size, mtime_ms, indexed_at)",
      "values (?, ?, ?, ?, ?, ?)",
    ].join(" "),
  ).run(file.relativePath, file.kind, file.hash, file.size, file.mtimeMs, new Date(0).toISOString());

  if (isAssetPath(file.relativePath)) {
    db.prepare(
      "insert or replace into assets (relative_path, filename, extension, hash, size) values (?, ?, ?, ?, ?)",
    ).run(
      file.relativePath,
      path.posix.basename(file.relativePath),
      path.posix.extname(file.relativePath).replace(/^\./, ""),
      file.hash,
      file.size,
    );
    return;
  }

  const parsed = parseMarkdownNote({
    relativePath: file.relativePath,
    text: fs.readFileSync(file.absolutePath, "utf8"),
    approvedTags,
    knownNotePaths,
    knownAssetPaths,
  });
  indexParsedNote(db, file, parsed, warnings, embeddingSession);
}

function indexParsedNote(
  db: SqliteDatabase,
  file: VaultEntry,
  parsed: ParsedMarkdownNote,
  warnings: RebuildVaultIndexResult["warnings"],
  embeddingSession: EmbeddingSession,
): void {
  db.prepare(
    "insert or replace into notes (relative_path, title, approved_tags, unapproved_tags) values (?, ?, ?, ?)",
  ).run(file.relativePath, parsed.title, JSON.stringify(parsed.approvedTags), JSON.stringify(parsed.unapprovedTagCandidates));

  const headingStatement = db.prepare(
    "insert into headings (relative_path, heading_path, level, text, line) values (?, ?, ?, ?, ?)",
  );
  for (const heading of parsed.headingPaths) {
    headingStatement.run(file.relativePath, heading.path, heading.level, heading.text, heading.line);
  }

  const chunkStatement = db.prepare(
    "insert into chunks (chunk_id, relative_path, heading_path, ordinal, text) values (?, ?, ?, ?, ?)",
  );
  const ftsStatement = db.prepare(
    "insert into chunks_fts (chunk_id, relative_path, title, heading_path, tags, text) values (?, ?, ?, ?, ?, ?)",
  );
  parsed.chunks.forEach((chunk, index) => {
    const chunkId = `${file.relativePath}#${chunk.id}`;
    chunkStatement.run(chunkId, file.relativePath, chunk.headingPath, index, chunk.text);
    ftsStatement.run(chunkId, file.relativePath, parsed.title, chunk.headingPath, parsed.approvedTags.join(" "), chunk.text);
  });
  writeChunkEmbeddings(db, file, parsed, embeddingSession);

  const edgeStatement = db.prepare(
    [
      "insert into graph_edges",
      "(relative_path, kind, raw_target, target_path, target_heading, alias, resolved, is_embed)",
      "values (?, ?, ?, ?, ?, ?, ?, ?)",
    ].join(" "),
  );
  for (const link of parsed.links) {
    edgeStatement.run(
      file.relativePath,
      link.kind,
      link.rawTarget,
      link.targetPath ?? null,
      link.targetHeading ?? null,
      link.alias ?? null,
      link.resolved ? 1 : 0,
      link.isEmbed ? 1 : 0,
    );
  }

  const assetReferenceStatement = db.prepare(
    "insert into asset_references (relative_path, target, resolved_target_path, is_embed) values (?, ?, ?, ?)",
  );
  for (const asset of parsed.assetReferences) {
    assetReferenceStatement.run(file.relativePath, asset.target, asset.resolvedTargetPath ?? null, asset.isEmbed ? 1 : 0);
  }

  const warningStatement = db.prepare(
    "insert into parse_warnings (relative_path, code, message) values (?, ?, ?)",
  );
  for (const warning of parsed.warnings) {
    warningStatement.run(file.relativePath, warning.code, warning.message);
    warnings.push({
      relativePath: file.relativePath,
      code: warning.code,
      message: warning.message,
    });
  }
}

function createEmbeddingSession(options: RebuildVaultIndexOptions): EmbeddingSession {
  if (!options.embeddingConfig || !options.embeddingConfig.enabled) {
    return {
      state: "disabled",
      policyHash: embeddingPolicyHash(options.privateGlobs ?? []),
    };
  }
  return {
    state: "ready",
    config: options.embeddingConfig,
    policyHash: embeddingPolicyHash(options.privateGlobs ?? []),
  };
}

function embeddingRefreshRequired(db: SqliteDatabase, embeddingSession: EmbeddingSession): boolean {
  if (!embeddingSession.config || embeddingSession.state === "disabled") {
    return false;
  }
  const previousProvider = readMeta(db, "embedding_provider") ?? "";
  const previousModelName = readMeta(db, "embedding_model_name") ?? "";
  const previousModelVersion = readMeta(db, "embedding_model_version") ?? "";
  const previousDimensions = readMeta(db, "embedding_dimensions") ?? "0";
  const previousPolicyHash = readMeta(db, "embedding_policy_hash") ?? "";
  const previousState = readMeta(db, "embedding_state") ?? "";
  if (
    previousProvider !== embeddingSession.config.provider
    || previousModelName !== embeddingSession.config.model
    || previousModelVersion !== embeddingSession.config.modelVersion
    || previousDimensions !== String(embeddingSession.config.dimensions)
    || previousPolicyHash !== embeddingSession.policyHash
  ) {
    return true;
  }
  if (previousState === "unavailable") {
    return true;
  }
  const chunkCount = countTable(db, "chunks");
  if (chunkCount === 0) {
    return false;
  }
  if (!tableExists(db, "chunk_embeddings")) {
    return true;
  }
  return countTable(db, "chunk_embeddings") < chunkCount;
}

function writeChunkEmbeddings(
  db: SqliteDatabase,
  file: VaultEntry,
  parsed: ParsedMarkdownNote,
  embeddingSession: EmbeddingSession,
): void {
  if (!embeddingSession.config || embeddingSession.state === "disabled" || embeddingSession.state === "unavailable") {
    return;
  }
  if (parsed.chunks.length === 0) {
    return;
  }

  const embeddingInput = parsed.chunks.map((chunk) =>
    chunk.headingPath ? `${parsed.title}\n${chunk.headingPath}\n${chunk.text}` : `${parsed.title}\n${chunk.text}`);
  const embedded = embedTexts(embeddingSession.config, embeddingInput);
  if (!embedded.ok || embedded.value.dimensions !== embeddingSession.config.dimensions) {
    embeddingSession.state = "unavailable";
    embeddingSession.lastError = embedded.ok
      ? `expected ${embeddingSession.config.dimensions} dimensions but received ${embedded.value.dimensions}`
      : embedded.error.message;
    return;
  }

  const statement = db.prepare(
    [
      "insert or replace into chunk_embeddings",
      "(chunk_id, relative_path, content_hash, vector, dimensions, model_name, model_version, provider, policy_hash, indexed_at)",
      "values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ].join(" "),
  );
  parsed.chunks.forEach((chunk, index) => {
    statement.run(
      `${file.relativePath}#${chunk.id}`,
      file.relativePath,
      chunkContentHash(chunk.text),
      serializeEmbedding(embedded.value.vectors[index] ?? []),
      embedded.value.dimensions,
      embeddingSession.config?.model,
      embeddingSession.config?.modelVersion,
      embeddingSession.config?.provider,
      embeddingSession.policyHash,
      new Date(0).toISOString(),
    );
  });
}

function writeEmbeddingMeta(db: SqliteDatabase, embeddingSession: EmbeddingSession): void {
  const values = [
    ["embedding_state", embeddingSession.state],
    ["embedding_error", embeddingSession.lastError ?? ""],
    ["embedding_policy_hash", embeddingSession.policyHash],
    ["embedding_provider", embeddingSession.config?.provider ?? ""],
    ["embedding_model_name", embeddingSession.config?.model ?? ""],
    ["embedding_model_version", embeddingSession.config?.modelVersion ?? ""],
    ["embedding_dimensions", String(embeddingSession.config?.dimensions ?? 0)],
  ];
  const statement = db.prepare("insert or replace into meta (key, value) values (?, ?)");
  for (const [key, value] of values) {
    statement.run(key, value);
  }
}

function tableExists(db: SqliteDatabase, tableName: string): boolean {
  const row = db
    .prepare("select 1 as present from sqlite_schema where type = 'table' and name = ?")
    .get(tableName) as { present: number } | undefined;
  return Boolean(row?.present);
}

function countTable(db: SqliteDatabase, tableName: string): number {
  if (!tableExists(db, tableName)) {
    return 0;
  }
  const row = db.prepare(`select count(*) as count from ${tableName}`).get() as { count: number };
  return row.count;
}

function matchRenames(previousDeleted: Array<{ relative_path: string; kind: "note" | "asset"; hash: string }>, newFiles: VaultEntry[]) {
  const unmatchedNew = new Set(newFiles.map((file) => file.relativePath));
  const matches: Array<{ oldPath: string; newPath: string }> = [];
  for (const oldFile of previousDeleted.sort((left, right) => compareVaultPaths(left.relative_path, right.relative_path))) {
    const match = newFiles
      .filter((file) => unmatchedNew.has(file.relativePath))
      .sort((left, right) => compareVaultPaths(left.relativePath, right.relativePath))
      .find((file) => file.hash === oldFile.hash && file.kind === oldFile.kind);
    if (!match) {
      continue;
    }
    unmatchedNew.delete(match.relativePath);
    matches.push({
      oldPath: oldFile.relative_path,
      newPath: match.relativePath,
    });
  }
  return matches;
}

function graphResolutionNeedsRefresh(
  previousFiles: Array<{ relative_path: string; kind: "note" | "asset" }>,
  currentFiles: VaultEntry[],
): boolean {
  const previousNotePaths = previousFiles
    .filter((file) => file.kind === "note")
    .map((file) => file.relative_path)
    .sort(compareVaultPaths);
  const currentNotePaths = currentFiles
    .filter((file) => file.kind === "note")
    .map((file) => file.relativePath)
    .sort(compareVaultPaths);
  return JSON.stringify(previousNotePaths) !== JSON.stringify(currentNotePaths);
}

function indexGenerationForScan(
  files: VaultEntry[],
  exclusions: Array<{ relativePath: string; reason: string }>,
): string {
  return crypto.createHash("sha256").update(
    JSON.stringify({
      files: files.map((file) => ({
        path: file.relativePath,
        hash: file.hash,
        kind: file.kind,
      })),
      exclusions: exclusions.map((item) => ({
        path: item.relativePath,
        reason: item.reason,
      })),
    }),
  ).digest("hex");
}

function compareWarnings(
  left: { relativePath: string; code: string },
  right: { relativePath: string; code: string },
): number {
  return compareVaultPaths(left.relativePath, right.relativePath) || left.code.localeCompare(right.code);
}
