export { loadVaultConfig, validateVaultConfig } from "./config";
export type { LoadVaultConfigOptions, ValidateVaultConfigOptions, VaultConfig } from "./config";
export { loadApprovedTagList, loadConventionPolicy } from "./conventions";
export type { ConventionPath, ConventionPolicy, LoadConventionPolicyOptions } from "./conventions";
export * from "./embeddings";
export { compareVaultPaths, fileHash, isAssetPath, scanVaultEntries } from "./files";
export type { ListVaultFilesOptions, VaultEntry, VaultExclusion, VaultScanResult } from "./files";
export { inspectImportSource } from "./import-source";
export type { ImportSourceInspection, InspectImportSourceOptions } from "./import-source";
export * from "./index-search";
export * from "./markdown";
export * from "./mcp-surface";
export {
  inspectContextSource,
  readContext,
  relatedContext,
  searchContext,
} from "./context-service";
export type {
  ContextSearchInput,
  ContextSearchResult,
  ContextSourceInspection,
  InspectContextSourceInput,
  ReadContextInput,
  ReadContextResult,
  RelatedContextInput,
} from "./context-service";
export { classifyVaultPath, inspectPathPolicy, privateGlobMatches } from "./path-safety";
export type {
  PathClassificationOptions,
  PathPolicyInspection,
  PathPolicyInspectionOptions,
  VaultPath,
} from "./path-safety";
export { initializeRuntimeState, loadRuntimeConfig, resolveRuntimeDataDir } from "./runtime";
export type { LoadRuntimeConfigOptions, RuntimeConfig, RuntimeState } from "./runtime";
export { ensureRuntimeReady, inspectRuntimeReadiness } from "./runtime-readiness";
export type {
  RuntimeFreshness,
  RuntimeReadiness,
  RuntimeReadinessAction,
  RuntimeReadinessState,
} from "./runtime-readiness";
export { reviewContext } from "./review-service";
export type { ReviewContextInput, ReviewContextResult, ReviewKind } from "./review-service";
export { applyChange, createChange, listChanges, rejectChange, showChange } from "./change-service";
export type {
  ChangeApplyInput,
  ChangeApplyResult,
  ChangeCreateInput,
  ChangeCreateResult,
  ChangeFailure,
  ChangeFingerprint,
  ChangeListItem,
  ChangeShowResult,
  ChangeStatus,
  ChangeValidation,
  ChangeView,
  ChangeWrite,
  ChangeMove,
  StoredChange,
} from "./change-contracts";
export * from "./types";
export { loadVaultEnvironment } from "./vault-environment";
export type { LoadVaultEnvironmentOptions, VaultEnvironment } from "./vault-environment";
