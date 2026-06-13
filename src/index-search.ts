import { evaluateLexicalRetrievalState, searchVaultIndexState } from "./index-query";
import { rebuildVaultIndexState, refreshVaultIndexState } from "./index-writer";

export interface IndexedFile {
  relativePath: string;
  kind: "note" | "asset";
  hash: string;
}

export interface ExcludedFile {
  relativePath: string;
  reason: string;
}

export interface Tombstone {
  relativePath: string;
  previousHash?: string;
  reason: "deleted" | "excluded" | "renamed";
  newPath?: string;
}

export interface RebuildVaultIndexOptions {
  vaultPath: string;
  databasePath: string;
  privateGlobs?: string[];
  approvedTags?: Set<string> | string[];
  selectedPaths?: string[];
}

export interface RebuildVaultIndexResult {
  indexedFiles: IndexedFile[];
  excludedFiles: ExcludedFile[];
  warnings: Array<{ relativePath: string; code: string; message: string }>;
}

export interface RefreshVaultIndexResult extends RebuildVaultIndexResult {
  updatedPaths: string[];
  deletedPaths: string[];
  excludedPaths: string[];
  tombstones: Tombstone[];
}

export interface SearchVaultIndexOptions {
  databasePath: string;
  query: string;
  limit?: number;
}

export interface SearchResult {
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
    backlink: number;
  };
  why_matched: string[];
}

export interface SearchVaultIndexResult {
  results: SearchResult[];
}

export interface LexicalRetrievalCase {
  name: string;
  query: string;
  expectedPaths?: string[];
  expectNoSourceGap?: boolean;
}

export interface LexicalRetrievalEvaluation {
  results: Array<{
    name: string;
    topPath?: string;
    noSourceGap: boolean;
    passed: boolean;
    deterministic: boolean;
    whyMatched: string[];
  }>;
}

export function rebuildVaultIndex(options: RebuildVaultIndexOptions) {
  return rebuildVaultIndexState(options);
}

export function refreshVaultIndex(options: RebuildVaultIndexOptions) {
  return refreshVaultIndexState(options);
}

export function searchVaultIndex(options: SearchVaultIndexOptions) {
  return searchVaultIndexState(options);
}

export function evaluateLexicalRetrieval(options: {
  databasePath: string;
  cases: LexicalRetrievalCase[];
}) {
  return evaluateLexicalRetrievalState(options);
}
