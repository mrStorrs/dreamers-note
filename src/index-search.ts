import { evaluateLexicalRetrievalState, searchVaultIndexState } from "./index-query";
import type { LexicalRetrievalCase, RebuildVaultIndexOptions, SearchVaultIndexOptions } from "./index-contracts";
import { rebuildVaultIndexState, refreshVaultIndexState } from "./index-writer";

export * from "./index-contracts";

export function rebuildVaultIndex(options: RebuildVaultIndexOptions) {
  return rebuildVaultIndexState(options);
}

export function refreshVaultIndex(options: RebuildVaultIndexOptions) {
  return refreshVaultIndexState(options);
}

export function searchVaultIndex(options: SearchVaultIndexOptions) {
  return searchVaultIndexState(options);
}

export function evaluateLexicalRetrieval(options: { databasePath: string; cases: LexicalRetrievalCase[] }) {
  return evaluateLexicalRetrievalState(options);
}
