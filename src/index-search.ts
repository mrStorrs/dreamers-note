import type { EmbeddingConfig } from "./embeddings";
import { evaluateHybridRetrievalState, evaluateLexicalRetrievalState, searchVaultIndexState } from "./index-query";
import type { LexicalRetrievalCase, RebuildVaultIndexOptions, SearchVaultIndexOptions } from "./index-contracts";
import { HybridRetrievalCase, listRetrievalFeedback, recordRetrievalFeedback, RetrievalFeedbackInput, RetrievalFeedbackRecord, updateHybridGoldenCases } from "./retrieval-feedback";
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

export function evaluateLexicalRetrieval(options: {
  databasePath: string;
  cases: LexicalRetrievalCase[];
}) {
  return evaluateLexicalRetrievalState(options);
}

export function evaluateHybridRetrieval(options: {
  databasePath: string;
  cases: HybridRetrievalCase[];
  embeddingConfig?: EmbeddingConfig;
}) {
  return evaluateHybridRetrievalState(options);
}

export function recordHybridRetrievalFeedback(options: RetrievalFeedbackInput) {
  return recordRetrievalFeedback(options);
}

export function listHybridRetrievalFeedback(options: { databasePath: string }) {
  return listRetrievalFeedback(options);
}

export {
  HybridRetrievalCase,
  RetrievalFeedbackInput,
  RetrievalFeedbackRecord,
  listRetrievalFeedback,
  recordRetrievalFeedback,
  updateHybridGoldenCases,
};
