import crypto from "crypto";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import Database from "better-sqlite3";
import { compareVaultPaths, fileHash } from "./files";
import { inspectImportSource } from "./import-source";
import { openIndexDatabase, recordOperation, secureRuntimeFiles, SqliteDatabase } from "./index-db";
import { refreshVaultIndex } from "./index-search";
import { classifyVaultPath } from "./path-safety";
import { executeVaultChangeTransaction } from "./change-transaction";
import {
  approvedTagsHash,
  DEFAULT_PROPOSAL_EXPIRY_DAYS,
  exclusionConfigHashFor,
  fail,
  parseJson,
  sha256,
  stringifyJson,
  unexpected,
} from "./proposal-common";
import { normalizeCreateInput } from "./proposal-create-normalizer";
import {
  buildChangedVaultPaths as changedVaultPathsForActions,
  primaryProposalPath as primaryPathForProposal,
  proposalPathActionDiffPayload,
  validatePathAction as validateProposalPathAction,
} from "./proposal-path-actions";
import { ensureProposalStorage } from "./proposal-schema";
import {
  buildDiffPreview as buildProposalDiffPreview,
  hydrateProposalTarget,
  materializeTargetBody as targetBodyForApply,
  proposalTargetDiffPayload,
  safeDiffPreviewPath,
} from "./proposal-targets";
import type {
  ProposalAuthorization,
  ProposalCreateInput,
  DirectoryIndexRefreshProposalInput,
  ProposalEnvironment,
  ProposalEvidence,
  ProposalLineage,
  ProposalPathAction,
  ProposalPlacementDebt,
  ProposalPlacementDestination,
  ProposalTarget,
  ProposalToolOptions,
  ProposalValidation,
  StoredProposal,
} from "./proposal-types";
import { Result } from "./types";

export type {
  DirectoryIndexRefreshProposalInput,
  ProposalCreateInput,
  ProposalEnvironment,
  ProposalToolOptions,
  ProposalValidation,
} from "./proposal-types";

export function sanitizeProposalLogEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const key of ["eventType", "proposalId", "path", "hash", "durationMs", "outcome"]) {
    if (entry[key] !== undefined) {
      sanitized[key] = entry[key];
    }
  }
  return sanitized;
}

function openProposalDatabase(databasePath: string): SqliteDatabase {
  const db = openIndexDatabase(databasePath);
  ensureProposalStorage(db);
  return db;
}

function openProposalReadonlyDatabase(databasePath: string): SqliteDatabase | undefined {
  if (!fs.existsSync(databasePath)) {
    return undefined;
  }
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  db.pragma("foreign_keys = ON");
  return db;
}

export function createDirectoryIndexRefreshProposal(
  environment: ProposalEnvironment,
  input: DirectoryIndexRefreshProposalInput,
  options: ProposalToolOptions = {},
) {
  if (!options.writeEnabled) {
    return fail("write-disabled", "proposal_create_directory_index_refresh requires --write-enabled mode");
  }
  return createStoredProposalInternal(
    environment,
    {
      operation: "directory-index-refresh",
      sourceChunkIds: [],
      candidatePaths: input.paths,
      rationale: input.rationale,
      targets: [],
    },
    options,
    {
      directoryIndexRepairPaths: input.paths,
    },
  );
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
  return createStoredProposalInternal(environment, input, options);
}

function createStoredProposalInternal(
  environment: ProposalEnvironment,
  input: ProposalCreateInput,
  options: ProposalToolOptions = {},
  normalizationOptions: { directoryIndexRepairPaths?: string[] } = {},
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

  const normalizedInput = normalizeCreateInput(
    environment,
    input,
    {
      openDatabase: openProposalDatabase,
      loadProposalById,
      closeDatabase(database) {
        database.close();
        secureRuntimeFiles(environment.databasePath);
      },
    },
    normalizationOptions,
  );
  if (!normalizedInput.ok) {
    return normalizedInput;
  }

  const db = openProposalDatabase(environment.databasePath);
  try {
    const gitState = readVaultGitState(environment.vaultPath);
    if (!gitState.ok) {
      return gitState;
    }
    const proposalId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + DEFAULT_PROPOSAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
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
      externalSourceHashes: normalizedInput.value.externalSourceHashes,
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
      sourcePaths: [
        ...Object.keys(normalizedInput.value.sourceHashes).sort(compareVaultPaths),
        ...Object.keys(normalizedInput.value.externalSourceHashes).sort(),
      ],
      approvedTags: normalizedInput.value.approvedTags,
      proposedTagGaps: normalizedInput.value.proposedTagGaps,
      unresolvedQuestions: normalizedInput.value.unresolvedQuestions,
      validationBlockers: normalizedInput.value.validationBlockers,
      dependencies: normalizedInput.value.dependencies,
      rationale: normalizedInput.value.rationale,
      placementScorecard: normalizedInput.value.placementScorecard,
      placementDebt: normalizedInput.value.placementDebt,
      evidence: normalizedInput.value.evidence,
      pathActions: normalizedInput.value.pathActions,
      targets: normalizedInput.value.targets,
      lineage,
      diffHash: computeDiffHash(normalizedInput.value.targets, normalizedInput.value.pathActions),
    };
    const insert = db.prepare(
      [
        "insert into proposals",
        "(",
        "proposal_id, bundle_id, operation, status, revision, created_at, updated_at, expires_at,",
        "target_paths, source_paths, candidate_paths, dependencies, approved_tags, proposed_tag_gaps,",
        "unresolved_questions, validation_blockers, rationale, placement_scorecard, placement_debt, evidence, path_actions, targets, lineage, diff_hash, last_error",
        ") values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
      stringifyJson(stored.pathActions),
      stringifyJson(stored.targets),
      stringifyJson(stored.lineage),
      stored.diffHash,
      null,
    );
    recordOperation(db, "proposal-create", `${stored.proposalId} (${stored.targetPaths.length} paths)`);
    appendProposalLog(environment.runtimeLogPath, {
      eventType: "proposal-create",
      proposalId: stored.proposalId,
      path: primaryPathForProposal(stored),
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
    pathActions: Array<{
      type: ProposalPathAction["type"];
      scope: ProposalPathAction["scope"];
      path: string;
      destinationPath?: string;
    }>;
    placementDebt?: {
      ambiguityReason: string;
      reviewDueAt: string;
      candidateDestinations: ProposalPlacementDestination[];
    };
  }>;
}> {
  const db = openProposalReadonlyDatabase(options.databasePath);
  if (!db) {
    return {
      ok: true,
      value: {
        items: [],
      },
    };
  }
  try {
    if (!tableExists(db, "proposals")) {
      return {
        ok: true,
        value: {
          items: [],
        },
      };
    }
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
            pathActions: proposal.pathActions.map((item) => item.type === "move"
              ? {
                  type: item.type,
                  scope: item.scope,
                  path: item.path,
                  destinationPath: item.destinationPath,
                }
              : {
                  type: item.type,
                  scope: item.scope,
                  path: item.path,
                }),
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
  const db = openProposalReadonlyDatabase(environment.databasePath);
  if (!db) {
    return fail("proposal-not-found", `proposal not found: ${proposalId}`);
  }
  try {
    if (!tableExists(db, "proposals")) {
      return fail("proposal-not-found", `proposal not found: ${proposalId}`);
    }
    const proposal = loadProposalById(db, proposalId);
    if (!proposal.ok) {
      return proposal;
    }
    const readableProposal = cleanupProposal(environment, proposal.value) ?? proposal.value;
    const validation = validateStoredProposal(db, environment, readableProposal);
    return {
      ok: true,
      value: {
        proposal: readableProposal,
        validation,
        diffPreview: buildStoredDiffPreview(environment, readableProposal),
      },
    };
  } catch (error) {
    return unexpected("proposal-read-failed", error);
  } finally {
    db.close();
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
  const db = openProposalDatabase(environment.databasePath);
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
      path: primaryPathForProposal(updated),
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
  const db = openProposalDatabase(environment.databasePath);
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
        path: primaryPathForProposal(proposal.value),
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
      path: primaryPathForProposal(proposal.value),
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
  deletedExternalPaths: string[];
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
  const db = openProposalDatabase(environment.databasePath);
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
    let authorizationConsumed = false;
    let appliedProposal: StoredProposal | undefined;
    const persistFailedProposal = (): Result<void> => {
      if (!authorizationConsumed) {
        return { ok: true, value: undefined };
      }
      const failed = {
        ...proposal.value,
        status: "failed" as const,
        revision: proposal.value.revision + 1,
        updatedAt: new Date().toISOString(),
        lastError: "proposal apply failed and was rolled back",
      };
      try {
        db.transaction(() => {
          writeProposalRow(db, failed);
          recordOperation(db, "proposal-apply-failed", `${proposalId}`);
        })();
        return { ok: true, value: undefined };
      } catch {
        return fail("proposal-apply-failed", "proposal recovery state could not be persisted");
      }
    };
    const transaction = executeVaultChangeTransaction({
      vaultPath: environment.vaultPath,
      runtimeDir: path.dirname(environment.databasePath),
      privateGlobs: environment.privateGlobs,
      writes: proposal.value.targets.map((target) => ({
        path: target.path,
        body: (current) => targetBodyForApply(target, current?.toString("utf8") ?? ""),
        expectedBeforeHash: target.beforeHash,
      })),
      moves: proposal.value.pathActions.flatMap((action) => action.type === "move"
        ? [{
            from: action.path,
            to: action.destinationPath,
            sourceBeforeHash: action.beforeHash,
            destinationBeforeHash: action.destinationBeforeHash,
          }]
        : []),
      externalDeletes: proposal.value.pathActions
        .filter((action) => action.type === "delete-file" && action.scope === "external")
        .map((action) => ({ path: action.path })),
      refresh: () => refreshVaultIndex({
        vaultPath: environment.vaultPath,
        databasePath: environment.databasePath,
        privateGlobs: environment.privateGlobs,
        approvedTags: environment.approvedTags,
      }),
      beforeMutate: () => {
        const validation = validateStoredProposal(db, environment, proposal.value);
        if (validation.state !== "current") {
          appendProposalLog(environment.runtimeLogPath, {
            eventType: "proposal-apply",
            proposalId,
            path: primaryPathForProposal(proposal.value),
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
        db.prepare("update proposal_authorizations set used_at = ? where authorization_id = ?").run(
          new Date().toISOString(),
          authorizationId,
        );
        authorizationConsumed = true;
        return { ok: true, value: undefined };
      },
      finalize: () => {
        const applied = redactProposalContent({
          ...proposal.value,
          status: "applied",
          revision: proposal.value.revision + 1,
          updatedAt: new Date().toISOString(),
          lastError: undefined,
        });
        try {
          db.transaction(() => {
            writeProposalRow(db, applied);
            recordOperation(db, "proposal-apply", `${proposalId}`);
          })();
          appliedProposal = applied;
          return { ok: true, value: undefined };
        } catch {
          return fail("proposal-apply-failed", "proposal terminal state could not be persisted");
        }
      },
      onFailure: persistFailedProposal,
      onRefusal: persistFailedProposal,
    });
    if (!transaction.ok) {
      if (transaction.error.code === "change-apply-locked") {
        return fail("proposal-apply-locked", "another proposal_apply already owns the write lock");
      }
      if (!authorizationConsumed) {
        return transaction;
      }
      appendProposalLog(environment.runtimeLogPath, {
        eventType: "proposal-apply",
        proposalId,
        path: primaryPathForProposal(proposal.value),
        hash: proposal.value.diffHash,
        durationMs: Date.now() - startedAt,
        outcome: "failure",
      });
      return fail("proposal-apply-failed", "proposal apply failed and was rolled back");
    }
    const changedPaths = changedVaultPathsForActions(proposal.value);
    const status = gitStatusForPaths(environment.vaultPath, changedPaths);
    const reviewCommands = changedPaths.length > 0
      ? [
          `git -C ${environment.vaultPath} status --short`,
          `git -C ${environment.vaultPath} diff -- ${changedPaths.join(" ")}`,
        ]
      : [`git -C ${environment.vaultPath} status --short`];
    if (!appliedProposal) {
      return fail("proposal-apply-failed", "proposal terminal state was not persisted");
    }
    appendProposalLog(environment.runtimeLogPath, {
      eventType: "proposal-apply",
      proposalId,
      path: primaryPathForProposal(proposal.value),
      hash: proposal.value.diffHash,
      durationMs: Date.now() - startedAt,
      outcome: "success",
    });
    return {
      ok: true,
      value: {
        proposalId,
        status: appliedProposal.status,
        changedPaths,
        deletedExternalPaths: transaction.value.deletedExternalPaths,
        git: {
          status,
          reviewCommands,
        },
      },
    };
  } catch (error) {
    return unexpected("proposal-apply-failed", error);
  } finally {
    db.close();
    secureRuntimeFiles(environment.databasePath);
  }
}

export function cleanupStoredProposals(environment: ProposalEnvironment): Result<{ cleaned: number }> {
  const db = openProposalDatabase(environment.databasePath);
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
  path_actions: string;
  targets: string;
  lineage: string;
  diff_hash: string;
  last_error: string | null;
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
    evidence: parseJson<ProposalEvidence[]>(row.evidence, []).map((item) => ({
      ...item,
      provenance: item.provenance ?? "indexed-vault",
    })),
    pathActions: parseJson<ProposalPathAction[]>(row.path_actions, []),
    targets: parseJson<unknown[]>(row.targets, []).map(hydrateProposalTarget),
    lineage: parseJson<ProposalLineage>(row.lineage, {
      indexGeneration: "",
      sourceHashes: {},
      externalSourceHashes: {},
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
  let dependencyGateSatisfied = proposal.dependencies.length > 0;

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
  for (const dependencyId of proposal.dependencies) {
    const dependency = loadProposalById(db, dependencyId);
    if (!dependency.ok) {
      dependencyGateSatisfied = false;
      blockers.push({
        code: "proposal-dependency-missing",
        message: `dependency proposal is missing: ${dependencyId}`,
      });
      continue;
    }
    if (dependency.value.status !== "applied") {
      dependencyGateSatisfied = false;
      blockers.push({
        code: "proposal-dependency-pending",
        message: `dependency proposal is not applied: ${dependencyId}`,
      });
      continue;
    }
  }

  const currentIndexGeneration = readMetaValue(db, "index_generation");
  if (currentIndexGeneration !== proposal.lineage.indexGeneration && !dependencyGateSatisfied) {
    blockers.push({
      code: "proposal-index-generation-changed",
      message: "index generation changed after proposal creation",
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

  for (const [sourcePath, expectedHash] of Object.entries(proposal.lineage.externalSourceHashes)) {
    const inspection = inspectImportSource({
      rootDir: environment.rootDir,
      vaultPath: environment.vaultPath,
      privateGlobs: environment.privateGlobs,
      inputPath: sourcePath,
      explicitPathProvided: true,
    });
    if (!inspection.ok) {
      blockers.push({
        code: inspection.error.code === "private-path" ? "source-excluded" : "proposal-external-source-invalid",
        message: inspection.error.message,
        path: sourcePath,
      });
      continue;
    }
    if (inspection.value.hash !== expectedHash) {
      blockers.push({
        code: "proposal-external-source-changed",
        message: "external source changed after proposal creation",
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

  for (const action of proposal.pathActions) {
    const actionValidation = validateProposalPathAction(environment, action);
    if (!actionValidation.ok) {
      blockers.push({
        code: actionValidation.error.code,
        message: actionValidation.error.message,
        path: actionValidation.error.path,
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
    if (gitState.value.statusHash !== proposal.lineage.gitStatusHash && !dependencyGateSatisfied) {
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
      if (item.provenance === "external-file") {
        const inspection = inspectImportSource({
          rootDir: environment.rootDir,
          vaultPath: environment.vaultPath,
          privateGlobs: environment.privateGlobs,
          inputPath: item.path,
          explicitPathProvided: true,
        });
        if (!inspection.ok) {
          mutated = true;
          return {
            ...item,
            excerpt: undefined,
          };
        }
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
      path: target.path,
      mode: target.mode,
      beforeHash: target.beforeHash,
      bodyHash: target.bodyHash,
      body: undefined,
    })),
  };
}

function buildStoredDiffPreview(
  environment: ProposalEnvironment,
  proposal: StoredProposal,
): Array<{ path: string; preview: string; truncated: boolean }> {
  if (proposal.targets.some((target) => typeof target.body !== "string" && !target.legacyPatch)) {
    return proposal.targets.map((target) => ({
      path: safeDiffPreviewPath(environment, target.path),
      preview: "Diff preview unavailable because proposal content has been redacted.",
      truncated: false,
    }));
  }
  return buildProposalDiffPreview(environment, proposal.targets);
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
  if (relativePaths.length === 0) {
    return "";
  }
  const args = ["-C", vaultPath, "status", "--short", "--", ...relativePaths];
  const result = spawnSync("git", args, {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return "";
  }
  return result.stdout.trim();
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

function computeDiffHash(targets: ProposalTarget[], pathActions: ProposalPathAction[]): string {
  return sha256(
    JSON.stringify(
      {
        targets: targets.map(proposalTargetDiffPayload),
        pathActions: pathActions.map(proposalPathActionDiffPayload),
      },
    ),
  );
}

function writeProposalRow(db: SqliteDatabase, proposal: StoredProposal): void {
  db.prepare(
    [
      "update proposals set",
      "bundle_id = ?, operation = ?, status = ?, revision = ?, created_at = ?, updated_at = ?, expires_at = ?,",
      "target_paths = ?, source_paths = ?, candidate_paths = ?, dependencies = ?, approved_tags = ?, proposed_tag_gaps = ?,",
      "unresolved_questions = ?, validation_blockers = ?, rationale = ?, placement_scorecard = ?, placement_debt = ?, evidence = ?, path_actions = ?, targets = ?,",
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
    stringifyJson(proposal.pathActions),
    stringifyJson(proposal.targets),
    stringifyJson(proposal.lineage),
    proposal.diffHash,
    proposal.lastError ?? null,
    proposal.proposalId,
  );
}

function readMetaValue(db: Database.Database, key: string): string | undefined {
  if (!tableExists(db, "meta")) {
    return undefined;
  }
  const row = db.prepare("select value from meta where key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("select 1 as present from sqlite_schema where type = 'table' and name = ?")
    .get(tableName) as { present: number } | undefined;
  return Boolean(row?.present);
}
