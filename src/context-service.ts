import fs from "fs";
import Database from "better-sqlite3";
import { fileHash, isAssetPath } from "./files";
import { buildEphemeralGraphContext, buildGraphContextPack } from "./graph-review";
import { inspectImportSource } from "./import-source";
import { searchVaultIndex } from "./index-search";
import { classifyVaultPath } from "./path-safety";
import { ensureRuntimeReady, type RuntimeReadiness } from "./runtime-readiness";
import type { Result, StructuredError } from "./types";
import type { VaultEnvironment } from "./vault-environment";

const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_READ_CHARS = 1_200;
const MAX_READ_CHARS = 12_000;
const DEFAULT_READ_LIMIT = 4;
const MAX_READ_LIMIT = 12;
const DEFAULT_RELATED_LIMIT = 8;
const MAX_RELATED_LIMIT = 30;

export interface ContextSearchInput {
  query: string;
  limit?: number;
}

export interface ContextSearchResult {
  readiness: RuntimeReadiness;
  query: string;
  limit: number;
  results: Array<{
    path: string;
    title: string;
    headingPath: string;
    chunkId: string;
    snippet: string;
    freshness: {
      state: "fresh" | "stale" | "unknown";
      reason?: string;
    };
    scoreComponents: {
      title: number;
      path: number;
      heading: number;
      tag: number;
      lexical: number;
      alias: number;
      backlink: number;
      recency: number;
    };
    whyMatched: string[];
  }>;
  truncated: boolean;
}

export interface ReadContextInput {
  path: string;
  heading?: string;
  maxChars?: number;
  limit?: number;
}

interface AdapterReadContextInput {
  path?: string;
  heading?: string;
  maxChars?: number;
  limit?: number;
  chunkId?: string;
}

export interface ReadContextResult {
  readiness: RuntimeReadiness;
  path: string;
  hash?: string;
  freshness: {
    state: "fresh" | "stale" | "unknown";
    reason?: string;
  };
  excerpts: Array<{
    chunkId: string;
    headingPath: string;
    line: number;
    text: string;
    trust: "untrusted";
  }>;
}

export interface InspectContextSourceInput {
  path: string;
  offset?: number;
  maxChars?: number;
}

export interface ContextSourceInspection {
  absolutePath: string;
  hash: string;
  size: number;
  offset: number;
  text: string;
  truncated: boolean;
  contentType: "text/markdown" | "text/plain";
  vaultRelativePath?: string;
}

export interface RelatedContextInput {
  path?: string;
  query?: string;
  limit?: number;
}

interface RelatedGraphResult {
  subject: {
    path: string;
    title: string;
  };
  groups: Record<string, { items: unknown[] }>;
}

export interface RelatedContextResult extends RelatedGraphResult {
  readiness: RuntimeReadiness;
}

interface IndexedExcerptRow {
  chunk_id: string;
  relative_path: string;
  heading_path: string;
  text: string;
}

interface LegacySearchResult {
  query: string;
  limit: number;
  resultCount: number;
  truncated: boolean;
  embedding: unknown;
  results: unknown[];
}

export function searchContext(
  environment: VaultEnvironment,
  input: ContextSearchInput,
): Result<ContextSearchResult> {
  const readiness = ensureRuntimeReady(environment);
  if (!readiness.ok) {
    return readiness;
  }
  const legacy = executeSearch(environment, input);
  if (!legacy.ok) {
    return legacy as Result<ContextSearchResult>;
  }
  const rows = legacy.value.results as Array<{
    path: string;
    title: string;
    headingPath: string;
    chunkId: string;
    snippet: string;
    freshness: { state: "fresh" | "stale" | "unknown"; reason?: string };
    scoreComponents: ContextSearchResult["results"][number]["scoreComponents"] & { semantic: number };
    why_matched: string[];
  }>;
  return {
    ok: true,
    value: {
      readiness: readiness.value,
      query: legacy.value.query,
      limit: legacy.value.limit,
      results: rows.map((row) => ({
        path: row.path,
        title: row.title,
        headingPath: row.headingPath,
        chunkId: row.chunkId,
        snippet: row.snippet,
        freshness: row.freshness,
        scoreComponents: {
          title: row.scoreComponents.title,
          path: row.scoreComponents.path,
          heading: row.scoreComponents.heading,
          tag: row.scoreComponents.tag,
          lexical: row.scoreComponents.lexical,
          alias: row.scoreComponents.alias,
          backlink: row.scoreComponents.backlink,
          recency: row.scoreComponents.recency,
        },
        whyMatched: row.why_matched,
      })),
      truncated: legacy.value.truncated,
    },
  };
}

export function searchContextForAdapter(
  environment: VaultEnvironment,
  input: ContextSearchInput,
): Result<LegacySearchResult> {
  return executeSearch(environment, input, environment.embeddingConfig);
}

export function readContext(
  environment: VaultEnvironment,
  input: ReadContextInput,
): Result<ReadContextResult> {
  return readContextInternal(environment, input, true, "path-only");
}

export function readContextForAdapter(
  environment: VaultEnvironment,
  input: AdapterReadContextInput,
): Result<ReadContextResult> {
  return readContextInternal(environment, input, false, "legacy");
}

export function inspectContextSource(
  environment: VaultEnvironment,
  input: InspectContextSourceInput,
): Result<ContextSourceInspection> {
  const inspection = inspectImportSource({
    rootDir: environment.rootDir,
    vaultPath: environment.vaultPath,
    privateGlobs: environment.privateGlobs,
    inputPath: input.path,
    explicitPathProvided: true,
    requireAbsolutePath: true,
    offset: input.offset,
    maxChars: input.maxChars,
  });
  if (!inspection.ok) {
    return inspection;
  }
  const { preview: _preview, ...source } = inspection.value;
  return { ok: true, value: source };
}

export function relatedContext(
  environment: VaultEnvironment,
  input: RelatedContextInput,
): Result<RelatedContextResult> {
  const readiness = ensureRuntimeReady(environment);
  if (!readiness.ok) {
    return readiness;
  }
  const related = executeRelated(environment, input, false, "strict");
  if (!related.ok) {
    return related;
  }
  return {
    ok: true as const,
    value: {
      readiness: readiness.value,
      ...related.value,
    },
  };
}

export function relatedContextForAdapter(
  environment: VaultEnvironment,
  input: RelatedContextInput,
) {
  return executeRelated(environment, input, true, "legacy");
}

function executeSearch(
  environment: VaultEnvironment,
  input: ContextSearchInput,
  embeddingConfig?: VaultEnvironment["embeddingConfig"],
): Result<LegacySearchResult> {
  const query = input.query.trim();
  if (!query) {
    return fail("context-query-invalid", "context search query must be non-empty");
  }
  const limit = boundedInteger(input.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, "context-search-limit-invalid");
  if (!limit.ok) {
    return limit as Result<LegacySearchResult>;
  }
  const search = searchVaultIndex({
    databasePath: environment.databasePath,
    query,
    limit: limit.value,
    embeddingConfig,
  });
  if (!search.ok) {
    return {
      ok: false,
      error: normalizeIndexError(search.error),
    };
  }
  return {
    ok: true,
    value: {
      query,
      limit: limit.value,
      resultCount: search.value.results.length,
      truncated: search.value.results.length >= limit.value,
      embedding: search.value.embedding,
      results: search.value.results,
    },
  };
}

function readContextInternal(
  environment: VaultEnvironment,
  input: ReadContextInput | AdapterReadContextInput,
  automaticReadiness: boolean,
  selectionMode: "path-only" | "legacy",
): Result<ReadContextResult> {
  let readiness: RuntimeReadiness;
  if (automaticReadiness) {
    const prepared = ensureRuntimeReady(environment);
    if (!prepared.ok) {
      return prepared;
    }
    readiness = prepared.value;
  } else {
    if (!fs.existsSync(environment.databasePath)) {
      return fail("runtime-db-unavailable", "runtime database is unavailable");
    }
    readiness = {
      action: "none",
      generation: "",
      freshness: {
        state: "ready",
        updatedPaths: [],
        newPaths: [],
        deletedPaths: [],
        excludedPaths: [],
        stalePaths: [],
      },
    };
  }

  const maxChars = boundedInteger(input.maxChars, DEFAULT_READ_CHARS, MAX_READ_CHARS, "context-read-max-chars-invalid");
  if (!maxChars.ok) {
    return maxChars as Result<ReadContextResult>;
  }
  const limit = boundedInteger(input.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT, "context-read-limit-invalid");
  if (!limit.ok) {
    return limit as Result<ReadContextResult>;
  }
  const pathInput = input.path?.trim();
  const chunkId = (input as AdapterReadContextInput).chunkId?.trim();
  if (selectionMode === "path-only" && (!pathInput || chunkId)) {
    return fail("context-read-selection-invalid", "context read requires one vault-relative path");
  }
  if (selectionMode === "legacy" && !pathInput && !chunkId) {
    return fail("context-read-selection-invalid", "context read requires a path or chunkId");
  }

  let db: Database.Database;
  try {
    db = new Database(environment.databasePath, { readonly: true, fileMustExist: true });
  } catch (error) {
    return failure("runtime-db-unavailable", "runtime database could not be opened", error);
  }

  try {
    let relativePath = "";
    let rows: IndexedExcerptRow[] = [];
    if (selectionMode === "legacy" && chunkId) {
      const row = db
        .prepare("select chunk_id, relative_path, heading_path, text from chunks where chunk_id = ?")
        .get(chunkId) as IndexedExcerptRow | undefined;
      if (!row) {
        return fail("chunk-not-found", "context chunk was not found");
      }
      relativePath = row.relative_path;
      rows = [row];
    } else {
      const classified = classifyVaultPath({
        vaultPath: environment.vaultPath,
        input: pathInput as string,
        privateGlobs: environment.privateGlobs,
      });
      if (!classified.ok) {
        return classified as Result<ReadContextResult>;
      }
      relativePath = classified.value.normalizedRelativePath;
      if (isAssetPath(relativePath)) {
        return fail("context-read-unsupported", "context read supports Markdown note paths only", relativePath);
      }
      rows = db
        .prepare(
          "select chunk_id, relative_path, heading_path, text from chunks where relative_path = ? order by ordinal",
        )
        .all(relativePath) as IndexedExcerptRow[];
      if (rows.length === 0) {
        return fail("note-not-found", "context note was not found", relativePath);
      }
      if (input.heading?.trim()) {
        rows = rows.filter((row) => headingMatches(row.heading_path, input.heading as string, selectionMode));
        if (rows.length === 0) {
          return fail("heading-not-found", "requested heading was not found", relativePath);
        }
      }
      rows = rows.slice(0, limit.value);
    }

    const file = db.prepare("select hash from files where relative_path = ?").get(relativePath) as { hash: string } | undefined;
    return {
      ok: true,
      value: {
        readiness,
        path: relativePath,
        hash: file?.hash,
        freshness: automaticReadiness
          ? { state: "fresh" }
          : readFreshness(environment, relativePath, file?.hash),
        excerpts: rows.map((row) => ({
          chunkId: row.chunk_id,
          headingPath: row.heading_path,
          line: headingLine(db, relativePath, row.heading_path),
          text: boundExcerpt(row.text, maxChars.value, selectionMode),
          trust: "untrusted" as const,
        })),
      },
    };
  } catch (error) {
    return failure("context-read-failed", "context note could not be read", error);
  } finally {
    db.close();
  }
}

function executeRelated(
  environment: VaultEnvironment,
  input: RelatedContextInput,
  persistReport: boolean,
  selectionMode: "strict" | "legacy",
): Result<RelatedGraphResult> {
  const pathValue = input.path?.trim();
  const query = input.query?.trim();
  const selectorCount = (pathValue ? 1 : 0) + (query ? 1 : 0);
  if ((selectionMode === "strict" && selectorCount !== 1) || (selectionMode === "legacy" && selectorCount === 0)) {
    return fail("context-selector-invalid", "related context requires exactly one path or query");
  }
  const limit = boundedInteger(input.limit, DEFAULT_RELATED_LIMIT, MAX_RELATED_LIMIT, "context-related-limit-invalid");
  if (!limit.ok) {
    return limit as Result<RelatedGraphResult>;
  }
  const selectedPath = pathValue || undefined;
  const selectedQuery = pathValue && selectionMode === "legacy" ? undefined : query;
  const result = persistReport
    ? buildGraphContextPack(environment, { path: selectedPath, query: selectedQuery, limit: limit.value, persistReport: true })
    : buildEphemeralGraphContext(environment, { path: selectedPath, query: selectedQuery, limit: limit.value });
  if (!result.ok) {
    return {
      ok: false as const,
      error: normalizeIndexError(result.error),
    };
  }
  return result as Result<RelatedGraphResult>;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  code: string,
): Result<number> {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    return fail(code, "requested bound is outside the safe range");
  }
  return { ok: true, value: resolved };
}

function headingLine(db: Database.Database, relativePath: string, headingPath: string): number {
  const row = db
    .prepare(
      "select min(line) as line from headings where relative_path = ? and heading_path = ?",
    )
    .get(relativePath, headingPath) as { line: number | null } | undefined;
  return row?.line ?? 1;
}

function headingMatches(candidate: string, requested: string, selectionMode: "path-only" | "legacy"): boolean {
  if (selectionMode === "legacy") {
    return legacyHeadingMatches(candidate, requested);
  }
  const normalizedRequested = normalizeHeading(requested);
  const normalizedCandidate = normalizeHeading(candidate);
  return normalizedCandidate === normalizedRequested || normalizedCandidate.endsWith(` > ${normalizedRequested}`);
}

function legacyHeadingMatches(candidate: string, requested: string): boolean {
  const normalizedCandidate = normalizeLegacyHeading(candidate);
  const normalizedRequested = normalizeLegacyHeading(requested);
  if (normalizedCandidate === normalizedRequested) {
    return true;
  }
  return normalizedCandidate.split(" > ").slice(-1)[0] === normalizedRequested;
}

function readFreshness(
  environment: VaultEnvironment,
  relativePath: string,
  indexedHash?: string,
): ReadContextResult["freshness"] {
  const classified = classifyVaultPath({
    vaultPath: environment.vaultPath,
    input: relativePath,
    privateGlobs: environment.privateGlobs,
  });
  if (!classified.ok) {
    return { state: "stale", reason: "excluded" };
  }
  if (!fs.existsSync(classified.value.absolutePath)) {
    return { state: "stale", reason: "missing" };
  }
  if (!indexedHash) {
    return { state: "unknown", reason: "not-indexed" };
  }
  try {
    return fileHash(classified.value.absolutePath) === indexedHash
      ? { state: "fresh" }
      : { state: "stale", reason: "hash-mismatch" };
  } catch {
    return { state: "stale", reason: "missing" };
  }
}

function normalizeHeading(value: string): string {
  return value.replace(/^#+\s*/, "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function normalizeLegacyHeading(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function boundExcerpt(text: string, maxChars: number, selectionMode: "path-only" | "legacy"): string {
  if (selectionMode === "legacy") {
    const compact = text.replace(/\s+/g, " ").trim();
    return compact.length <= maxChars
      ? compact
      : `${compact.slice(0, maxChars - 3).trimEnd()}...`;
  }
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function normalizeIndexError(error: StructuredError): StructuredError {
  const busy = /SQLITE_BUSY|database is locked/i.test(error.message);
  return {
    code: busy ? "index-busy" : error.code,
    message: busy ? "runtime index is busy" : error.message,
  };
}

function fail<T>(code: string, message: string, path?: string): Result<T> {
  return {
    ok: false,
    error: { code, message, path },
  };
}

function failure<T>(code: string, message: string, error: unknown): Result<T> {
  const busy = error instanceof Error && /SQLITE_BUSY|database is locked/i.test(error.message);
  return fail(busy ? "index-busy" : code, busy ? "runtime index is busy" : message);
}
