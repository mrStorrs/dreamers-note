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
  writeTombstone,
} from "./index-db";
import type { RebuildVaultIndexOptions, RebuildVaultIndexResult, RefreshVaultIndexResult, Tombstone } from "./index-search";
import { parseMarkdownNote, ParsedMarkdownNote } from "./markdown";

interface EmbeddingSession {
  state: "disabled" | "ready" | "unavailable";
  policyHash: string;
  lastError?: string;
  config?: RebuildVaultIndexOptions["embeddingConfig"];
}

export function rebuildVaultIndexState(options: RebuildVaultIndexOptions) {
  return withStructuredErrors("index-rebuild-failed", () => {
    const db = openIndexDatabase(options.databasePath);
    try {
      const scan = scanVaultEntries(options);
      const warnings: RebuildVaultIndexResult["warnings"] = [];
      const embeddingSession = createEmbeddingSession(options);
      const knownNotePaths = scan.files.filter((file) => file.kind === "note").map((file) => file.relativePath);
      const knownAssetPaths = scan.files.filter((file) => file.kind === "asset").map((file) => file.relativePath);
      db.transaction(() => {
        clearIndex(db);
        writeMeta(db, options);
        writeEmbeddingMeta(db, embeddingSession);
        for (const exclusion of scan.exclusions) {
          upsertExclusion(db, exclusion);
        }
        for (const file of scan.files) {
          indexEntry(db, file, options.approvedTags ?? [], knownNotePaths, knownAssetPaths, warnings, embeddingSession);
        }
        writeEmbeddingMeta(db, embeddingSession);
        recordOperation(db, "rebuild", `${scan.files.length} indexed, ${scan.exclusions.length} excluded`);
      })();
      return {
        indexedFiles: scan.files.map((file) => ({
          relativePath: file.relativePath,
          kind: file.kind,
          hash: file.hash,
        })),
        excludedFiles: scan.exclusions,
        warnings: warnings.sort(compareWarnings),
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
    try {
      const previousFiles = readStoredFiles(db);
      const previousByPath = new Map(previousFiles.map((file) => [file.relative_path, file]));
      const scan = scanVaultEntries(options);
      const embeddingSession = createEmbeddingSession(options);
      const currentByPath = new Map(scan.files.map((file) => [file.relativePath, file]));
      const currentExclusionPaths = new Set(scan.exclusions.map((file) => file.relativePath));
      const previousDeleted = previousFiles.filter((file) => !currentByPath.has(file.relative_path));
      const newFiles = scan.files.filter((file) => !previousByPath.has(file.relativePath));
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
      const changedPaths = scan.files
        .filter((file) => {
          const previous = previousByPath.get(file.relativePath);
          return !previous || previous.hash !== file.hash || renamedNewPaths.has(file.relativePath);
        })
        .map((file) => file.relativePath)
        .sort(compareVaultPaths);
      const changedPathSet = new Set(changedPaths);
      const warnings: RebuildVaultIndexResult["warnings"] = [];
      const tombstones: Tombstone[] = [];
      const knownNotePaths = scan.files.filter((file) => file.kind === "note").map((file) => file.relativePath);
      const knownAssetPaths = scan.files.filter((file) => file.kind === "asset").map((file) => file.relativePath);
      const shouldRefreshAllNotes = graphResolutionNeedsRefresh(previousFiles, scan.files);
      const shouldRefreshAllEmbeddings = embeddingRefreshRequired(db, embeddingSession);
      const shouldReindexAllNotes = shouldRefreshAllNotes || shouldRefreshAllEmbeddings;

      db.transaction(() => {
        writeMeta(db, options);
        writeEmbeddingMeta(db, embeddingSession);
        clearExclusions(db);
        for (const exclusion of scan.exclusions) {
          upsertExclusion(db, exclusion);
        }
        for (const deletedPath of deletedPaths) {
          const previous = previousByPath.get(deletedPath);
          purgeIndexedPath(db, deletedPath);
          tombstones.push(writeTombstone(db, deletedPath, "deleted", previous?.hash));
        }
        for (const excludedPath of excludedPaths) {
          const previous = previousByPath.get(excludedPath);
          purgeIndexedPath(db, excludedPath);
          tombstones.push(writeTombstone(db, excludedPath, "excluded", previous?.hash));
        }
        for (const match of renameMatches) {
          const previous = previousByPath.get(match.oldPath);
          purgeIndexedPath(db, match.oldPath);
          tombstones.push(writeTombstone(db, match.oldPath, "renamed", previous?.hash, match.newPath));
        }
        for (const file of scan.files) {
          if (changedPathSet.has(file.relativePath) || (shouldReindexAllNotes && file.kind === "note")) {
            purgeIndexedPath(db, file.relativePath);
            indexEntry(db, file, options.approvedTags ?? [], knownNotePaths, knownAssetPaths, warnings, embeddingSession);
          }
        }
        writeEmbeddingMeta(db, embeddingSession);
        recordOperation(db, "refresh", `${changedPaths.length} updated, ${deletedPaths.length} deleted`);
      })();

      return {
        indexedFiles: scan.files.map((file) => ({
          relativePath: file.relativePath,
          kind: file.kind,
          hash: file.hash,
        })),
        excludedFiles: scan.exclusions,
        warnings: warnings.sort(compareWarnings),
        updatedPaths: changedPaths,
        deletedPaths,
        excludedPaths,
        tombstones: tombstones.sort((left, right) => compareVaultPaths(left.relativePath, right.relativePath)),
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
  const previousProvider = readMeta(db, "embedding_provider") ?? "";
  const previousModelName = readMeta(db, "embedding_model_name") ?? "";
  const previousModelVersion = readMeta(db, "embedding_model_version") ?? "";
  const previousDimensions = readMeta(db, "embedding_dimensions") ?? "0";
  const previousPolicyHash = readMeta(db, "embedding_policy_hash") ?? "";
  return previousProvider !== (embeddingSession.config?.provider ?? "")
    || previousModelName !== (embeddingSession.config?.model ?? "")
    || previousModelVersion !== (embeddingSession.config?.modelVersion ?? "")
    || previousDimensions !== String(embeddingSession.config?.dimensions ?? 0)
    || previousPolicyHash !== embeddingSession.policyHash;
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

function compareWarnings(
  left: { relativePath: string; code: string },
  right: { relativePath: string; code: string },
): number {
  return compareVaultPaths(left.relativePath, right.relativePath) || left.code.localeCompare(right.code);
}
