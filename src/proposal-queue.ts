import crypto from "crypto";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import Database from "better-sqlite3";
import { compareVaultPaths, fileHash } from "./files";
import { openIndexDatabase, recordOperation, secureRuntimeFiles, SqliteDatabase } from "./index-db";
import { refreshVaultIndex } from "./index-search";
import { classifyVaultPath, EXCLUDED_PATH_PARTS } from "./path-safety";
import { Result, StructuredError } from "./types";

const PROPOSAL_EXCERPT_LIMIT = 240;
const DEFAULT_EXPIRY_DAYS = 7;
const LOCK_STALE_MS = 10_000;
const FAILURE_HOOK_ENV = "DREAMERS_NOTE_TEST_FAIL_AFTER_WRITE";

export interface ProposalEnvironment {
  rootDir: string;
  vaultPath: string;
  databasePath: string;
  runtimeLogPath: string;
  privateGlobs: string[];
  approvedTags: string[];
}

export interface ProposalToolOptions {
  writeEnabled?: boolean;
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
  }>;
  targets: Array<{
    path: string;
    mode?: "create" | "replace";
    body: string;
  }>;
}

interface ProposalTarget {
  path: string;
  mode: "create" | "replace";
  body?: string;
  editSpec?: {
    start: number;
    end: number;
    insertText: string;
  };
  beforeHash: string | null;
  bodyHash: string;
}

interface ProposalEvidence {
  path: string;
  chunkId?: string;
  headingPath?: string;
  excerpt?: string;
}

interface ProposalPlacementDestination {
  path: string;
  title?: string;
  reason?: string;
  anchorHeading?: string;
}

interface ProposalPlacementDebt {
  originalText?: string;
  ambiguityReason: string;
  reviewDueAt: string;
  candidateDestinations: ProposalPlacementDestination[];
}

interface ProposalLineage {
  indexGeneration: string;
  sourceHashes: Record<string, string>;
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

interface StoredProposal {
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
  targets: ProposalTarget[];
  lineage: ProposalLineage;
  diffHash: string;
  lastError?: string;
}

interface ProposalAuthorization {
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

interface LockHandle {
  lockPath: string;
  fd: number;
}

export function sanitizeProposalLogEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const key of ["eventType", "proposalId", "path", "hash", "durationMs", "outcome"]) {
    if (entry[key] !== undefined) {
      sanitized[key] = entry[key];
    }
  }
  return sanitized;
}

export function createStoredProposal(
  environment: ProposalEnvironment,
  input: ProposalCreateInput,
  options: ProposalToolOptions = {},
): Result<{
  proposalId: string;
  bundleId?: string;
  status: string;
  revision: number;
  targetPaths: string[];
  validation: ProposalValidation;
}> {
  if (!options.writeEnabled) {
    return fail("write-disabled", "proposal_create requires --write-enabled mode");
  }

  const startedAt = Date.now();
  const refreshed = refreshVaultIndex({
    vaultPath: environment.vaultPath,
    databasePath: environment.databasePath,
    privateGlobs: environment.privateGlobs,
    approvedTags: environment.approvedTags,
  });
  if (!refreshed.ok) {
    return {
      ok: false,
      error: refreshed.error,
    };
  }

  const normalizedInput = normalizeCreateInput(environment, input);
  if (!normalizedInput.ok) {
    return normalizedInput;
  }

  const db = openIndexDatabase(environment.databasePath);
  try {
    const gitState = readVaultGitState(environment.vaultPath);
    if (!gitState.ok) {
      return gitState;
    }
    const proposalId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const indexGeneration = readMetaValue(db, "index_generation");
    if (!indexGeneration) {
      return fail("index-generation-missing", "index generation is unavailable");
    }
    const taxonomyHash = approvedTagsHash(environment.approvedTags);
    const exclusionConfigHash = exclusionConfigHashFor(environment.privateGlobs);
    const beforeHashes = Object.fromEntries(
      normalizedInput.value.targets.map((target) => [target.path, target.beforeHash]),
    );
    const lineage: ProposalLineage = {
      indexGeneration,
      sourceHashes: normalizedInput.value.sourceHashes,
      candidateHashes: normalizedInput.value.candidateHashes,
      taxonomyHash,
      exclusionConfigHash,
      contextPackId: normalizedInput.value.contextPackId,
      sourceChunkIds: normalizedInput.value.sourceChunkIds,
      collisionSearchInputs: normalizedInput.value.candidatePaths,
      beforeHashes,
      gitBranch: gitState.value.branch,
      gitStatusHash: gitState.value.statusHash,
    };
    const stored: StoredProposal = {
      proposalId,
      bundleId: normalizedInput.value.bundleId,
      operation: normalizedInput.value.operation,
      status: "pending",
      revision: 1,
      createdAt,
      updatedAt: createdAt,
      expiresAt,
      targetPaths: normalizedInput.value.targets.map((target) => target.path).sort(compareVaultPaths),
      candidatePaths: normalizedInput.value.candidatePaths,
      sourcePaths: Object.keys(normalizedInput.value.sourceHashes).sort(compareVaultPaths),
      approvedTags: normalizedInput.value.approvedTags,
      proposedTagGaps: normalizedInput.value.proposedTagGaps,
      unresolvedQuestions: normalizedInput.value.unresolvedQuestions,
      validationBlockers: normalizedInput.value.validationBlockers,
      dependencies: normalizedInput.value.dependencies,
      rationale: normalizedInput.value.rationale,
      placementScorecard: normalizedInput.value.placementScorecard,
      placementDebt: normalizedInput.value.placementDebt,
      evidence: normalizedInput.value.evidence,
      targets: normalizedInput.value.targets,
      lineage,
      diffHash: computeDiffHash(normalizedInput.value.targets),
    };
    const insert = db.prepare(
      [
        "insert into proposals",
        "(",
        "proposal_id, bundle_id, operation, status, revision, created_at, updated_at, expires_at,",
        "target_paths, source_paths, candidate_paths, dependencies, approved_tags, proposed_tag_gaps,",
        "unresolved_questions, validation_blockers, rationale, placement_scorecard, placement_debt, evidence, targets, lineage, diff_hash, last_error",
        ") values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ].join(" "),
    );
    insert.run(
      stored.proposalId,
      stored.bundleId ?? null,
      stored.operation,
      stored.status,
      stored.revision,
      stored.createdAt,
      stored.updatedAt,
      stored.expiresAt ?? null,
      stringifyJson(stored.targetPaths),
      stringifyJson(stored.sourcePaths),
      stringifyJson(stored.candidatePaths),
      stringifyJson(stored.dependencies),
      stringifyJson(stored.approvedTags),
      stringifyJson(stored.proposedTagGaps),
      stringifyJson(stored.unresolvedQuestions),
      stringifyJson(stored.validationBlockers),
      stored.rationale,
      stringifyJson(stored.placementScorecard ?? {}),
      stringifyJson(stored.placementDebt ?? null),
      stringifyJson(stored.evidence),
      stringifyJson(stored.targets),
      stringifyJson(stored.lineage),
      stored.diffHash,
      null,
    );
    recordOperation(db, "proposal-create", `${stored.proposalId} (${stored.targetPaths.length} paths)`);
    appendProposalLog(environment.runtimeLogPath, {
      eventType: "proposal-create",
      proposalId: stored.proposalId,
      path: stored.targetPaths[0],
      hash: stored.diffHash,
      durationMs: Date.now() - startedAt,
      outcome: "success",
    });
    const validation = validateStoredProposal(db, environment, stored);
    return {
      ok: true,
      value: {
        proposalId: stored.proposalId,
        bundleId: stored.bundleId,
        status: stored.status,
        revision: stored.revision,
        targetPaths: stored.targetPaths,
        validation,
      },
    };
  } catch (error) {
    return unexpected("proposal-create-failed", error);
  } finally {
    db.close();
    secureRuntimeFiles(environment.databasePath);
  }
}

export function listStoredProposals(options: {
  databasePath: string;
}): Result<{
  items: Array<{
    proposalId: string;
    bundleId?: string;
    operation: string;
    status: string;
    revision: number;
    targetPaths: string[];
    dependencies: string[];
    createdAt: string;
    updatedAt: string;
    expiresAt?: string;
    placementDebt?: {
      ambiguityReason: string;
      reviewDueAt: string;
      candidateDestinations: ProposalPlacementDestination[];
    };
  }>;
}> {
  const db = openIndexDatabase(options.databasePath);
  try {
    const rows = db.prepare("select * from proposals order by created_at asc, proposal_id asc").all() as ProposalRow[];
    return {
      ok: true,
      value: {
        items: rows.map((row) => {
          const proposal = hydrateProposalRow(row);
          return {
            proposalId: proposal.proposalId,
            bundleId: proposal.bundleId,
            operation: proposal.operation,
            status: proposal.status,
            revision: proposal.revision,
            targetPaths: proposal.targetPaths,
            dependencies: proposal.dependencies,
            createdAt: proposal.createdAt,
            updatedAt: proposal.updatedAt,
            expiresAt: proposal.expiresAt,
            placementDebt: proposal.placementDebt
              ? {
                  ambiguityReason: proposal.placementDebt.ambiguityReason,
                  reviewDueAt: proposal.placementDebt.reviewDueAt,
                  candidateDestinations: proposal.placementDebt.candidateDestinations,
                }
              : undefined,
          };
        }),
      },
    };
  } catch (error) {
    return unexpected("proposal-list-failed", error);
  } finally {
    db.close();
    secureRuntimeFiles(options.databasePath);
  }
}

export function readStoredProposal(
  environment: ProposalEnvironment,
  proposalId: string,
): Result<{
  proposal: StoredProposal & { targets: ProposalTarget[]; evidence: ProposalEvidence[] };
  validation: ProposalValidation;
  diffPreview: Array<{ path: string; preview: string; truncated: boolean }>;
}> {
  const db = openIndexDatabase(environment.databasePath);
  try {
    const proposal = loadProposalById(db, proposalId);
    if (!proposal.ok) {
      return proposal;
    }
    const validation = validateStoredProposal(db, environment, proposal.value);
    appendProposalLog(environment.runtimeLogPath, {
      eventType: "proposal-read",
      proposalId: proposal.value.proposalId,
      path: proposal.value.targetPaths[0],
      hash: proposal.value.diffHash,
      durationMs: 0,
      outcome: "success",
    });
    return {
      ok: true,
      value: {
        proposal: proposal.value,
        validation,
        diffPreview: buildDiffPreview(environment, proposal.value.targets),
      },
    };
  } catch (error) {
    return unexpected("proposal-read-failed", error);
  } finally {
    db.close();
    secureRuntimeFiles(environment.databasePath);
  }
}

export function rejectStoredProposal(
  environment: ProposalEnvironment,
  proposalId: string,
  reason?: string,
  options: ProposalToolOptions = {},
): Result<{ proposalId: string; status: string }> {
  if (!options.writeEnabled) {
    return fail("write-disabled", "proposal_reject requires --write-enabled mode");
  }
  const db = openIndexDatabase(environment.databasePath);
  try {
    const proposal = loadProposalById(db, proposalId);
    if (!proposal.ok) {
      return proposal;
    }
    const updated = redactProposalContent({
      ...proposal.value,
      status: "rejected",
      revision: proposal.value.revision + 1,
      updatedAt: new Date().toISOString(),
      lastError: reason,
    });
    writeProposalRow(db, updated);
    recordOperation(db, "proposal-reject", `${proposalId}`);
    appendProposalLog(environment.runtimeLogPath, {
      eventType: "proposal-reject",
      proposalId,
      path: updated.targetPaths[0],
      hash: updated.diffHash,
      durationMs: 0,
      outcome: "success",
    });
    return {
      ok: true,
      value: {
        proposalId,
        status: updated.status,
      },
    };
  } catch (error) {
    return unexpected("proposal-reject-failed", error);
  } finally {
    db.close();
    secureRuntimeFiles(environment.databasePath);
  }
}

export function authorizeStoredProposal(
  environment: ProposalEnvironment,
  proposalId: string,
  options: ProposalToolOptions = {},
): Result<{
  proposalId: string;
  authorizationId: string;
  revision: number;
  diffHash: string;
  targetPaths: string[];
}> {
  if (!options.writeEnabled) {
    return fail("write-disabled", "proposal_authorize requires --write-enabled mode");
  }
  const startedAt = Date.now();
  const db = openIndexDatabase(environment.databasePath);
  try {
    const proposal = loadProposalById(db, proposalId);
    if (!proposal.ok) {
      return proposal;
    }
    if (proposal.value.status !== "pending") {
      return fail("proposal-not-pending", "proposal is not pending", { path: proposalId });
    }
    const validation = validateStoredProposal(db, environment, proposal.value);
    if (validation.state !== "current") {
      appendProposalLog(environment.runtimeLogPath, {
        eventType: "proposal-authorize",
        proposalId,
        path: proposal.value.targetPaths[0],
        hash: proposal.value.diffHash,
        durationMs: Date.now() - startedAt,
        outcome: "refused",
      });
      return {
        ok: false,
        error: {
          code: "proposal-not-current",
          message: "proposal is not current",
          causes: validation.blockers,
        },
      };
    }
    const authorizationId = crypto.randomUUID();
    const authorization: ProposalAuthorization = {
      authorizationId,
      proposalId,
      proposalRevision: proposal.value.revision,
      diffHash: proposal.value.diffHash,
      targetPaths: proposal.value.targetPaths,
      beforeHashes: proposal.value.lineage.beforeHashes,
      gitBranch: proposal.value.lineage.gitBranch,
      gitStatusHash: proposal.value.lineage.gitStatusHash,
      taxonomyHash: proposal.value.lineage.taxonomyHash,
      exclusionConfigHash: proposal.value.lineage.exclusionConfigHash,
      createdAt: new Date().toISOString(),
      usedAt: undefined,
    };
    db.prepare(
      [
        "insert into proposal_authorizations",
        "(",
        "authorization_id, proposal_id, proposal_revision, diff_hash, target_paths, before_hashes,",
        "git_branch, git_status_hash, taxonomy_hash, exclusion_config_hash, created_at, used_at",
        ") values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ].join(" "),
    ).run(
      authorization.authorizationId,
      authorization.proposalId,
      authorization.proposalRevision,
      authorization.diffHash,
      stringifyJson(authorization.targetPaths),
      stringifyJson(authorization.beforeHashes),
      authorization.gitBranch ?? null,
      authorization.gitStatusHash ?? null,
      authorization.taxonomyHash,
      authorization.exclusionConfigHash,
      authorization.createdAt,
      null,
    );
    recordOperation(db, "proposal-authorize", `${proposalId}`);
    appendProposalLog(environment.runtimeLogPath, {
      eventType: "proposal-authorize",
      proposalId,
      path: proposal.value.targetPaths[0],
      hash: proposal.value.diffHash,
      durationMs: Date.now() - startedAt,
      outcome: "success",
    });
    return {
      ok: true,
      value: {
        proposalId,
        authorizationId,
        revision: proposal.value.revision,
        diffHash: proposal.value.diffHash,
        targetPaths: proposal.value.targetPaths,
      },
    };
  } catch (error) {
    return unexpected("proposal-authorize-failed", error);
  } finally {
    db.close();
    secureRuntimeFiles(environment.databasePath);
  }
}

export function applyStoredProposal(
  environment: ProposalEnvironment,
  proposalId: string,
  authorizationId: string | undefined,
  options: ProposalToolOptions = {},
): Result<{
  proposalId: string;
  status: string;
  changedPaths: string[];
  git: {
    status: string;
    reviewCommands: string[];
  };
}> {
  if (!options.writeEnabled) {
    return fail("write-disabled", "proposal_apply requires --write-enabled mode");
  }
  if (!authorizationId) {
    return fail("proposal-authorization-required", "proposal_apply requires a valid authorization");
  }

  const startedAt = Date.now();
  const db = openIndexDatabase(environment.databasePath);
  let lock: LockHandle | undefined;
  try {
    const proposal = loadProposalById(db, proposalId);
    if (!proposal.ok) {
      return proposal;
    }
    const authorization = loadAuthorizationById(db, authorizationId);
    if (!authorization.ok) {
      return authorization;
    }
    if (authorization.value.proposalId !== proposal.value.proposalId) {
      return fail("proposal-authorization-mismatch", "authorization does not match the proposal");
    }
    if (authorization.value.usedAt) {
      return fail("proposal-authorization-used", "authorization has already been used");
    }
    lock = acquireApplyLock(path.dirname(environment.databasePath));
    if (!lock) {
      return fail("proposal-apply-locked", "another proposal_apply already owns the write lock");
    }

    const validation = validateStoredProposal(db, environment, proposal.value);
    if (validation.state !== "current") {
      appendProposalLog(environment.runtimeLogPath, {
        eventType: "proposal-apply",
        proposalId,
        path: proposal.value.targetPaths[0],
        hash: proposal.value.diffHash,
        durationMs: Date.now() - startedAt,
        outcome: "refused",
      });
      const first = validation.blockers[0];
      return {
        ok: false,
        error: {
          code: first.code,
          message: first.message,
          path: first.path,
          causes: validation.blockers,
        },
      };
    }
    const authValidation = validateAuthorization(proposal.value, authorization.value);
    if (!authValidation.ok) {
      return authValidation;
    }

    const originalFiles = new Map<string, Buffer | undefined>();
    const createdDirectories = new Set<string>();
    db.prepare("update proposal_authorizations set used_at = ? where authorization_id = ?").run(
      new Date().toISOString(),
      authorizationId,
    );

    try {
      let writesCompleted = 0;
      for (const target of proposal.value.targets) {
        const absolutePath = path.join(environment.vaultPath, target.path);
        let currentText = "";
        if (fs.existsSync(absolutePath)) {
          const original = fs.readFileSync(absolutePath);
          originalFiles.set(target.path, original);
          currentText = original.toString("utf8");
        } else {
          originalFiles.set(target.path, undefined);
        }
        const created = ensureTargetDirectory(path.dirname(absolutePath));
        created.forEach((directory) => createdDirectories.add(directory));
        fs.writeFileSync(absolutePath, materializeTargetBody(target, currentText), "utf8");
        writesCompleted += 1;
        const failAfter = Number(process.env[FAILURE_HOOK_ENV] ?? "0");
        if (failAfter > 0 && writesCompleted >= failAfter) {
          throw new Error("apply failure hook triggered");
        }
      }
      const refreshed = refreshVaultIndex({
        vaultPath: environment.vaultPath,
        databasePath: environment.databasePath,
        privateGlobs: environment.privateGlobs,
        approvedTags: environment.approvedTags,
      });
      if (!refreshed.ok) {
        throw new Error(refreshed.error.message);
      }
    } catch (error) {
      rollbackTargetWrites(environment.vaultPath, originalFiles, createdDirectories);
      const failed = {
        ...proposal.value,
        status: "failed" as const,
        revision: proposal.value.revision + 1,
        updatedAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      };
      writeProposalRow(db, failed);
      recordOperation(db, "proposal-apply-failed", `${proposalId}`);
      appendProposalLog(environment.runtimeLogPath, {
        eventType: "proposal-apply",
        proposalId,
        path: proposal.value.targetPaths[0],
        hash: proposal.value.diffHash,
        durationMs: Date.now() - startedAt,
        outcome: "failure",
      });
      return fail("proposal-apply-failed", "proposal apply failed and was rolled back");
    }

    const applied = redactProposalContent({
      ...proposal.value,
      status: "applied",
      revision: proposal.value.revision + 1,
      updatedAt: new Date().toISOString(),
      lastError: undefined,
    });
    writeProposalRow(db, applied);
    recordOperation(db, "proposal-apply", `${proposalId}`);
    appendProposalLog(environment.runtimeLogPath, {
      eventType: "proposal-apply",
      proposalId,
      path: proposal.value.targetPaths[0],
      hash: proposal.value.diffHash,
      durationMs: Date.now() - startedAt,
      outcome: "success",
    });
    const status = gitStatusForPaths(environment.vaultPath, proposal.value.targetPaths);
    return {
      ok: true,
      value: {
        proposalId,
        status: applied.status,
        changedPaths: proposal.value.targetPaths,
        git: {
          status,
          reviewCommands: [
            `git -C ${environment.vaultPath} status --short`,
            `git -C ${environment.vaultPath} diff -- ${proposal.value.targetPaths.join(" ")}`,
          ],
        },
      },
    };
  } catch (error) {
    return unexpected("proposal-apply-failed", error);
  } finally {
    if (lock) {
      releaseApplyLock(lock);
    }
    db.close();
    secureRuntimeFiles(environment.databasePath);
  }
}

export function cleanupStoredProposals(environment: ProposalEnvironment): Result<{ cleaned: number }> {
  const db = openIndexDatabase(environment.databasePath);
  try {
    const rows = db.prepare("select * from proposals order by proposal_id").all() as ProposalRow[];
    let cleaned = 0;
    for (const row of rows) {
      const proposal = hydrateProposalRow(row);
      const updated = cleanupProposal(environment, proposal);
      if (!updated) {
        continue;
      }
      writeProposalRow(db, updated);
      cleaned += 1;
    }
    if (cleaned > 0) {
      recordOperation(db, "proposal-cleanup", `${cleaned} cleaned`);
    }
    return {
      ok: true,
      value: {
        cleaned,
      },
    };
  } catch (error) {
    return unexpected("proposal-cleanup-failed", error);
  } finally {
    db.close();
    secureRuntimeFiles(environment.databasePath);
  }
}

interface ProposalRow {
  proposal_id: string;
  bundle_id: string | null;
  operation: string;
  status: StoredProposal["status"];
  revision: number;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  target_paths: string;
  source_paths: string;
  candidate_paths: string;
  dependencies: string;
  approved_tags: string;
  proposed_tag_gaps: string;
  unresolved_questions: string;
  validation_blockers: string;
  rationale: string;
  placement_scorecard: string;
  placement_debt: string;
  evidence: string;
  targets: string;
  lineage: string;
  diff_hash: string;
  last_error: string | null;
}

function normalizeCreateInput(
  environment: ProposalEnvironment,
  input: ProposalCreateInput,
): Result<{
  operation: string;
  bundleId?: string;
  contextPackId?: string;
  sourceChunkIds: string[];
  candidatePaths: string[];
  approvedTags: string[];
  proposedTagGaps: string[];
  unresolvedQuestions: string[];
  validationBlockers: string[];
  dependencies: string[];
  rationale: string;
  placementScorecard?: Record<string, unknown>;
  placementDebt?: ProposalPlacementDebt;
  evidence: ProposalEvidence[];
  targets: ProposalTarget[];
  sourceHashes: Record<string, string>;
  candidateHashes: Record<string, string | null>;
}> {
  const operation = (input.operation ?? "").trim();
  if (!operation) {
    return fail("invalid-arguments", "operation must be a non-empty string");
  }
  if (!Array.isArray(input.sourceChunkIds)) {
    return fail("invalid-arguments", "sourceChunkIds must be an array when provided");
  }
  if (!Array.isArray(input.targets) || input.targets.length === 0) {
    return fail("invalid-arguments", "targets must include at least one edit target");
  }
  const approvedTags = uniqueStrings(input.approvedTags);
  const invalidTag = approvedTags.find((tag) => !environment.approvedTags.includes(tag));
  if (invalidTag) {
    return fail("proposal-unapproved-tag", `tag is not approved: ${invalidTag}`, { tag: invalidTag });
  }
  const rationale = String(input.rationale ?? "").trim();
  if (!rationale) {
    return fail("invalid-arguments", "rationale must be a non-empty string");
  }

  const db = openIndexDatabase(environment.databasePath);
  try {
    const sourceRows = input.sourceChunkIds.map((chunkId) => {
      const row = db
        .prepare("select chunk_id, relative_path, heading_path, text from chunks where chunk_id = ?")
        .get(chunkId) as { chunk_id: string; relative_path: string; heading_path: string; text: string } | undefined;
      if (!row) {
        throw structured("proposal-source-chunk-missing", `source chunk not found: ${chunkId}`);
      }
      return row;
    });
    const evidence: ProposalEvidence[] = sourceRows.map((row) => ({
      path: row.relative_path,
      chunkId: row.chunk_id,
      headingPath: row.heading_path,
      excerpt: boundExcerpt(row.text, PROPOSAL_EXCERPT_LIMIT),
    }));
    const sourceHashes: Record<string, string> = Object.fromEntries(
      [...new Set(sourceRows.map((row) => row.relative_path))].map((relativePath) => {
        const absolutePath = path.join(environment.vaultPath, relativePath);
        return [relativePath, fileHash(absolutePath)];
      }),
    );
    const candidatePaths = uniqueStrings(input.candidatePaths).map((candidatePath) => {
      const classified = classifyVaultPath({
        vaultPath: environment.vaultPath,
        input: candidatePath,
        privateGlobs: environment.privateGlobs,
      });
      if (!classified.ok) {
        throw structured(classified.error.code, classified.error.message, classified.error.path);
      }
      return classified.value.normalizedRelativePath;
    }).sort(compareVaultPaths);
    const candidateHashes = Object.fromEntries(
      candidatePaths.map((candidatePath) => {
        const absolutePath = path.join(environment.vaultPath, candidatePath);
        return [candidatePath, fs.existsSync(absolutePath) ? fileHash(absolutePath) : null];
      }),
    );
    const targets = input.targets.map((target) => {
      const classified = classifyVaultPath({
        vaultPath: environment.vaultPath,
        input: target.path,
        privateGlobs: environment.privateGlobs,
      });
      if (!classified.ok) {
        throw structured(classified.error.code, classified.error.message, classified.error.path);
      }
      const absolutePath = classified.value.absolutePath;
      const beforeHash = fs.existsSync(absolutePath) ? fileHash(absolutePath) : null;
      const mode: ProposalTarget["mode"] = target.mode === "create" ? "create" : "replace";
      if (mode === "create" && beforeHash) {
        throw structured("proposal-target-exists", `target already exists: ${classified.value.normalizedRelativePath}`);
      }
      if (mode === "replace" && !beforeHash) {
        throw structured("proposal-target-missing", `target does not exist: ${classified.value.normalizedRelativePath}`);
      }
      if (typeof target.body !== "string" || target.body.length === 0) {
        throw structured("invalid-arguments", `target body must be a non-empty string for ${classified.value.normalizedRelativePath}`);
      }
      const currentText = beforeHash ? fs.readFileSync(absolutePath, "utf8") : "";
      return {
        path: classified.value.normalizedRelativePath,
        mode,
        body: mode === "create" ? target.body : undefined,
        editSpec: mode === "replace" ? spliceEditSpec(currentText, target.body) : undefined,
        beforeHash,
        bodyHash: sha256(target.body),
      };
    }).sort((left, right) => compareVaultPaths(left.path, right.path));
    const placementDebt = normalizePlacementDebt(environment, input.placementDebt, targets);
    if (!placementDebt.ok) {
      return placementDebt;
    }

    return {
      ok: true,
      value: {
        operation,
        bundleId: nonEmptyString(input.bundleId),
        contextPackId: nonEmptyString(input.contextPackId),
        sourceChunkIds: [...new Set(input.sourceChunkIds)],
        candidatePaths,
        approvedTags,
        proposedTagGaps: uniqueStrings(input.proposedTagGaps),
        unresolvedQuestions: uniqueStrings(input.unresolvedQuestions),
        validationBlockers: uniqueStrings(input.validationBlockers),
        dependencies: uniqueStrings(input.dependencies),
        rationale,
        placementScorecard: isRecord(input.placementScorecard) ? input.placementScorecard : undefined,
        placementDebt: placementDebt.value,
        evidence,
        targets,
        sourceHashes,
        candidateHashes,
      },
    };
  } catch (error) {
    return asStructuredResult(error);
  } finally {
    db.close();
    secureRuntimeFiles(environment.databasePath);
  }
}

function loadProposalById(db: SqliteDatabase, proposalId: string): Result<StoredProposal> {
  const row = db.prepare("select * from proposals where proposal_id = ?").get(proposalId) as ProposalRow | undefined;
  if (!row) {
    return fail("proposal-not-found", `proposal not found: ${proposalId}`);
  }
  return {
    ok: true,
    value: hydrateProposalRow(row),
  };
}

function loadAuthorizationById(db: SqliteDatabase, authorizationId: string): Result<ProposalAuthorization> {
  const row = db
    .prepare("select * from proposal_authorizations where authorization_id = ?")
    .get(authorizationId) as
      | {
          authorization_id: string;
          proposal_id: string;
          proposal_revision: number;
          diff_hash: string;
          target_paths: string;
          before_hashes: string;
          git_branch: string | null;
          git_status_hash: string | null;
          taxonomy_hash: string;
          exclusion_config_hash: string;
          created_at: string;
          used_at: string | null;
        }
      | undefined;
  if (!row) {
    return fail("proposal-authorization-required", "authorization is missing or invalid");
  }
  return {
    ok: true,
    value: {
      authorizationId: row.authorization_id,
      proposalId: row.proposal_id,
      proposalRevision: row.proposal_revision,
      diffHash: row.diff_hash,
      targetPaths: parseJson<string[]>(row.target_paths, []),
      beforeHashes: parseJson<Record<string, string | null>>(row.before_hashes, {}),
      gitBranch: row.git_branch ?? undefined,
      gitStatusHash: row.git_status_hash ?? undefined,
      taxonomyHash: row.taxonomy_hash,
      exclusionConfigHash: row.exclusion_config_hash,
      createdAt: row.created_at,
      usedAt: row.used_at ?? undefined,
    },
  };
}

function hydrateProposalRow(row: ProposalRow): StoredProposal {
  return {
    proposalId: row.proposal_id,
    bundleId: row.bundle_id ?? undefined,
    operation: row.operation,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at ?? undefined,
    targetPaths: parseJson<string[]>(row.target_paths, []),
    sourcePaths: parseJson<string[]>(row.source_paths, []),
    candidatePaths: parseJson<string[]>(row.candidate_paths, []),
    dependencies: parseJson<string[]>(row.dependencies, []),
    approvedTags: parseJson<string[]>(row.approved_tags, []),
    proposedTagGaps: parseJson<string[]>(row.proposed_tag_gaps, []),
    unresolvedQuestions: parseJson<string[]>(row.unresolved_questions, []),
    validationBlockers: parseJson<string[]>(row.validation_blockers, []),
    rationale: row.rationale,
    placementScorecard: parseJson<Record<string, unknown>>(row.placement_scorecard, {}),
    placementDebt: parseJson<ProposalPlacementDebt | null>(row.placement_debt, null) ?? undefined,
    evidence: parseJson<ProposalEvidence[]>(row.evidence, []),
    targets: parseJson<ProposalTarget[]>(row.targets, []),
    lineage: parseJson<ProposalLineage>(row.lineage, {
      indexGeneration: "",
      sourceHashes: {},
      candidateHashes: {},
      taxonomyHash: "",
      exclusionConfigHash: "",
      sourceChunkIds: [],
      collisionSearchInputs: [],
      beforeHashes: {},
    }),
    diffHash: row.diff_hash,
    lastError: row.last_error ?? undefined,
  };
}

function validateStoredProposal(
  db: SqliteDatabase,
  environment: ProposalEnvironment,
  proposal: StoredProposal,
): ProposalValidation {
  const blockers: ProposalValidation["blockers"] = [];

  if (proposal.status !== "pending") {
    blockers.push({
      code: "proposal-not-pending",
      message: `proposal status is ${proposal.status}`,
    });
  }

  if (proposal.expiresAt && Date.parse(proposal.expiresAt) <= Date.now()) {
    blockers.push({
      code: "proposal-expired",
      message: "proposal has expired",
    });
  }

  const currentIndexGeneration = readMetaValue(db, "index_generation");
  if (currentIndexGeneration !== proposal.lineage.indexGeneration) {
    blockers.push({
      code: "proposal-index-generation-changed",
      message: "index generation changed after proposal creation",
    });
  }

  const currentTaxonomyHash = approvedTagsHash(environment.approvedTags);
  if (currentTaxonomyHash !== proposal.lineage.taxonomyHash) {
    blockers.push({
      code: "proposal-taxonomy-changed",
      message: "approved tags changed after proposal creation",
    });
  }

  const currentExclusionConfigHash = exclusionConfigHashFor(environment.privateGlobs);
  if (currentExclusionConfigHash !== proposal.lineage.exclusionConfigHash) {
    blockers.push({
      code: "proposal-exclusion-config-changed",
      message: "private path configuration changed after proposal creation",
    });
  }

  for (const tag of proposal.approvedTags) {
    if (!environment.approvedTags.includes(tag)) {
      blockers.push({
        code: "proposal-unapproved-tag",
        message: `tag is not approved: ${tag}`,
      });
    }
  }

  if (proposal.unresolvedQuestions.length > 0) {
    blockers.push({
      code: "proposal-unresolved-questions",
      message: "proposal still has unresolved questions",
    });
  }
  if (proposal.validationBlockers.length > 0) {
    blockers.push({
      code: "proposal-validation-blocker",
      message: "proposal still has validation blockers",
    });
  }

  for (const target of proposal.targets) {
    const classified = classifyVaultPath({
      vaultPath: environment.vaultPath,
      input: target.path,
      privateGlobs: environment.privateGlobs,
    });
    if (!classified.ok) {
      blockers.push({
        code: classifyTargetErrorCode(classified.error.code),
        message: classified.error.message,
        path: target.path,
      });
      continue;
    }
    const absolutePath = classified.value.absolutePath;
    const currentHash = fs.existsSync(absolutePath) ? fileHash(absolutePath) : null;
    if (target.beforeHash === null && currentHash !== null) {
      blockers.push({
        code: "proposal-target-exists",
        message: "target now exists but proposal expected a create path",
        path: target.path,
      });
    }
    if (target.beforeHash !== null && currentHash === null) {
      blockers.push({
        code: "proposal-target-missing",
        message: "target file is missing",
        path: target.path,
      });
    }
    if (target.beforeHash !== null && currentHash !== null && target.beforeHash !== currentHash) {
      blockers.push({
        code: "proposal-target-changed",
        message: "target file changed after proposal creation",
        path: target.path,
      });
    }
  }

  for (const [sourcePath, expectedHash] of Object.entries(proposal.lineage.sourceHashes)) {
    const sourceStatus = classifyExistingPath(environment, sourcePath);
    if (!sourceStatus.ok) {
      blockers.push({
        code: sourceStatus.error.code === "private-path" ? "source-excluded" : "proposal-source-invalid",
        message: sourceStatus.error.message,
        path: sourcePath,
      });
      continue;
    }
    const currentHash = fileHash(sourceStatus.value.absolutePath);
    if (currentHash !== expectedHash) {
      blockers.push({
        code: "proposal-source-changed",
        message: "source evidence changed after proposal creation",
        path: sourcePath,
      });
    }
  }

  for (const [candidatePath, expectedHash] of Object.entries(proposal.lineage.candidateHashes)) {
    const classified = classifyVaultPath({
      vaultPath: environment.vaultPath,
      input: candidatePath,
      privateGlobs: environment.privateGlobs,
    });
    if (!classified.ok) {
      blockers.push({
        code: "proposal-candidate-invalid",
        message: classified.error.message,
        path: candidatePath,
      });
      continue;
    }
    const currentHash = fs.existsSync(classified.value.absolutePath) ? fileHash(classified.value.absolutePath) : null;
    if (currentHash !== expectedHash) {
      blockers.push({
        code: "proposal-candidate-changed",
        message: "candidate path changed after proposal creation",
        path: candidatePath,
      });
    }
  }

  const gitState = readVaultGitState(environment.vaultPath);
  if (!gitState.ok) {
    blockers.push(gitState.error);
  } else {
    if (gitState.value.branch !== proposal.lineage.gitBranch) {
      blockers.push({
        code: "proposal-branch-changed",
        message: "vault git branch changed after proposal creation",
      });
    }
    if (gitState.value.statusHash !== proposal.lineage.gitStatusHash) {
      blockers.push({
        code: "proposal-git-state-changed",
        message: "vault git status changed after proposal creation",
      });
    }
  }

  return {
    state: blockers.length === 0 ? "current" : "blocked",
    blockers,
    diffHash: proposal.diffHash,
  };
}

function validateAuthorization(
  proposal: StoredProposal,
  authorization: ProposalAuthorization,
): Result<void> {
  if (authorization.proposalRevision !== proposal.revision) {
    return fail("proposal-revision-changed", "proposal revision changed after authorization");
  }
  if (authorization.diffHash !== proposal.diffHash) {
    return fail("proposal-diff-changed", "proposal diff changed after authorization");
  }
  if (authorization.gitBranch !== proposal.lineage.gitBranch) {
    return fail("proposal-branch-changed", "vault git branch changed after authorization");
  }
  if (authorization.gitStatusHash !== proposal.lineage.gitStatusHash) {
    return fail("proposal-git-state-changed", "vault git state changed after authorization");
  }
  if (authorization.taxonomyHash !== proposal.lineage.taxonomyHash) {
    return fail("proposal-taxonomy-changed", "approved tags changed after authorization");
  }
  if (authorization.exclusionConfigHash !== proposal.lineage.exclusionConfigHash) {
    return fail("proposal-exclusion-config-changed", "private path configuration changed after authorization");
  }
  return {
    ok: true,
    value: undefined,
  };
}

function cleanupProposal(environment: ProposalEnvironment, proposal: StoredProposal): StoredProposal | undefined {
  let mutated = false;
  let next = proposal;
  if (proposal.status === "pending" && proposal.expiresAt && Date.parse(proposal.expiresAt) <= Date.now()) {
    next = {
      ...next,
      status: "expired",
      revision: next.revision + 1,
      updatedAt: new Date().toISOString(),
      lastError: "expired",
    };
    mutated = true;
  }
  if (["applied", "rejected", "expired"].includes(next.status)) {
    const redacted = redactProposalContent(next);
    if (JSON.stringify(redacted) !== JSON.stringify(next)) {
      next = redacted;
      mutated = true;
    }
  } else {
    const cleanedEvidence = next.evidence.map((item) => {
      if (!item.excerpt) {
        return item;
      }
      const classified = classifyVaultPath({
        vaultPath: environment.vaultPath,
        input: item.path,
        privateGlobs: environment.privateGlobs,
      });
      if (!classified.ok || !fs.existsSync(classified.value.absolutePath)) {
        mutated = true;
        return {
          ...item,
          excerpt: undefined,
        };
      }
      return item;
    });
    if (mutated) {
      next = {
        ...next,
        evidence: cleanedEvidence,
        updatedAt: new Date().toISOString(),
      };
    }
  }
  return mutated ? next : undefined;
}

function redactProposalContent(proposal: StoredProposal): StoredProposal {
  return {
    ...proposal,
    placementDebt: proposal.placementDebt
      ? {
          ...proposal.placementDebt,
          originalText: undefined,
        }
      : undefined,
    evidence: proposal.evidence.map((item) => ({
      ...item,
      excerpt: undefined,
    })),
    targets: proposal.targets.map((target) => ({
      ...target,
      body: undefined,
    })),
  };
}

function buildDiffPreview(
  environment: ProposalEnvironment,
  targets: ProposalTarget[],
): Array<{ path: string; preview: string; truncated: boolean }> {
  return targets.map((target) => {
    const absolutePath = path.join(environment.vaultPath, target.path);
    const current = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, "utf8") : "";
    const currentHash = fs.existsSync(absolutePath) ? fileHash(absolutePath) : null;
    if (target.mode === "replace" && target.beforeHash !== currentHash) {
      return {
        path: target.path,
        preview: "Diff preview unavailable because the target changed after proposal creation.",
        truncated: false,
      };
    }
    const next = materializeTargetBody(target, current);
    const preview = simpleDiff(current, next);
    return {
      path: target.path,
      preview: preview.text,
      truncated: preview.truncated,
    };
  });
}

function simpleDiff(current: string, next: string): { text: string; truncated: boolean } {
  const currentLines = current.split(/\r?\n/);
  const nextLines = next.split(/\r?\n/);
  const lines = ["--- current", "+++ proposed"];
  const longest = Math.max(currentLines.length, nextLines.length);
  let emitted = 0;
  for (let index = 0; index < longest; index += 1) {
    const left = currentLines[index] ?? "";
    const right = nextLines[index] ?? "";
    if (left === right) {
      continue;
    }
    lines.push(`- ${left}`);
    lines.push(`+ ${right}`);
    emitted += 2;
    if (emitted >= 16) {
      return {
        text: `${lines.join("\n")}\n...`,
        truncated: true,
      };
    }
  }
  return {
    text: lines.join("\n"),
    truncated: false,
  };
}

function appendProposalLog(logPath: string, entry: Record<string, unknown>): void {
  const sanitized = sanitizeProposalLogEntry(entry);
  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(logPath, `${JSON.stringify(sanitized)}\n`, { mode: 0o600 });
  fs.chmodSync(logPath, 0o600);
}

function readVaultGitState(vaultPath: string): Result<{ branch: string; statusHash: string }> {
  const branchResult = spawnSync("git", ["-C", vaultPath, "rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
  });
  if (branchResult.status !== 0) {
    return fail("proposal-git-unavailable", "vault must be a readable git repository");
  }
  const statusResult = spawnSync("git", ["-C", vaultPath, "status", "--short"], {
    encoding: "utf8",
  });
  if (statusResult.status !== 0) {
    return fail("proposal-git-unavailable", "vault git status is unavailable");
  }
  return {
    ok: true,
    value: {
      branch: branchResult.stdout.trim(),
      statusHash: sha256(statusResult.stdout),
    },
  };
}

function gitStatusForPaths(vaultPath: string, relativePaths: string[]): string {
  const args = ["-C", vaultPath, "status", "--short", "--", ...relativePaths];
  const result = spawnSync("git", args, {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return "";
  }
  return result.stdout.trim();
}

function acquireApplyLock(runtimeDir: string): LockHandle | undefined {
  const lockPath = path.join(runtimeDir, "proposal-apply.lock");
  try {
    const fd = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return {
      lockPath,
      fd,
    };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "EEXIST") {
      throw error;
    }
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      fs.unlinkSync(lockPath);
      return acquireApplyLock(runtimeDir);
    }
    return undefined;
  }
}

function releaseApplyLock(lock: LockHandle): void {
  try {
    fs.closeSync(lock.fd);
  } catch {
    // ignore close failures during cleanup
  }
  if (fs.existsSync(lock.lockPath)) {
    fs.unlinkSync(lock.lockPath);
  }
}

function rollbackTargetWrites(
  vaultPath: string,
  originalFiles: Map<string, Buffer | undefined>,
  createdDirectories: Set<string>,
): void {
  for (const [relativePath, original] of originalFiles.entries()) {
    const absolutePath = path.join(vaultPath, relativePath);
    if (original === undefined) {
      if (fs.existsSync(absolutePath)) {
        fs.unlinkSync(absolutePath);
      }
      continue;
    }
    fs.writeFileSync(absolutePath, original);
  }
  [...createdDirectories]
    .sort((left, right) => right.localeCompare(left))
    .forEach((directory) => {
      try {
        fs.rmdirSync(directory);
      } catch {
        // ignore non-empty cleanup failures
      }
    });
}

function ensureTargetDirectory(targetDir: string): string[] {
  const created: string[] = [];
  const segments: string[] = [];
  const absolute = path.resolve(targetDir);
  const root = path.parse(absolute).root;
  const relative = absolute.slice(root.length).split(path.sep).filter(Boolean);
  for (const part of relative) {
    segments.push(part);
    const current = path.join(root, ...segments);
    if (!fs.existsSync(current)) {
      fs.mkdirSync(current, { mode: 0o700 });
      created.push(current);
    }
  }
  return created;
}

function classifyExistingPath(
  environment: ProposalEnvironment,
  relativePath: string,
): Result<{ absolutePath: string }> {
  const classified = classifyVaultPath({
    vaultPath: environment.vaultPath,
    input: relativePath,
    privateGlobs: environment.privateGlobs,
  });
  if (!classified.ok) {
    return classified as Result<{ absolutePath: string }>;
  }
  if (!fs.existsSync(classified.value.absolutePath)) {
    return fail("proposal-source-missing", "source path is missing", { path: relativePath });
  }
  return {
    ok: true,
    value: {
      absolutePath: classified.value.absolutePath,
    },
  };
}

function classifyTargetErrorCode(code: string): string {
  if (code === "private-path" || code === "excluded-root") {
    return "proposal-excluded-path";
  }
  if (code === "symlink") {
    return "proposal-target-symlink";
  }
  return code;
}

function computeDiffHash(targets: ProposalTarget[]): string {
  return sha256(
    JSON.stringify(
      targets.map((target) => ({
        path: target.path,
        mode: target.mode,
        beforeHash: target.beforeHash,
        bodyHash: target.bodyHash,
        editSpec: target.editSpec,
      })),
    ),
  );
}

function materializeTargetBody(target: ProposalTarget, currentText: string): string {
  if (target.mode === "create") {
    return target.body ?? "";
  }
  if (!target.editSpec) {
    return target.body ?? currentText;
  }
  return [
    currentText.slice(0, target.editSpec.start),
    target.editSpec.insertText,
    currentText.slice(target.editSpec.end),
  ].join("");
}

function spliceEditSpec(currentText: string, nextText: string): ProposalTarget["editSpec"] {
  let start = 0;
  while (start < currentText.length && start < nextText.length && currentText[start] === nextText[start]) {
    start += 1;
  }

  let currentEnd = currentText.length;
  let nextEnd = nextText.length;
  while (currentEnd > start && nextEnd > start && currentText[currentEnd - 1] === nextText[nextEnd - 1]) {
    currentEnd -= 1;
    nextEnd -= 1;
  }

  return {
    start,
    end: currentEnd,
    insertText: nextText.slice(start, nextEnd),
  };
}

function writeProposalRow(db: SqliteDatabase, proposal: StoredProposal): void {
  db.prepare(
    [
      "update proposals set",
      "bundle_id = ?, operation = ?, status = ?, revision = ?, created_at = ?, updated_at = ?, expires_at = ?,",
      "target_paths = ?, source_paths = ?, candidate_paths = ?, dependencies = ?, approved_tags = ?, proposed_tag_gaps = ?,",
      "unresolved_questions = ?, validation_blockers = ?, rationale = ?, placement_scorecard = ?, placement_debt = ?, evidence = ?, targets = ?,",
      "lineage = ?, diff_hash = ?, last_error = ?",
      "where proposal_id = ?",
    ].join(" "),
  ).run(
    proposal.bundleId ?? null,
    proposal.operation,
    proposal.status,
    proposal.revision,
    proposal.createdAt,
    proposal.updatedAt,
    proposal.expiresAt ?? null,
    stringifyJson(proposal.targetPaths),
    stringifyJson(proposal.sourcePaths),
    stringifyJson(proposal.candidatePaths),
    stringifyJson(proposal.dependencies),
    stringifyJson(proposal.approvedTags),
    stringifyJson(proposal.proposedTagGaps),
    stringifyJson(proposal.unresolvedQuestions),
    stringifyJson(proposal.validationBlockers),
    proposal.rationale,
    stringifyJson(proposal.placementScorecard ?? {}),
    stringifyJson(proposal.placementDebt ?? null),
    stringifyJson(proposal.evidence),
    stringifyJson(proposal.targets),
    stringifyJson(proposal.lineage),
    proposal.diffHash,
    proposal.lastError ?? null,
    proposal.proposalId,
  );
}

function approvedTagsHash(tags: string[]): string {
  return sha256(JSON.stringify([...new Set(tags)].sort()));
}

function normalizePlacementDebt(
  environment: ProposalEnvironment,
  input: ProposalCreateInput["placementDebt"],
  targets: ProposalTarget[],
): Result<ProposalPlacementDebt | undefined> {
  if (!input) {
    return {
      ok: true,
      value: undefined,
    };
  }
  const originalText = typeof input.originalText === "string" ? input.originalText.trim() : "";
  if (!originalText) {
    return fail("invalid-arguments", "placementDebt.originalText must be a non-empty string");
  }
  const ambiguityReason = typeof input.ambiguityReason === "string" ? input.ambiguityReason.trim() : "";
  if (!ambiguityReason) {
    return fail("invalid-arguments", "placementDebt.ambiguityReason must be a non-empty string");
  }
  if (!targets.some((target) => target.path.startsWith("00-inbox/daily-notes/"))) {
    return fail("invalid-arguments", "placementDebt requires a daily-note target");
  }
  if (!Array.isArray(input.candidateDestinations) || input.candidateDestinations.length === 0) {
    return fail("invalid-arguments", "placementDebt.candidateDestinations must be a non-empty array");
  }
  const candidateDestinations: ProposalPlacementDestination[] = [];
  for (const item of input.candidateDestinations) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return fail("invalid-arguments", "placementDebt candidate destinations must be objects");
    }
    const rawPath = typeof item.path === "string" ? item.path.trim() : "";
    if (!rawPath) {
      return fail("invalid-arguments", "placementDebt candidate destinations require a non-empty path");
    }
    const classified = classifyVaultPath({
      vaultPath: environment.vaultPath,
      input: rawPath,
      privateGlobs: environment.privateGlobs,
    });
    if (!classified.ok) {
      return fail(classified.error.code, classified.error.message, { path: classified.error.path });
    }
    candidateDestinations.push({
      path: classified.value.normalizedRelativePath,
      title: nonEmptyString(item.title),
      reason: nonEmptyString(item.reason),
      anchorHeading: nonEmptyString(item.anchorHeading),
    });
  }
  const reviewDueAt = nonEmptyString(input.reviewDueAt)
    ?? new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const reviewDueAtMs = Date.parse(reviewDueAt);
  if (!Number.isFinite(reviewDueAtMs) || reviewDueAtMs <= Date.now()) {
    return fail("invalid-arguments", "placementDebt.reviewDueAt must be a future ISO timestamp");
  }
  return {
    ok: true,
    value: {
      originalText,
      ambiguityReason,
      reviewDueAt,
      candidateDestinations,
    },
  };
}

function exclusionConfigHashFor(privateGlobs: string[]): string {
  return sha256(
    JSON.stringify({
      privateGlobs: [...new Set(privateGlobs)].sort(),
      excludedRoots: [...EXCLUDED_PATH_PARTS].sort(),
    }),
  );
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function boundExcerpt(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, maxChars - 3).trimEnd()}...`;
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return [...new Set(values.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))];
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function readMetaValue(db: Database.Database, key: string): string | undefined {
  const row = db.prepare("select value from meta where key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

function fail(
  code: string,
  message: string,
  extra: Partial<StructuredError> = {},
): Result<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...extra,
    },
  };
}

function structured(code: string, message: string, pathValue?: string): StructuredError {
  return {
    code,
    message,
    path: pathValue,
  };
}

function asStructuredResult(error: unknown): Result<never> {
  if (isStructuredError(error)) {
    return {
      ok: false,
      error,
    };
  }
  return unexpected("proposal-unexpected-error", error);
}

function unexpected(code: string, error: unknown): Result<never> {
  return {
    ok: false,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function isStructuredError(error: unknown): error is StructuredError {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && "message" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
