import { compareVaultPaths, isAssetPath } from "./files";
import type { SearchResult } from "./index-contracts";
import { hasRecencyIntent, normalizeForSearch, semanticTokensForText } from "./text-prep";

export interface SearchCandidateRow {
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

export interface PreparedSearchCandidateRow extends SearchCandidateRow {
  freshness: SearchResult["freshness"];
}

interface SearchCandidate extends PreparedSearchCandidateRow {
  snippetBody: string;
}

const SNIPPET_LIMIT = 240;
const SEMANTIC_THRESHOLD = 0.22;

export function rankSearchCandidates(options: {
  rows: PreparedSearchCandidateRow[];
  query: string;
  tokens: string[];
  semanticScores: Map<string, number>;
  newestMtime: number;
  limit: number;
}): SearchResult[] {
  return mergeCandidates(options.rows)
    .map((row) => toCandidate(row))
    .map((row) =>
      scoreCandidate(
        row,
        options.query,
        options.tokens,
        options.semanticScores.get(row.candidate_id) ?? 0,
        options.newestMtime,
      ))
    .filter((result) => totalScore(result.scoreComponents) > 0)
    .sort(compareSearchResults)
    .slice(0, options.limit);
}

function mergeCandidates(rows: PreparedSearchCandidateRow[]): PreparedSearchCandidateRow[] {
  const merged = new Map<string, PreparedSearchCandidateRow>();
  for (const row of rows) {
    if (!merged.has(row.candidate_id)) {
      merged.set(row.candidate_id, row);
    }
  }
  return [...merged.values()];
}

function toCandidate(row: PreparedSearchCandidateRow): SearchCandidate {
  return {
    ...row,
    snippetBody: row.result_kind === "asset" ? row.body : row.body.replace(/\s+/g, " ").trim(),
  };
}

function scoreCandidate(
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
  const scoreComponents = {
    title: componentScore(titleText, normalizedQuery, tokens, row.result_kind === "asset" ? 90 : 100, 55),
    path: componentScore(pathText, normalizedQuery, tokens, row.result_kind === "asset" ? 70 : 60, 24),
    heading: row.result_kind === "asset" ? 0 : componentScore(headingText, normalizedQuery, tokens, 45, 18),
    tag: row.result_kind === "asset" ? 0 : tags.some((tag) => tokens.includes(normalizeForSearch(tag))) ? 35 : 0,
    lexical: lexicalScore(row, normalizedQuery, tokens, bodyText),
    semantic: row.result_kind === "asset" || row.freshness.state !== "fresh" ? 0 : semanticComponent(semanticSimilarity, query, row),
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
    freshness: row.freshness,
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
  if (row.lexical_match <= 0) {
    return 0;
  }
  if (allTokensPresent(bodyText, tokens)) {
    return 30;
  }
  const presentTokenCount = tokens.filter((token) => bodyText.includes(normalizeForSearch(token))).length;
  return presentTokenCount >= Math.min(tokens.length, 2) ? 24 : 0;
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
