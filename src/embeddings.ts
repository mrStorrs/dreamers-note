import crypto from "crypto";
import { spawnSync } from "child_process";
import type { StructuredError } from "./types";

const EMBEDDING_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "the",
  "to",
  "what",
  "with",
]);

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

export interface EmbeddingConfig {
  enabled: boolean;
  provider: "builtin" | "command";
  model: string;
  modelVersion: string;
  dimensions: number;
  command?: string[];
}

export interface StoredEmbeddingRow {
  chunk_id: string;
  relative_path: string;
  content_hash: string;
  vector: string;
  dimensions: number;
  model_name: string;
  model_version: string;
  provider: string;
  policy_hash: string;
}

export interface EmbeddingStatus {
  state: "disabled" | "ready" | "stale" | "unavailable";
  provider?: string;
  modelName?: string;
  modelVersion?: string;
  dimensions?: number;
  indexedChunks: number;
  freshChunks: number;
  staleChunks: number;
  staleReason?: string;
  lastError?: string;
}

export interface EmbeddedChunk {
  chunkId: string;
  relativePath: string;
  contentHash: string;
  vector: number[];
  dimensions: number;
  modelName: string;
  modelVersion: string;
  provider: string;
  policyHash: string;
}

export function embedTexts(
  config: EmbeddingConfig,
  texts: string[],
): { ok: true; value: { vectors: number[][]; dimensions: number } } | { ok: false; error: StructuredError } {
  if (!config.enabled) {
    return {
      ok: false,
      error: {
        code: "embeddings-disabled",
        message: "embeddings are disabled",
      },
    };
  }
  if (config.provider === "command") {
    return commandEmbeddings(config, texts);
  }
  return {
    ok: true,
    value: {
      vectors: texts.map((text) => builtinEmbeddingVector(text, config.dimensions)),
      dimensions: config.dimensions,
    },
  };
}

export function serializeEmbedding(vector: number[]): string {
  return JSON.stringify(vector);
}

export function parseEmbedding(raw: string): number[] {
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? parsed.filter((value): value is number => typeof value === "number") : [];
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function semanticTokensForText(text: string): string[] {
  const baseTokens = tokenize(text);
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

export function chunkContentHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function embeddingPolicyHash(privateGlobs: string[]): string {
  return crypto.createHash("sha256").update(JSON.stringify([...privateGlobs].sort())).digest("hex");
}

export function compareEmbeddingRows(
  row: StoredEmbeddingRow,
  config: EmbeddingConfig | undefined,
  policyHash: string,
): "fresh" | "stale" {
  if (!config || !config.enabled) {
    return "stale";
  }
  return row.provider === config.provider
    && row.model_name === config.model
    && row.model_version === config.modelVersion
    && row.dimensions === config.dimensions
    && row.policy_hash === policyHash
    ? "fresh"
    : "stale";
}

export function normalizeEmbeddingStatus(args: {
  config?: EmbeddingConfig;
  rows: StoredEmbeddingRow[];
  policyHash: string;
  lastState?: string;
  lastError?: string;
}): EmbeddingStatus {
  if (!args.config || !args.config.enabled) {
    return {
      state: "disabled",
      indexedChunks: args.rows.length,
      freshChunks: 0,
      staleChunks: args.rows.length,
    };
  }
  if (args.lastState === "unavailable") {
    return {
      state: "unavailable",
      provider: args.config.provider,
      modelName: args.config.model,
      modelVersion: args.config.modelVersion,
      dimensions: args.config.dimensions,
      indexedChunks: args.rows.length,
      freshChunks: 0,
      staleChunks: args.rows.length,
      lastError: args.lastError,
    };
  }
  if (args.rows.length === 0) {
    return {
      state: "stale",
      provider: args.config.provider,
      modelName: args.config.model,
      modelVersion: args.config.modelVersion,
      dimensions: args.config.dimensions,
      indexedChunks: 0,
      freshChunks: 0,
      staleChunks: 0,
      staleReason: "missing-vectors",
      lastError: args.lastError,
    };
  }
  const freshChunks = args.rows.filter((row) => compareEmbeddingRows(row, args.config, args.policyHash) === "fresh").length;
  const staleChunks = args.rows.length - freshChunks;
  const state = staleChunks > 0 ? "stale" : "ready";
  return {
    state,
    provider: args.config.provider,
    modelName: args.config.model,
    modelVersion: args.config.modelVersion,
    dimensions: args.config.dimensions,
    indexedChunks: args.rows.length,
    freshChunks,
    staleChunks,
    staleReason: state === "stale" ? "config-mismatch" : undefined,
    lastError: args.lastError,
  };
}

function commandEmbeddings(
  config: EmbeddingConfig,
  texts: string[],
): { ok: true; value: { vectors: number[][]; dimensions: number } } | { ok: false; error: StructuredError } {
  if (!config.command || config.command.length === 0) {
    return {
      ok: false,
      error: {
        code: "embeddings-unavailable",
        message: "command embedding provider is missing its command",
      },
    };
  }

  const [command, ...args] = config.command;
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input: JSON.stringify({
      texts,
      model: config.model,
      model_version: config.modelVersion,
      dimensions: config.dimensions,
    }),
  });
  if (result.error) {
    return {
      ok: false,
      error: {
        code: "embeddings-unavailable",
        message: result.error.message,
      },
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      error: {
        code: "embeddings-unavailable",
        message: (result.stderr || result.stdout || `command exited ${result.status}`).trim(),
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "embeddings-unavailable",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  if (
    !isObject(parsed)
    || !Array.isArray(parsed.vectors)
    || typeof parsed.dimensions !== "number"
    || !parsed.vectors.every((vector) => Array.isArray(vector) && vector.every((value) => typeof value === "number"))
  ) {
    return {
      ok: false,
      error: {
        code: "embeddings-unavailable",
        message: "command embedding provider returned invalid JSON",
      },
    };
  }
  const commandResult = parsed as { vectors: number[][]; dimensions: number };
  if (commandResult.vectors.length !== texts.length || commandResult.vectors.some((vector) => vector.length !== commandResult.dimensions)) {
    return {
      ok: false,
      error: {
        code: "embeddings-unavailable",
        message: "command embedding provider returned the wrong vector shape",
      },
    };
  }

  return {
    ok: true,
    value: {
      vectors: commandResult.vectors,
      dimensions: commandResult.dimensions,
    },
  };
}

function builtinEmbeddingVector(text: string, dimensions: number): number[] {
  const vector = new Array(Math.max(8, dimensions)).fill(0);
  const baseTokens = tokenize(text);
  const weightedFeatures = new Map<string, number>();

  for (const token of baseTokens) {
    pushFeature(weightedFeatures, token, 2);
    pushFeature(weightedFeatures, stemToken(token), 1.6);
    for (const synonym of SEMANTIC_EQUIVALENTS[token] ?? []) {
      pushFeature(weightedFeatures, synonym, 1.25);
      pushFeature(weightedFeatures, stemToken(synonym), 0.8);
    }
    if (token.length >= 5) {
      for (const gram of characterNgrams(token, 3)) {
        pushFeature(weightedFeatures, `gram:${gram}`, 0.45);
      }
    }
  }
  for (let index = 0; index < baseTokens.length - 1; index += 1) {
    pushFeature(weightedFeatures, `${baseTokens[index]}:${baseTokens[index + 1]}`, 0.9);
  }

  for (const [feature, weight] of weightedFeatures.entries()) {
    const hash = crypto.createHash("sha256").update(feature).digest();
    const slot = hash.readUInt32BE(0) % vector.length;
    const direction = hash[4] % 2 === 0 ? 1 : -1;
    vector[slot] += weight * direction;
  }

  const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  if (norm === 0) {
    return vector;
  }
  return vector.map((value) => Number((value / norm).toFixed(6)));
}

function tokenize(text: string): string[] {
  const tokens = text
    .normalize("NFC")
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}_-]+/gu);
  if (!tokens) {
    return [];
  }
  return [
    ...new Set(
      tokens
        .map((token) => token.replace(/^-+|-+$/g, ""))
        .filter((token) => token && !EMBEDDING_STOP_WORDS.has(token))
        .map(stemToken),
    ),
  ];
}

function stemToken(token: string): string {
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

function characterNgrams(token: string, size: number): string[] {
  if (token.length <= size) {
    return [token];
  }
  const grams: string[] = [];
  for (let index = 0; index <= token.length - size; index += 1) {
    grams.push(token.slice(index, index + size));
  }
  return grams;
}

function pushFeature(features: Map<string, number>, feature: string, weight: number): void {
  if (!feature) {
    return;
  }
  features.set(feature, (features.get(feature) ?? 0) + weight);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
