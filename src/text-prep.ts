export type TokenProfile = "search" | "context" | "graph" | "default";

const BASE_STOP_WORDS = new Set([
  "a", "about", "after", "also", "an", "and", "are", "as", "at", "be", "been", "before", "being", "between", "by",
  "do", "does", "for", "from", "had", "has", "have", "how", "i", "in", "into", "is", "it", "know", "me", "my",
  "no", "not", "of", "on", "or", "please", "tell", "that", "the", "their", "them", "then", "these", "this", "those",
  "through", "to", "what", "with",
]);
const PROMPT_CONTROL_WORDS = new Set(["assistant", "ignore", "instructions", "must", "previous", "prompt"]);
const GRAPH_STOP_WORDS = wordSet(BASE_STOP_WORDS, PROMPT_CONTROL_WORDS, ["checklist", "context", "daily", "keep", "note", "notes", "review", "should"]);
const PROFILE_STOP_WORDS: Record<TokenProfile, Set<string>> = {
  default: wordSet(BASE_STOP_WORDS, PROMPT_CONTROL_WORDS),
  search: wordSet(BASE_STOP_WORDS, PROMPT_CONTROL_WORDS),
  context: wordSet(BASE_STOP_WORDS, PROMPT_CONTROL_WORDS),
  graph: GRAPH_STOP_WORDS,
};
const RECENCY_TOKENS = new Set(["current", "fresh", "latest", "new", "recent", "updated"]);

export interface TokenizeTextOptions {
  minLength?: number;
  profile?: TokenProfile;
  stem?: boolean;
  stopWords?: Iterable<string>;
}

export function tokenizeText(text: string, options: TokenizeTextOptions = {}): string[] {
  const stopWords = new Set(options.stopWords ?? PROFILE_STOP_WORDS[options.profile ?? "default"]);
  const minLength = options.minLength ?? 1;
  const matches = text.normalize("NFC").toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return [...new Set(matches
    .map((token) => token.replace(/^-+|-+$/g, ""))
    .filter((token) => token.length >= minLength && !stopWords.has(token))
    .map((token) => options.stem ? stemToken(token) : token))];
}

export function tokenizeSearchQuery(query: string): string[] {
  return tokenizeText(query, { profile: "search" });
}

export function significantTokens(text: string): Set<string> {
  return new Set(tokenizeText(text, { profile: "graph", minLength: 4 }));
}

export function normalizeForSearch(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase().replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}/. ]+/gu, " ").replace(/\s+/g, " ").trim();
}

export function simplifyQuery(query: string): string {
  return tokenizeText(query, { profile: "context" }).join(" ");
}

export function hasRecencyIntent(query: string): boolean {
  return tokenizeText(query, { stopWords: [] }).some((token) => RECENCY_TOKENS.has(token));
}

export function stemToken(token: string): string {
  if (token.length <= 4) return token;
  for (const suffix of ["ings", "ing", "edly", "ed", "ies", "s"]) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 4) return token.slice(0, -suffix.length);
  }
  return token;
}

function wordSet(...groups: Iterable<string>[]): Set<string> {
  return new Set(groups.flatMap((group) => [...group]));
}
