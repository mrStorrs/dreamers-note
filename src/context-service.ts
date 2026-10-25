import Database from "better-sqlite3";
import { isAssetPath } from "./files";
import { buildRelatedContext } from "./graph-review";
import { inspectImportSource } from "./import-source";
import { searchVaultIndex } from "./index-search";
import type { SearchResult } from "./index-contracts";
import { classifyVaultPath } from "./path-safety";
import { ensureRuntimeReady, type RuntimeReadiness } from "./runtime-readiness";
import type { Result } from "./types";
import type { VaultEnvironment } from "./vault-environment";

const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_READ_CHARS = 1_200;
const MAX_READ_CHARS = 12_000;
const DEFAULT_READ_LIMIT = 4;
const MAX_READ_LIMIT = 12;
const DEFAULT_RELATED_LIMIT = 8;
const MAX_RELATED_LIMIT = 30;

export interface ContextSearchInput { query: string; limit?: number; }
export interface ContextSearchResult {
  readiness: RuntimeReadiness;
  query: string;
  limit: number;
  results: SearchResult[];
  truncated: boolean;
}
export interface ReadContextInput { path: string; heading?: string; maxChars?: number; limit?: number; }
export interface ReadContextResult {
  readiness: RuntimeReadiness;
  path: string;
  hash?: string;
  freshness: { state: "fresh" | "stale" | "unknown"; reason?: string };
  excerpts: Array<{ chunkId: string; headingPath: string; line: number; text: string; trust: "untrusted" }>;
}
export interface InspectContextSourceInput { path: string; offset?: number; maxChars?: number; }
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
export interface RelatedContextInput { path?: string; query?: string; limit?: number; }
export interface RelatedContextResult {
  readiness: RuntimeReadiness;
  subject: { path: string; title: string };
  groups: Record<string, { items: unknown[] }>;
}

export function searchContext(environment: VaultEnvironment, input: ContextSearchInput): Result<ContextSearchResult> {
  const query = input.query.trim();
  if (!query) return fail("context-query-invalid", "context search query must be non-empty");
  const limit = bounded(input.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, "context-search-limit-invalid");
  if (!limit.ok) return limit as Result<ContextSearchResult>;
  const readiness = ensureRuntimeReady(environment);
  if (!readiness.ok) return readiness;
  const search = searchVaultIndex({ databasePath: environment.databasePath, query, limit: limit.value });
  if (!search.ok) return search as Result<ContextSearchResult>;
  return { ok: true, value: { readiness: readiness.value, query, limit: limit.value, results: search.value.results, truncated: search.value.results.length >= limit.value } };
}

export function readContext(environment: VaultEnvironment, input: ReadContextInput): Result<ReadContextResult> {
  if (!input.path?.trim()) return fail("context-read-selection-invalid", "context read path must be non-empty");
  const readiness = ensureRuntimeReady(environment);
  if (!readiness.ok) return readiness;
  const maxChars = bounded(input.maxChars, DEFAULT_READ_CHARS, MAX_READ_CHARS, "context-read-max-chars-invalid");
  const limit = bounded(input.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT, "context-read-limit-invalid");
  if (!maxChars.ok) return maxChars as Result<ReadContextResult>;
  if (!limit.ok) return limit as Result<ReadContextResult>;
  const classified = classifyVaultPath({ vaultPath: environment.vaultPath, input: input.path, privateGlobs: environment.privateGlobs });
  if (!classified.ok) return classified as Result<ReadContextResult>;
  if (isAssetPath(classified.value.normalizedRelativePath)) return fail("context-read-unsupported", "context read supports Markdown note paths only");
  try {
    const db = new Database(environment.databasePath, { readonly: true, fileMustExist: true });
    try {
      let rows = db.prepare("select chunk_id, relative_path, heading_path, text from chunks where relative_path = ? order by ordinal").all(classified.value.normalizedRelativePath) as Array<{ chunk_id: string; relative_path: string; heading_path: string; text: string }>;
      if (!rows.length) return fail("note-not-found", "context note was not found", classified.value.normalizedRelativePath);
      if (input.heading?.trim()) {
        const requested = normalizeHeading(input.heading);
        rows = rows.filter((row) => normalizeHeading(row.heading_path) === requested || normalizeHeading(row.heading_path).endsWith(` > ${requested}`));
        if (!rows.length) return fail("heading-not-found", "requested heading was not found", classified.value.normalizedRelativePath);
      }
      const hash = (db.prepare("select hash from files where relative_path = ?").get(classified.value.normalizedRelativePath) as { hash: string } | undefined)?.hash;
      return {
        ok: true,
        value: {
          readiness: readiness.value,
          path: classified.value.normalizedRelativePath,
          hash,
          freshness: { state: "fresh" },
          excerpts: rows.slice(0, limit.value).map((row) => ({
            chunkId: row.chunk_id,
            headingPath: row.heading_path,
            line: headingLine(db, row.relative_path, row.heading_path),
            text: boundText(row.text, maxChars.value),
            trust: "untrusted" as const,
          })),
        },
      };
    } finally { db.close(); }
  } catch {
    return fail("context-read-failed", "context note could not be read");
  }
}

export function inspectContextSource(environment: VaultEnvironment, input: InspectContextSourceInput): Result<ContextSourceInspection> {
  const inspected = inspectImportSource({
    rootDir: environment.rootDir,
    vaultPath: environment.vaultPath,
    privateGlobs: environment.privateGlobs,
    inputPath: input.path,
    explicitPathProvided: true,
    requireAbsolutePath: true,
    offset: input.offset,
    maxChars: input.maxChars,
  });
  if (!inspected.ok) return inspected;
  const { preview: _preview, ...source } = inspected.value;
  return { ok: true, value: source };
}

export function relatedContext(environment: VaultEnvironment, input: RelatedContextInput): Result<RelatedContextResult> {
  const hasPath = Boolean(input.path?.trim());
  const hasQuery = Boolean(input.query?.trim());
  if (hasPath === hasQuery) return fail("context-selector-invalid", "related context requires exactly one path or query");
  const limit = bounded(input.limit, DEFAULT_RELATED_LIMIT, MAX_RELATED_LIMIT, "context-related-limit-invalid");
  if (!limit.ok) return limit as Result<RelatedContextResult>;
  const readiness = ensureRuntimeReady(environment);
  if (!readiness.ok) return readiness;
  const related = buildRelatedContext(environment, { path: input.path, query: input.query, limit: limit.value });
  if (!related.ok) return related as Result<RelatedContextResult>;
  return { ok: true, value: { readiness: readiness.value, ...related.value } };
}

function bounded(value: number | undefined, fallback: number, maximum: number, code: string): Result<number> {
  const resolved = value ?? fallback;
  return Number.isInteger(resolved) && resolved >= 1 && resolved <= maximum
    ? { ok: true, value: resolved }
    : fail(code, "requested bound is outside the safe range");
}

function headingLine(db: Database.Database, relativePath: string, headingPath: string): number {
  return (db.prepare("select min(line) as line from headings where relative_path = ? and heading_path = ?").get(relativePath, headingPath) as { line: number | null } | undefined)?.line ?? 1;
}

function normalizeHeading(value: string): string { return value.replace(/^#+\s*/, "").trim().replace(/\s+/g, " ").toLocaleLowerCase(); }
function boundText(value: string, limit: number): string { return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`; }
function fail<T>(code: string, message: string, path?: string): Result<T> { return { ok: false, error: { code, message, path } }; }
