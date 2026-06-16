export type TokenProfile = "search" | "context" | "graph" | "embedding" | "default";

const BASE_STOP_WORDS = new Set([
  "a",
  "about",
  "after",
  "also",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "before",
  "being",
  "between",
  "by",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "i",
  "in",
  "into",
  "is",
  "it",
  "know",
  "me",
  "my",
  "no",
  "not",
  "of",
  "on",
  "or",
  "please",
  "tell",
  "that",
  "the",
  "their",
  "them",
  "then",
  "these",
  "this",
  "those",
  "through",
  "to",
  "what",
  "with",
]);

const PROMPT_CONTROL_STOP_WORDS = new Set([
  "assistant",
  "ignore",
  "instructions",
  "must",
  "previous",
  "prompt",
]);

const GRAPH_STOP_WORDS = wordSet(BASE_STOP_WORDS, PROMPT_CONTROL_STOP_WORDS, [
  "checklist",
  "context",
  "daily",
  "keep",
  "note",
  "notes",
  "review",
  "should",
]);

const PROFILE_STOP_WORDS: Record<TokenProfile, Set<string>> = {
  default: wordSet(BASE_STOP_WORDS, PROMPT_CONTROL_STOP_WORDS),
  search: wordSet(BASE_STOP_WORDS, PROMPT_CONTROL_STOP_WORDS),
  context: wordSet(BASE_STOP_WORDS, PROMPT_CONTROL_STOP_WORDS),
  graph: GRAPH_STOP_WORDS,
  embedding: wordSet(BASE_STOP_WORDS, PROMPT_CONTROL_STOP_WORDS),
};

const SEMANTIC_EQUIVALENTS: Record<string, string[]> = {
  brain: ["knowledge", "memory", "notes", "pkm"],
  current: ["fresh", "latest", "recent"],
  find: ["lookup", "retrieval", "search"],
  fresh: ["current", "latest", "recent"],
  knowledge: ["brain", "memory", "note", "notes", "pkm", "system"],
  latest: ["current", "fresh", "recent"],
  local: ["local-first", "offline", "private"],
  memory: ["brain", "knowledge", "notes", "pkm", "recall", "retrieval"],
  note: ["knowledge", "memory", "notes", "pkm"],
  notes: ["knowledge", "memory", "note", "pkm"],
  offline: ["local", "local-first", "private"],
  personal: ["individual", "local", "pkm", "private"],
  pkm: ["brain", "knowledge", "memory", "note", "notes", "personal", "system"],
  private: ["local", "offline", "personal"],
  recent: ["current", "fresh", "latest"],
  recall: ["memory", "retrieval", "search"],
  retrieval: ["find", "lookup", "memory", "recall", "search"],
  search: ["find", "lookup", "recall", "retrieval"],
  second: ["brain", "pkm"],
  setup: ["stack", "system", "workflow"],
  stack: ["pkm", "setup", "system", "workflow"],
  system: ["knowledge", "pkm", "setup", "stack", "workflow"],
  update: ["current", "latest", "recent"],
  workflow: ["setup", "stack", "system"],
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
  const matches = text.normalize("NFC").toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu);
  if (!matches) {
    return [];
  }
  return [
    ...new Set(
      matches
        .map((token) => token.replace(/^-+|-+$/g, ""))
        .filter((token) => token.length >= minLength && !stopWords.has(token))
        .map((token) => options.stem ? stemToken(token) : token),
    ),
  ];
}

export function tokenizeSearchQuery(query: string): string[] {
  return tokenizeText(query, { profile: "search" });
}

export function significantTokens(text: string): Set<string> {
  return new Set(tokenizeText(text, { profile: "graph", minLength: 4 }));
}

export function semanticTokensForText(text: string): string[] {
  const baseTokens = tokenizeText(text, { profile: "embedding", stem: true });
  const expanded = new Set<string>();
  for (const token of baseTokens) {
    expanded.add(token);
    expanded.add(stemToken(token));
    for (const synonym of SEMANTIC_EQUIVALENTS[token] ?? []) {
      expanded.add(synonym);
      expanded.add(stemToken(synonym));
    }
  }
  return [...expanded].filter(Boolean);
}

export function normalizeForSearch(value: string): string {
  return value
    .normalize("NFC")
    .toLocaleLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}/. ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function simplifyQuery(query: string): string {
  return tokenizeText(query, { profile: "context" }).join(" ");
}

export function hasRecencyIntent(query: string): boolean {
  return tokenizeText(query, { stopWords: [] }).some((token) => RECENCY_TOKENS.has(token));
}

export function stemToken(token: string): string {
  if (token.length <= 4) {
    return token;
  }
  for (const suffix of ["ings", "ing", "edly", "ed", "ies", "s"]) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 4) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

export function characterNgrams(token: string, size: number): string[] {
  if (token.length <= size) {
    return [token];
  }
  const grams: string[] = [];
  for (let index = 0; index <= token.length - size; index += 1) {
    grams.push(token.slice(index, index + size));
  }
  return grams;
}

function wordSet(...groups: Iterable<string>[]): Set<string> {
  const words = new Set<string>();
  for (const group of groups) {
    for (const word of group) {
      words.add(word);
    }
  }
  return words;
}
