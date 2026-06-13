import fs from "fs";
import Database from "better-sqlite3";
import {
  compareEmbeddingRows,
  cosineSimilarity,
  embedTexts,
  EmbeddingStatus,
  normalizeEmbeddingStatus,
  parseEmbedding,
  semanticTokensForText,
  StoredEmbeddingRow,
} from "./embeddings";
import { compareVaultPaths, fileHash, isAssetPath } from "./files";
import { readMeta, withStructuredErrors } from "./index-db";
import type {
  HybridRetrievalEvaluation,
  LexicalRetrievalCase,
  LexicalRetrievalEvaluation,
  SearchResult,
  SearchVaultIndexOptions,
  SearchVaultIndexResult,
} from "./index-search";
import type { HybridRetrievalCase } from "./retrieval-feedback";
import { classifyVaultPath, privateGlobMatches } from "./path-safety";

interface SearchCandidateRow {
  candidate_id: string;
  relative_path: string;
  result_kind: "note" | "asset";
  title: string;
  heading_path: string;
  body: string;
  approved_tags: string;
  lexical_match: number;
  backlink_match: number;
  alias_terms: string;
  mtime_ms: number;
}

interface SearchCandidate extends SearchCandidateRow {
  snippetBody: string;
}

const CANDIDATE_LIMIT = 200;
const RESULT_LIMIT = 10;
const SNIPPET_LIMIT = 240;
const SEARCH_STOP_WORDS = new Set([
  "a",
  "assistant",
  "an",
  "and",
  "are",
  "be",
  "been",
  "being",
  "for",
  "had",
  "has",
  "have",
  "ignore",
  "in",
  "instructions",
  "is",
  "it",
  "no",
  "not",
  "of",
  "on",
  "or",
  "previous",
  "prompt",
  "should",
  "system",
  "that",
  "the",
  "these",
  "this",
  "those",
  "to",
  "with",
]);
const RECENCY_TOKENS = new Set(["current", "fresh", "latest", "new", "recent", "updated"]);
const SEMANTIC_THRESHOLD = 0.22;

export function searchVaultIndexState(options: SearchVaultIndexOptions) {
  return withStructuredErrors("index-search-failed", () => {
    const db = new Database(options.databasePath, { readonly: true, fileMustExist: true });
    try {
      const query = options.query.trim();
      const tokens = tokenizeQuery(query);
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
      const results = mergeCandidates([...lexicalRows, ...semanticRows])
        .map((row) => toCandidate(row))
        .map((row) => scoreCandidate(db, row, query, tokens, semanticScores.get(row.candidate_id) ?? 0, newestMtime))
        .filter((result) => totalScore(result.scoreComponents) > 0)
        .sort(compareSearchResults)
        .slice(0, options.limit ?? RESULT_LIMIT);

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

function mergeCandidates(rows: SearchCandidateRow[]): SearchCandidateRow[] {
  const merged = new Map<string, SearchCandidateRow>();
  for (const row of rows) {
    if (!merged.has(row.candidate_id)) {
      merged.set(row.candidate_id, row);
    }
  }
  return [...merged.values()];
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

function toCandidate(row: SearchCandidateRow): SearchCandidate {
  return {
    ...row,
    snippetBody: row.result_kind === "asset" ? row.body : row.body.replace(/\s+/g, " ").trim(),
  };
}

function scoreCandidate(
  db: Database.Database,
  row: SearchCandidate,
  query: string,
  tokens: string[],
  semanticSimilarity: number,
  newestMtime: number,
): SearchResult {
  const normalizedQuery = normalizeForSearch(query);
  const tags = readJsonStringArray(row.approved_tags);
  const pathText = normalizeForSearch(row.relative_path);
  const titleText = normalizeForSearch(row.title);
  const headingText = normalizeForSearch(row.heading_path);
  const bodyText = normalizeForSearch(row.body);
  const aliasText = normalizeForSearch(row.alias_terms);
  const freshness = freshnessForPath(db, row.relative_path);
  const scoreComponents = {
    title: componentScore(titleText, normalizedQuery, tokens, row.result_kind === "asset" ? 90 : 100, 55),
    path: componentScore(pathText, normalizedQuery, tokens, row.result_kind === "asset" ? 70 : 60, 24),
    heading: row.result_kind === "asset" ? 0 : componentScore(headingText, normalizedQuery, tokens, 45, 18),
    tag: row.result_kind === "asset" ? 0 : tags.some((tag) => tokens.includes(normalizeForSearch(tag))) ? 35 : 0,
    lexical: lexicalScore(row, normalizedQuery, tokens, bodyText),
    semantic: row.result_kind === "asset" || freshness.state !== "fresh" ? 0 : semanticComponent(semanticSimilarity, query, row),
    alias: row.result_kind === "asset" ? 0 : componentScore(aliasText, normalizedQuery, tokens, 55, 18),
    backlink: backlinkScore(row, tokens),
    recency: recencyScore(row.mtime_ms, query, newestMtime),
  };

  return {
    path: row.relative_path,
    title: row.title,
    headingPath: row.heading_path,
    chunkId: row.candidate_id,
    snippet: boundedSnippet(row.snippetBody, tokens),
    freshness,
    scoreComponents,
    why_matched: whyMatched(scoreComponents),
  };
}

function lexicalScore(
  row: SearchCandidate,
  normalizedQuery: string,
  tokens: string[],
  bodyText: string,
): number {
  if (row.result_kind === "asset") {
    const filenameText = normalizeForSearch(row.title);
    if (filenameText === normalizedQuery || row.relative_path.toLocaleLowerCase() === normalizedQuery) {
      return 40;
    }
    if (normalizedQuery && (filenameText.includes(normalizedQuery) || bodyText.includes(normalizedQuery))) {
      return 35;
    }
    return row.lexical_match > 0 && allTokensPresent(bodyText, tokens) ? 30 : 0;
  }

  if (bodyText.includes(normalizedQuery) && normalizedQuery.length > 0) {
    return 40;
  }
  return row.lexical_match > 0 && allTokensPresent(bodyText, tokens) ? 30 : 0;
}

function semanticComponent(similarity: number, query: string, row: SearchCandidate): number {
  if (similarity < SEMANTIC_THRESHOLD) {
    return 0;
  }
  const queryTerms = new Set(semanticTokensForText(query));
  const candidateTerms = new Set(
    semanticTokensForText([row.title, row.heading_path, row.body, row.alias_terms].filter(Boolean).join(" ")),
  );
  const sharedTerms = [...queryTerms].filter((term) => candidateTerms.has(term));
  if (sharedTerms.length === 0) {
    return 0;
  }
  return Math.max(10, Math.min(40, Math.round(similarity * 45)));
}

function backlinkScore(row: SearchCandidate, tokens: string[]): number {
  if (!row.backlink_match) {
    return 0;
  }
  return tokens.length > 0 ? 25 : 0;
}

function recencyScore(mtimeMs: number, query: string, newestMtime: number): number {
  if (!hasRecencyIntent(query) || mtimeMs <= 0 || newestMtime <= 0) {
    return 0;
  }
  const delta = newestMtime - mtimeMs;
  if (delta <= 7 * 24 * 60 * 60 * 1000) {
    return 20;
  }
  if (delta <= 30 * 24 * 60 * 60 * 1000) {
    return 12;
  }
  return 0;
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

function componentScore(
  haystack: string,
  normalizedQuery: string,
  tokens: string[],
  exactScore: number,
  tokenScore: number,
): number {
  if (!haystack) {
    return 0;
  }
  if (haystack === normalizedQuery) {
    return exactScore;
  }
  if (normalizedQuery && normalizedQuery.includes(haystack)) {
    return Math.floor(exactScore * 0.85);
  }
  if (normalizedQuery && haystack.includes(normalizedQuery)) {
    return Math.floor(exactScore * 0.72);
  }
  return allTokensPresent(haystack, tokens) ? tokenScore : 0;
}

function totalScore(components: SearchResult["scoreComponents"]): number {
  return components.title
    + components.path
    + components.heading
    + components.tag
    + components.lexical
    + components.semantic
    + components.alias
    + components.backlink
    + components.recency;
}

function whyMatched(components: SearchResult["scoreComponents"]): string[] {
  return (Object.keys(components) as Array<keyof SearchResult["scoreComponents"]>).filter(
    (key) => components[key] > 0,
  );
}

function compareSearchResults(left: SearchResult, right: SearchResult): number {
  const scoreDiff = totalScore(right.scoreComponents) - totalScore(left.scoreComponents);
  if (scoreDiff !== 0) {
    return scoreDiff;
  }
  const kindDiff = Number(isAssetPath(left.path)) - Number(isAssetPath(right.path));
  if (kindDiff !== 0) {
    return kindDiff;
  }
  return compareVaultPaths(left.path, right.path) || left.chunkId.localeCompare(right.chunkId);
}

function boundedSnippet(text: string, tokens: string[]): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const firstTokenIndex = tokens
    .map((token) => compact.toLocaleLowerCase().indexOf(token.toLocaleLowerCase()))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  const start = firstTokenIndex === undefined ? 0 : Math.max(0, firstTokenIndex - 60);
  const snippet = compact.slice(start, start + SNIPPET_LIMIT);
  return `${start > 0 ? "..." : ""}${snippet}`.slice(0, SNIPPET_LIMIT);
}

function buildFtsQuery(tokens: string[]): string {
  return tokens.map((token) => `"${token.replace(/"/g, "\"\"")}"`).join(" OR ");
}

function tokenizeQuery(query: string): string[] {
  const matches = query.normalize("NFC").toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return [
    ...new Set(
      matches
        .map((match) => match.replace(/^-+|-+$/g, ""))
        .filter((match) => match && !SEARCH_STOP_WORDS.has(match)),
    ),
  ];
}

function normalizeForSearch(value: string): string {
  return value
    .normalize("NFC")
    .toLocaleLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}/. ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedSql(expression: string): string {
  return `lower(replace(replace(${expression}, '_', ' '), '-', ' '))`;
}

function allTokensPresent(haystack: string, tokens: string[]): boolean {
  if (tokens.length === 0) {
    return false;
  }
  return tokens.every((token) => haystack.includes(normalizeForSearch(token)));
}

function readJsonStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function hasRecencyIntent(query: string): boolean {
  return query
    .normalize("NFC")
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}_-]+/gu)
    ?.some((token) => RECENCY_TOKENS.has(token.replace(/^-+|-+$/g, "")))
    ?? false;
}

function readNewestMtime(db: Database.Database): number {
  const row = db.prepare("select max(mtime_ms) as newest_mtime from files").get() as { newest_mtime: number | null };
  return row.newest_mtime ?? 0;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("select 1 as present from sqlite_schema where type = 'table' and name = ?")
    .get(tableName) as { present: number } | undefined;
  return Boolean(row?.present);
}
