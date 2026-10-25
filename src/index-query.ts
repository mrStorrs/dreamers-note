import fs from "fs";
import Database from "better-sqlite3";
import { fileHash } from "./files";
import { readMeta, withStructuredErrors } from "./index-db";
import type { LexicalRetrievalCase, LexicalRetrievalEvaluation, SearchResult, SearchVaultIndexOptions, SearchVaultIndexResult } from "./index-contracts";
import { classifyVaultPath, privateGlobMatches } from "./path-safety";
import { rankSearchCandidates, PreparedSearchCandidateRow, SearchCandidateRow } from "./search-ranking";
import { normalizeForSearch, tokenizeSearchQuery } from "./text-prep";

const CANDIDATE_LIMIT = 200;
const RESULT_LIMIT = 10;

export function searchVaultIndexState(options: SearchVaultIndexOptions) {
  return withStructuredErrors("index-search-failed", () => {
    const db = new Database(options.databasePath, { readonly: true, fileMustExist: true });
    try {
      const query = options.query.trim();
      const tokens = tokenizeSearchQuery(query);
      if (!query || !tokens.length) return { results: [] } as SearchVaultIndexResult;
      const rows = db.prepare(candidateQuery()).all({
        candidateLimit: CANDIDATE_LIMIT,
        ftsQuery: buildFtsQuery(tokens),
        likeQuery: `%${normalizeForSearch(query)}%`,
      }) as SearchCandidateRow[];
      return {
        results: rankSearchCandidates({
          rows: rows.map((row) => ({ ...row, freshness: freshnessForPath(db, row.relative_path) } as PreparedSearchCandidateRow)),
          query,
          tokens,
          newestMtime: readNewestMtime(db),
          limit: options.limit ?? RESULT_LIMIT,
        }),
      } as SearchVaultIndexResult;
    } finally {
      db.close();
    }
  });
}

export function evaluateLexicalRetrievalState(options: { databasePath: string; cases: LexicalRetrievalCase[] }) {
  return withStructuredErrors("retrieval-evaluation-failed", () => {
    const results = options.cases.map((item) => {
      const search = searchVaultIndexState({ databasePath: options.databasePath, query: item.query, limit: 5 });
      if (!search.ok) throw new Error(search.error.message);
      const topPath = search.value.results[0]?.path;
      const noSourceGap = search.value.results.length === 0;
      return {
        name: item.name,
        topPath,
        noSourceGap,
        passed: item.expectNoSourceGap ? noSourceGap : Boolean(topPath && (item.expectedPaths ?? []).includes(topPath)),
        deterministic: true,
        whyMatched: search.value.results[0]?.whyMatched ?? [],
      };
    });
    return { results } as LexicalRetrievalEvaluation;
  });
}

function freshnessForPath(db: Database.Database, relativePath: string): SearchResult["freshness"] {
  const vaultPath = readMeta(db, "vault_path");
  if (!vaultPath) return { state: "unknown", reason: "missing-vault-path" };
  const privateGlobs = readJsonStringArray(readMeta(db, "private_globs") ?? "[]");
  const classified = classifyVaultPath({ vaultPath, input: relativePath, privateGlobs });
  if (!classified.ok || privateGlobs.some((glob) => privateGlobMatches(relativePath, glob))) return { state: "stale", reason: "excluded" };
  if (!fs.existsSync(classified.value.absolutePath)) return { state: "stale", reason: "missing" };
  const row = db.prepare("select hash from files where relative_path = ?").get(relativePath) as { hash: string } | undefined;
  if (!row) return { state: "unknown", reason: "not-indexed" };
  return fileHash(classified.value.absolutePath) === row.hash ? { state: "fresh" } : { state: "stale", reason: "hash-mismatch" };
}

function candidateQuery(): string {
  const normalized = (expression: string) => `lower(replace(replace(${expression}, '_', ' '), '-', ' '))`;
  return `
    with
      fts_matches as (select chunk_id from chunks_fts where chunks_fts match @ftsQuery limit @candidateLimit),
      note_backlink_matches as (
        select distinct e.target_path as relative_path from graph_edges e left join notes src on src.relative_path = e.relative_path
        where e.target_path is not null and (${normalized("coalesce(src.title, '')")} like @likeQuery or ${normalized("e.relative_path")} like @likeQuery or ${normalized("coalesce(e.alias, '')")} like @likeQuery)
      ),
      note_aliases as (select target_path as relative_path, group_concat(alias, ' ') as alias_terms from graph_edges where target_path is not null and alias is not null and trim(alias) != '' group by target_path),
      asset_backlink_matches as (
        select distinct a.relative_path from assets a join asset_references r on r.resolved_target_path = a.relative_path left join notes src on src.relative_path = r.relative_path
        where ${normalized("coalesce(src.title, '')")} like @likeQuery or ${normalized("r.relative_path")} like @likeQuery or ${normalized("coalesce(r.resolved_target_path, r.target)")} like @likeQuery
      ),
      note_candidates as (
        select c.chunk_id as candidate_id, c.relative_path, 'note' as result_kind, n.title, c.heading_path, c.text as body, n.approved_tags,
          case when exists(select 1 from fts_matches fm where fm.chunk_id = c.chunk_id) then 1 else 0 end as lexical_match,
          case when exists(select 1 from note_backlink_matches nb where nb.relative_path = c.relative_path) then 1 else 0 end as backlink_match,
          coalesce(na.alias_terms, '') as alias_terms, f.mtime_ms
        from chunks c join notes n on n.relative_path = c.relative_path join files f on f.relative_path = c.relative_path left join note_aliases na on na.relative_path = c.relative_path
        where exists(select 1 from fts_matches fm where fm.chunk_id = c.chunk_id) or ${normalized("n.title")} like @likeQuery or ${normalized("c.heading_path")} like @likeQuery or ${normalized("c.relative_path")} like @likeQuery or ${normalized("n.approved_tags")} like @likeQuery or ${normalized("coalesce(na.alias_terms, '')")} like @likeQuery or exists(select 1 from note_backlink_matches nb where nb.relative_path = c.relative_path)
        limit @candidateLimit
      ),
      note_metadata_candidates as (
        select 'note-meta:' || n.relative_path as candidate_id, n.relative_path, 'note' as result_kind, n.title, '' as heading_path, '' as body, n.approved_tags,
          0 as lexical_match, case when exists(select 1 from note_backlink_matches nb where nb.relative_path = n.relative_path) then 1 else 0 end as backlink_match,
          coalesce(na.alias_terms, '') as alias_terms, f.mtime_ms
        from notes n join files f on f.relative_path = n.relative_path left join note_aliases na on na.relative_path = n.relative_path
        where ${normalized("n.title")} like @likeQuery or ${normalized("n.relative_path")} like @likeQuery or ${normalized("n.approved_tags")} like @likeQuery or ${normalized("coalesce(na.alias_terms, '')")} like @likeQuery or exists(select 1 from note_backlink_matches nb where nb.relative_path = n.relative_path)
        limit @candidateLimit
      ),
      asset_candidates as (
        select 'asset:' || a.relative_path as candidate_id, a.relative_path, 'asset' as result_kind, a.filename as title, '' as heading_path, a.relative_path || ' .' || a.extension as body, '[]' as approved_tags,
          case when ${normalized("a.filename")} like @likeQuery or ${normalized("a.relative_path")} like @likeQuery or ${normalized("a.extension")} like @likeQuery then 1 else 0 end as lexical_match,
          case when exists(select 1 from asset_backlink_matches ab where ab.relative_path = a.relative_path) then 1 else 0 end as backlink_match, '' as alias_terms, f.mtime_ms
        from assets a join files f on f.relative_path = a.relative_path
        where ${normalized("a.filename")} like @likeQuery or ${normalized("a.relative_path")} like @likeQuery or ${normalized("a.extension")} like @likeQuery or exists(select 1 from asset_backlink_matches ab where ab.relative_path = a.relative_path)
        limit @candidateLimit
      )
    select * from note_candidates union all select * from note_metadata_candidates union all select * from asset_candidates limit @candidateLimit
  `;
}

function buildFtsQuery(tokens: string[]): string {
  return tokens.map((token) => `"${token.replace(/"/g, "\"\"")}"`).join(" OR ");
}

function readNewestMtime(db: Database.Database): number {
  return (db.prepare("select max(mtime_ms) as newest_mtime from files").get() as { newest_mtime: number | null }).newest_mtime ?? 0;
}

function readJsonStringArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
