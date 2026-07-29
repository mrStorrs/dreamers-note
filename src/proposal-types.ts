import type { ConventionPolicy } from "./conventions";

export interface ProposalEnvironment {
  rootDir: string;
  vaultPath: string;
  databasePath: string;
  runtimeLogPath: string;
  privateGlobs: string[];
  approvedTags: string[];
  conventionPolicy: ConventionPolicy;
}

export interface ProposalToolOptions {
  writeEnabled?: boolean;
}

export interface DirectoryIndexRefreshProposalInput {
  paths: string[];
  rationale: string;
}

export interface ProposalCreateInput {
  operation: string;
  bundleId?: string;
  contextPackId?: string;
  sourceChunkIds: string[];
  candidatePaths?: string[];
  approvedTags?: string[];
  proposedTagGaps?: string[];
  unresolvedQuestions?: string[];
  validationBlockers?: string[];
  dependencies?: string[];
  rationale: string;
  placementScorecard?: Record<string, unknown>;
  placementDebt?: {
    originalText: string;
    ambiguityReason: string;
    reviewDueAt?: string;
    candidateDestinations: Array<{
      path: string;
      title?: string;
      reason?: string;
      anchorHeading?: string;
    }>;
  };
  evidence?: Array<{
    path: string;
    chunkId?: string;
    headingPath?: string;
    excerpt?: string;
    provenance?: "external-file";
  }>;
  pathActions?: Array<{
    type: "move" | "delete-file";
    scope?: "vault" | "external";
    path: string;
    destinationPath?: string;
  }>;
  targets: Array<{
    path: string;
    mode?: "create" | "replace";
    body: string;
  }>;
}

export interface ProposalTarget {
  path: string;
  mode: "create" | "replace";
  body?: string;
  legacyPatch?: {
    start: number;
    end: number;
    insertText: string;
  };
  beforeHash: string | null;
  bodyHash: string;
}

export interface ProposalEvidence {
  path: string;
  chunkId?: string;
  headingPath?: string;
  excerpt?: string;
  provenance?: "indexed-vault" | "external-file";
}

export interface ProposalMovePathAction {
  type: "move";
  scope: "vault";
  path: string;
  destinationPath: string;
  beforeHash: string;
  destinationBeforeHash: string | null;
}

export interface ProposalExternalDeletePathAction {
  type: "delete-file";
  scope: "external";
  path: string;
  beforeHash: string;
}

export type ProposalPathAction = ProposalMovePathAction | ProposalExternalDeletePathAction;

export interface ProposalPlacementDestination {
  path: string;
  title?: string;
  reason?: string;
  anchorHeading?: string;
}

export interface ProposalPlacementDebt {
  originalText?: string;
  ambiguityReason: string;
  reviewDueAt: string;
  candidateDestinations: ProposalPlacementDestination[];
}

export interface ProposalLineage {
  indexGeneration: string;
  sourceHashes: Record<string, string>;
  externalSourceHashes: Record<string, string>;
  candidateHashes: Record<string, string | null>;
  taxonomyHash: string;
  exclusionConfigHash: string;
  contextPackId?: string;
  sourceChunkIds: string[];
  collisionSearchInputs: string[];
  beforeHashes: Record<string, string | null>;
  gitBranch?: string;
  gitStatusHash?: string;
}

export interface StoredProposal {
  proposalId: string;
  bundleId?: string;
  operation: string;
  status: "pending" | "rejected" | "applied" | "failed" | "expired";
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  targetPaths: string[];
  candidatePaths: string[];
  sourcePaths: string[];
  approvedTags: string[];
  proposedTagGaps: string[];
  unresolvedQuestions: string[];
  validationBlockers: string[];
  dependencies: string[];
  rationale: string;
  placementScorecard?: Record<string, unknown>;
  placementDebt?: ProposalPlacementDebt;
  evidence: ProposalEvidence[];
  pathActions: ProposalPathAction[];
  targets: ProposalTarget[];
  lineage: ProposalLineage;
  diffHash: string;
  lastError?: string;
}

export interface ProposalAuthorization {
  authorizationId: string;
  proposalId: string;
  proposalRevision: number;
  diffHash: string;
  targetPaths: string[];
  beforeHashes: Record<string, string | null>;
  gitBranch?: string;
  gitStatusHash?: string;
  taxonomyHash: string;
  exclusionConfigHash: string;
  createdAt: string;
  usedAt?: string;
}

export interface ProposalValidation {
  state: "current" | "blocked";
  blockers: Array<{ code: string; message: string; path?: string }>;
  diffHash: string;
}
