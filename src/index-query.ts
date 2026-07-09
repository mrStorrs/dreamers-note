import fs from "fs";
import Database from "better-sqlite3";
import {
  compareEmbeddingRows,
  cosineSimilarity,
  embedTexts,
  EmbeddingStatus,
  normalizeEmbeddingStatus,
  parseEmbedding,
  StoredEmbeddingRow,
} from "./embeddings";
import { fileHash } from "./files";
import { readMeta, withStructuredErrors } from "./index-db";
import type {
  HybridRetrievalEvaluation,
  LexicalRetrievalCase,
  LexicalRetrievalEvaluation,
  SearchResult,
  SearchVaultIndexOptions,
  SearchVaultIndexResult,
} from "./index-contracts";
import { classifyVaultPath, privateGlobMatches } from "./path-safety";
import type { HybridRetrievalCase } from "./retrieval-feedback";
import { rankSearchCandidates, PreparedSearchCandidateRow, SearchCandidateRow } from "./search-ranking";
import { normalizeForSearch, tokenizeSearchQuery } from "./text-prep";

const CANDIDATE_LIMIT = 200;
const RESULT_LIMIT = 10;
const SEMANTIC_THRESHOLD = 0.22;

export function searchVaultIndexState(options: SearchVaultIndexOptions) {
  return withStructuredErrors("index-search-failed", () => {
    const db = new Database(options.databasePath, { readonly: true, fileMustExist: true });
    try {
      const query = options.query.trim();
      const tokens = tokenizeSearchQuery(query);
      const embeddingRows = readEmbeddingRows(db);
      const embedding = resolveEmbeddingStatus(db, options, embeddingRows);
      if (!query || tokens.length === 0) {
        const emptyResult: SearchVaultIndexResult = {
          results: [],
          embedding,
        };
        return emptyResult;
      }

      const lexicalRows = db.prepare(candidateQuery()).all({
        candidateLimit: CANDIDATE_LIMIT,
        ftsQuery: buildFtsQuery(tokens),
        likeQuery: `%${normalizeForSearch(query)}%`,
      }) as SearchCandidateRow[];
      const semanticScores = semanticScoreMap(db, options, embedding, embeddingRows);
      const semanticRows = readSemanticCandidateRows(
        db,
        [...semanticScores.keys()].filter((chunkId) => !lexicalRows.some((row) => row.candidate_id === chunkId)),
      );
      const newestMtime = readNewestMtime(db);
      const candidateRows = hydrateCandidateFreshness(db, [...lexicalRows, ...semanticRows]);
      const results = rankSearchCandidates({
        rows: candidateRows,
        query,
        tokens,
        semanticScores,
        newestMtime,
        limit: options.limit ?? RESULT_LIMIT,
      });

      const searchResult: SearchVaultIndexResult = {
        results,
        embedding,
      };
      return searchResult;
    } finally {
      db.close();
    }
  });
}

export function evaluateLexicalRetrievalState(options: {
  databasePath: string;
  cases: LexicalRetrievalCase[];
}) {
  return withStructuredErrors("retrieval-evaluation-failed", () => {
    const results = options.cases.map((item) => {
      const search = searchVaultIndexState({ databasePath: options.databasePath, query: item.query, limit: 5 });
      if (!search.ok) {
        throw new Error(search.error.message);
      }
      const topPath = search.value.results[0]?.path;
      const noSourceGap = search.value.results.length === 0;
      const expectedPaths = item.expectedPaths ?? [];
      const passed = item.expectNoSourceGap ? noSourceGap : Boolean(topPath && expectedPaths.includes(topPath));
      return {
        name: item.name,
        topPath,
        noSourceGap,
        passed,
        deterministic: true,
        whyMatched: search.value.results[0]?.why_matched ?? [],
      };
    });
    const evaluation: LexicalRetrievalEvaluation = { results };
    return evaluation;
  });
}

export function evaluateHybridRetrievalState(options: {
  databasePath: string;
  cases: HybridRetrievalCase[];
  embeddingConfig?: SearchVaultIndexOptions["embeddingConfig"];
}) {
  return withStructuredErrors("hybrid-retrieval-evaluation-failed", () => {
    const results = options.cases.map((item) => {
      const search = searchVaultIndexState({
        databasePath: options.databasePath,
        query: item.query,
        limit: Math.max(5, item.topK ?? 1),
        embeddingConfig: options.embeddingConfig,
      });
      if (!search.ok) {
        throw new Error(search.error.message);
      }
      const topPaths = search.value.results.map((result) => result.path);
      const topPath = topPaths[0];
      const noSourceGap = search.value.results.length === 0;
      const expectedPaths = item.expectedPaths ?? [];
      const topK = item.topK ?? 1;
      const passed = item.expectNoSourceGap
        ? noSourceGap
        : expectedPaths.some((expectedPath) => topPaths.slice(0, topK).includes(expectedPath));
      return {
        name: item.name,
        topPath,
        topPaths,
        noSourceGap,
        passed,
        deterministic: true,
        whyMatched: search.value.results[0]?.why_matched ?? [],
        embedding: search.value.embedding,
      };
    });
    const evaluation: HybridRetrievalEvaluation = { results };
    return evaluation;
  });
}

function resolveEmbeddingStatus(
  db: Database.Database,
  options: SearchVaultIndexOptions,
  embeddingRows: StoredEmbeddingRow[],
): EmbeddingStatus {
  const policyHash = readMeta(db, "embedding_policy_hash") ?? "";
  return normalizeEmbeddingStatus({
    config: options.embeddingConfig,
    rows: embeddingRows,
    policyHash,
    lastState: readMeta(db, "embedding_state"),
    lastError: readMeta(db, "embedding_error") || undefined,
  });
}

function semanticScoreMap(
  db: Database.Database,
  options: SearchVaultIndexOptions,
  embedding: EmbeddingStatus,
  embeddingRows: StoredEmbeddingRow[],
): Map<string, number> {
  if (!options.embeddingConfig || embedding.state !== "ready") {
    return new Map();
  }

  const embeddedQuery = embedTexts(options.embeddingConfig, [options.query]);
  if (!embeddedQuery.ok) {
    embedding.state = "unavailable";
    embedding.lastError = embeddedQuery.error.message;
    return new Map();
  }

  const policyHash = readMeta(db, "embedding_policy_hash") ?? "";
  return new Map(
    embeddingRows
      .filter((row) => compareEmbeddingRows(row, options.embeddingConfig, policyHash) === "fresh")
      .map((row) => [row.chunk_id, cosineSimilarity(embeddedQuery.value.vectors[0], parseEmbedding(row.vector))] as const)
      .filter(([, similarity]) => similarity >= SEMANTIC_THRESHOLD)
      .sort((left, right) => right[1] - left[1])
      .slice(0, CANDIDATE_LIMIT),
  );
}

function readEmbeddingRows(db: Database.Database): StoredEmbeddingRow[] {
  if (!tableExists(db, "chunk_embeddings")) {
    return [];
  }
  return db
    .prepare(
      [
        "select chunk_id, relative_path, content_hash, vector, dimensions, model_name, model_version, provider, policy_hash",
        "from chunk_embeddings order by chunk_id",
      ].join(" "),
    )
    .all() as StoredEmbeddingRow[];
}

function readSemanticCandidateRows(db: Database.Database, chunkIds: string[]): SearchCandidateRow[] {
  if (chunkIds.length === 0) {
    return [];
  }
  const placeholders = chunkIds.map(() => "?").join(", ");
  return db.prepare(candidateByChunkIdsQuery(placeholders)).all(...chunkIds) as SearchCandidateRow[];
}

function hydrateCandidateFreshness(
  db: Database.Database,
  rows: SearchCandidateRow[],
): PreparedSearchCandidateRow[] {
  return rows.map((row) => ({
    ...row,
    freshness: freshnessForPath(db, row.relative_path),
  }));
}

function freshnessForPath(db: Database.Database, relativePath: string): SearchResult["freshness"] {
  const vaultPath = readMeta(db, "vault_path");
  if (!vaultPath) {
    return { state: "unknown", reason: "missing-vault-path" };
  }
  const privateGlobs = readJsonStringArray(readMeta(db, "private_globs") ?? "[]");
  const classified = classifyVaultPath({ vaultPath, input: relativePath, privateGlobs });
  if (!classified.ok || privateGlobs.some((glob) => privateGlobMatches(relativePath, glob))) {
    return { state: "stale", reason: "excluded" };
  }
  if (!fs.existsSync(classified.value.absolutePath)) {
    return { state: "stale", reason: "missing" };
  }
  const row = db.prepare("select hash from files where relative_path = ?").get(relativePath) as { hash: string } | undefined;
  if (!row) {
    return { state: "unknown", reason: "not-indexed" };
  }
  return fileHash(classified.value.absolutePath) === row.hash
    ? { state: "fresh" }
    : { state: "stale", reason: "hash-mismatch" };
}

function candidateQuery(): string {
  const normalizedTitle = normalizedSql("n.title");
  const normalizedPath = normalizedSql("n.relative_path");
  const normalizedChunkPath = normalizedSql("c.relative_path");
  const normalizedHeading = normalizedSql("c.heading_path");
  const normalizedTags = normalizedSql("n.approved_tags");
  const normalizedAssetFilename = normalizedSql("a.filename");
  const normalizedAssetPath = normalizedSql("a.relative_path");
  const normalizedAssetExtension = normalizedSql("a.extension");
  const normalizedAliases = normalizedSql("coalesce(na.alias_terms, '')");
  return `
    with
      fts_matches as (
        select chunk_id
        from chunks_fts
        where chunks_fts match @ftsQuery
        limit @candidateLimit
      ),
      note_backlink_matches as (
        select distinct e.target_path as relative_path
        from graph_edges e
        left join notes src on src.relative_path = e.relative_path
        where e.target_path is not null
          and (
            ${normalizedSql("coalesce(src.title, '')")} like @likeQuery
            or ${normalizedSql("e.relative_path")} like @likeQuery
            or ${normalizedSql("coalesce(e.alias, '')")} like @likeQuery
          )
      ),
      note_aliases as (
        select target_path as relative_path, group_concat(alias, ' ') as alias_terms
        from graph_edges
        where target_path is not null and alias is not null and trim(alias) != ''
        group by target_path
      ),
      asset_backlink_matches as (
        select distinct a.relative_path
        from assets a
        join asset_references r on r.resolved_target_path = a.relative_path
        left join notes src on src.relative_path = r.relative_path
        where ${normalizedSql("coalesce(src.title, '')")} like @likeQuery
           or ${normalizedSql("r.relative_path")} like @likeQuery
           or ${normalizedSql("coalesce(r.resolved_target_path, r.target)")} like @likeQuery
      ),
      note_candidates as (
        select
          c.chunk_id as candidate_id,
          c.relative_path,
          'note' as result_kind,
          n.title,
          c.heading_path,
          c.text as body,
          n.approved_tags,
          case when exists(select 1 from fts_matches fm where fm.chunk_id = c.chunk_id) then 1 else 0 end as lexical_match,
          case when exists(select 1 from note_backlink_matches nb where nb.relative_path = c.relative_path) then 1 else 0 end as backlink_match,
          coalesce(na.alias_terms, '') as alias_terms,
          f.mtime_ms
        from chunks c
        join notes n on n.relative_path = c.relative_path
        join files f on f.relative_path = c.relative_path
        left join note_aliases na on na.relative_path = c.relative_path
        where exists(select 1 from fts_matches fm where fm.chunk_id = c.chunk_id)
           or ${normalizedTitle} like @likeQuery
           or ${normalizedHeading} like @likeQuery
           or ${normalizedChunkPath} like @likeQuery
           or ${normalizedTags} like @likeQuery
           or ${normalizedAliases} like @likeQuery
           or exists(select 1 from note_backlink_matches nb where nb.relative_path = c.relative_path)
        limit @candidateLimit
      ),
      note_metadata_candidates as (
        select
          'note-meta:' || n.relative_path as candidate_id,
          n.relative_path,
          'note' as result_kind,
          n.title,
          '' as heading_path,
          '' as body,
          n.approved_tags,
          0 as lexical_match,
          case when exists(select 1 from note_backlink_matches nb where nb.relative_path = n.relative_path) then 1 else 0 end as backlink_match,
          coalesce(na.alias_terms, '') as alias_terms,
          f.mtime_ms
        from notes n
        join files f on f.relative_path = n.relative_path
        left join note_aliases na on na.relative_path = n.relative_path
        where ${normalizedTitle} like @likeQuery
           or ${normalizedPath} like @likeQuery
           or ${normalizedTags} like @likeQuery
           or ${normalizedAliases} like @likeQuery
           or exists(select 1 from note_backlink_matches nb where nb.relative_path = n.relative_path)
        limit @candidateLimit
      ),
      asset_candidates as (
        select
          'asset:' || a.relative_path as candidate_id,
          a.relative_path,
          'asset' as result_kind,
          a.filename as title,
          '' as heading_path,
          a.relative_path || ' .' || a.extension as body,
          '[]' as approved_tags,
          case
            when ${normalizedAssetFilename} like @likeQuery
              or ${normalizedAssetPath} like @likeQuery
              or ${normalizedAssetExtension} like @likeQuery
            then 1 else 0
          end as lexical_match,
          case when exists(select 1 from asset_backlink_matches ab where ab.relative_path = a.relative_path) then 1 else 0 end as backlink_match,
          '' as alias_terms,
          f.mtime_ms
        from assets a
        join files f on f.relative_path = a.relative_path
        where ${normalizedAssetFilename} like @likeQuery
           or ${normalizedAssetPath} like @likeQuery
           or ${normalizedAssetExtension} like @likeQuery
           or exists(select 1 from asset_backlink_matches ab where ab.relative_path = a.relative_path)
        limit @candidateLimit
      )
    select * from note_candidates
    union all
    select * from note_metadata_candidates
    union all
    select * from asset_candidates
    limit @candidateLimit
  `;
}

function candidateByChunkIdsQuery(placeholders: string): string {
  return `
    with note_aliases as (
      select target_path as relative_path, group_concat(alias, ' ') as alias_terms
      from graph_edges
      where target_path is not null and alias is not null and trim(alias) != ''
      group by target_path
    )
    select
      c.chunk_id as candidate_id,
      c.relative_path,
      'note' as result_kind,
      n.title,
      c.heading_path,
      c.text as body,
      n.approved_tags,
      0 as lexical_match,
      0 as backlink_match,
      coalesce(na.alias_terms, '') as alias_terms,
      f.mtime_ms
    from chunks c
    join notes n on n.relative_path = c.relative_path
    join files f on f.relative_path = c.relative_path
    left join note_aliases na on na.relative_path = c.relative_path
    where c.chunk_id in (${placeholders})
  `;
}

function buildFtsQuery(tokens: string[]): string {
  return tokens.map((token) => `"${token.replace(/"/g, "\"\"")}"`).join(" OR ");
}

function normalizedSql(expression: string): string {
  return `lower(replace(replace(${expression}, '_', ' '), '-', ' '))`;
}

function readNewestMtime(db: Database.Database): number {
  const row = db.prepare("select max(mtime_ms) as newest_mtime from files").get() as { newest_mtime: number | null };
  return row.newest_mtime ?? 0;
}

function readJsonStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("select 1 as present from sqlite_schema where type = 'table' and name = ?")
    .get(tableName) as { present: number } | undefined;
  return Boolean(row?.present);
}
