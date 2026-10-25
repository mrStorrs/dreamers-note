import { compareVaultPaths, isAssetPath } from "./files";
import type { SearchResult } from "./index-contracts";
import { hasRecencyIntent, normalizeForSearch } from "./text-prep";

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

const SNIPPET_LIMIT = 240;

export function rankSearchCandidates(options: { rows: PreparedSearchCandidateRow[]; query: string; tokens: string[]; newestMtime: number; limit: number }): SearchResult[] {
  const distinct = new Map<string, PreparedSearchCandidateRow>();
  for (const row of options.rows) if (!distinct.has(row.candidate_id)) distinct.set(row.candidate_id, row);
  return [...distinct.values()].map((row) => scoreCandidate(row, options.query, options.tokens, options.newestMtime))
    .filter((item) => totalScore(item.scoreComponents) > 0)
    .sort(compareSearchResults)
    .slice(0, options.limit);
}

function scoreCandidate(row: PreparedSearchCandidateRow, query: string, tokens: string[], newestMtime: number): SearchResult {
  const normalizedQuery = normalizeForSearch(query);
  const tags = readJsonStringArray(row.approved_tags).map(normalizeForSearch);
  const pathText = normalizeForSearch(row.relative_path);
  const titleText = normalizeForSearch(row.title);
  const headingText = normalizeForSearch(row.heading_path);
  const bodyText = normalizeForSearch(row.body);
  const aliasText = normalizeForSearch(row.alias_terms);
  const scoreComponents = {
    title: componentScore(titleText, normalizedQuery, tokens, row.result_kind === "asset" ? 90 : 100, 55),
    path: componentScore(pathText, normalizedQuery, tokens, row.result_kind === "asset" ? 70 : 60, 24),
    heading: row.result_kind === "asset" ? 0 : componentScore(headingText, normalizedQuery, tokens, 45, 18),
    tag: row.result_kind === "asset" ? 0 : tagScore(tags, normalizedQuery, tokens),
    lexical: lexicalScore(row, normalizedQuery, tokens, bodyText),
    alias: row.result_kind === "asset" ? 0 : componentScore(aliasText, normalizedQuery, tokens, 55, 18),
    backlink: row.backlink_match && tokens.length ? 25 : 0,
    recency: recencyScore(row.mtime_ms, query, newestMtime),
  };
  return {
    path: row.relative_path,
    title: row.title,
    headingPath: row.heading_path,
    chunkId: row.candidate_id,
    snippet: boundedSnippet(row.result_kind === "asset" ? row.body : row.body.replace(/\s+/g, " ").trim(), tokens),
    freshness: row.freshness,
    scoreComponents,
    whyMatched: (Object.keys(scoreComponents) as Array<keyof typeof scoreComponents>).filter((key) => scoreComponents[key] > 0),
  };
}

function lexicalScore(row: PreparedSearchCandidateRow, query: string, tokens: string[], body: string): number {
  if (row.result_kind === "asset") {
    return row.lexical_match > 0 && allTokensPresent(body, tokens) ? 30 : 0;
  }
  if (query && body.includes(query)) return 40;
  if (!row.lexical_match) return 0;
  if (allTokensPresent(body, tokens)) return 30;
  return tokens.filter((token) => body.includes(normalizeForSearch(token))).length >= Math.min(tokens.length, 2) ? 24 : 0;
}

function tagScore(tags: string[], query: string, tokens: string[]): number {
  return tags.some((tag) => componentScore(tag, query, tokens, 35, 18) > 0) ? 35 : 0;
}

function recencyScore(mtimeMs: number, query: string, newestMtime: number): number {
  if (!hasRecencyIntent(query) || !mtimeMs || !newestMtime) return 0;
  const delta = newestMtime - mtimeMs;
  return delta <= 7 * 86_400_000 ? 20 : delta <= 30 * 86_400_000 ? 12 : 0;
}

function componentScore(haystack: string, query: string, tokens: string[], exact: number, token: number): number {
  if (!haystack) return 0;
  if (haystack === query) return exact;
  if (query && query.includes(haystack)) return Math.floor(exact * 0.85);
  if (query && haystack.includes(query)) return Math.floor(exact * 0.72);
  return allTokensPresent(haystack, tokens) ? token : 0;
}

function totalScore(components: SearchResult["scoreComponents"]): number {
  return Object.values(components).reduce((total, value) => total + value, 0);
}

function compareSearchResults(left: SearchResult, right: SearchResult): number {
  const score = totalScore(right.scoreComponents) - totalScore(left.scoreComponents);
  if (score) return score;
  const kind = Number(isAssetPath(left.path)) - Number(isAssetPath(right.path));
  return kind || compareVaultPaths(left.path, right.path) || left.chunkId.localeCompare(right.chunkId);
}

function boundedSnippet(text: string, tokens: string[]): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const first = tokens.map((token) => compact.toLocaleLowerCase().indexOf(token.toLocaleLowerCase())).filter((index) => index >= 0).sort((left, right) => left - right)[0];
  const start = first === undefined ? 0 : Math.max(0, first - 60);
  return `${start ? "..." : ""}${compact.slice(start, start + SNIPPET_LIMIT)}`.slice(0, SNIPPET_LIMIT);
}

function allTokensPresent(haystack: string, tokens: string[]): boolean {
  return tokens.length > 0 && tokens.every((token) => haystack.includes(normalizeForSearch(token)));
}

function readJsonStringArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
