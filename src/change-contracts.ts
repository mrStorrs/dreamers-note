import type { StructuredError } from "./types";

export type ChangeStatus = "pending" | "applied" | "rejected";

export interface ChangeCreateInput {
  summary: string;
  writes?: Array<{
    path: string;
    body: string;
    beforeMove?: boolean;
  }>;
  moves?: Array<{
    from: string;
    to: string;
  }>;
}

export interface ChangeWrite {
  path: string;
  beforeHash: string | null;
  body?: string;
  bodyHash: string;
  derived: boolean;
  beforeMove: boolean;
}

export interface ChangeMove {
  from: string;
  to: string;
  sourceBeforeHash: string;
  destinationBeforeHash: string | null;
}

export interface ChangeFingerprint {
  branch: string;
  gitStatusHash: string;
  taxonomyHash: string;
  exclusionConfigHash: string;
}

export interface ChangeFailure {
  code: string;
  message: string;
  affectedPaths?: string[];
}

export interface StoredChange {
  id: string;
  status: ChangeStatus;
  summary: string;
  createdAt: string;
  updatedAt: string;
  revision: string;
  writes: ChangeWrite[];
  moves: ChangeMove[];
  derivedPaths: string[];
  blockers: StructuredError[];
  diffText?: string;
  diffTruncated: boolean;
  diffHash: string;
  fingerprint: ChangeFingerprint;
  lastError?: ChangeFailure;
}

export interface ChangeValidation {
  state: "current" | "blocked";
  blockers: StructuredError[];
}

export interface ChangeView {
  id: string;
  status: ChangeStatus;
  summary: string;
  createdAt: string;
  updatedAt: string;
  revision: string;
  writes: Array<{
    path: string;
    beforeHash: string | null;
    bodyHash: string;
    derived: boolean;
    beforeMove: boolean;
  }>;
  moves: ChangeMove[];
  derivedPaths: string[];
  blockers: StructuredError[];
  lastError?: ChangeFailure;
}

export interface ChangeCreateResult {
  id: string;
  status: "pending";
  revision: string;
  derivedPaths: string[];
  changedPaths: string[];
}

export interface ChangeShowResult {
  change: ChangeView;
  validation: ChangeValidation;
  diff: {
    text: string;
    truncated: boolean;
  };
  page?: {
    path: string;
    offset: number;
    maxChars: number;
    text: string;
    nextOffset: number | null;
    bodyHash: string;
  };
}

export interface ChangeShowOptions {
  path?: string;
  offset?: number;
  maxChars?: number;
}

export interface ChangeListItem {
  id: string;
  status: ChangeStatus;
  summary: string;
  createdAt: string;
  updatedAt: string;
  revision: string;
  changedPaths: string[];
  derivedPaths: string[];
  lastError?: ChangeFailure;
}

export interface ChangeApplyInput {
  id: string;
  revision: string;
}

export interface ChangeApplyResult {
  id: string;
  status: "applied";
  changedPaths: string[];
}
