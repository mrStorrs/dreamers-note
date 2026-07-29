import fs from "fs";
import path from "path";
import { planDirectoryIndexChanges, planDirectoryIndexRepairs } from "./directory-index";
import { compareVaultPaths, fileHash } from "./files";
import { inspectImportSource } from "./import-source";
import type { SqliteDatabase } from "./index-db";
import { classifyVaultPath } from "./path-safety";
import {
  asStructuredResult,
  boundExcerpt,
  DEFAULT_PROPOSAL_EXPIRY_DAYS,
  fail,
  isRecord,
  nonEmptyString,
  PROPOSAL_EXCERPT_LIMIT,
  structured,
  uniqueStrings,
} from "./proposal-common";
import { normalizePathActions } from "./proposal-path-actions";
import { buildProposalTargets } from "./proposal-targets";
import type {
  ProposalCreateInput,
  ProposalEnvironment,
  ProposalEvidence,
  ProposalPathAction,
  ProposalPlacementDebt,
  ProposalPlacementDestination,
  ProposalTarget,
  StoredProposal,
} from "./proposal-types";
import type { Result } from "./types";

export interface NormalizedProposalMetadata {
  operation: string;
  bundleId?: string;
  contextPackId?: string;
  sourceChunkIds: string[];
  approvedTags: string[];
  proposedTagGaps: string[];
  unresolvedQuestions: string[];
  validationBlockers: string[];
  dependencies: string[];
  rationale: string;
  placementScorecard?: Record<string, unknown>;
}

export interface NormalizedCreateInput extends NormalizedProposalMetadata {
  candidatePaths: string[];
  placementDebt?: ProposalPlacementDebt;
  evidence: ProposalEvidence[];
  pathActions: ProposalPathAction[];
  targets: ProposalTarget[];
  sourceHashes: Record<string, string>;
  externalSourceHashes: Record<string, string>;
  candidateHashes: Record<string, string | null>;
}

export interface NormalizeCreateInputDependencies {
  openDatabase(databasePath: string): SqliteDatabase;
  loadProposalById(db: SqliteDatabase, proposalId: string): Result<StoredProposal>;
  closeDatabase(db: SqliteDatabase): void;
}

export interface NormalizeCreateInputOptions {
  directoryIndexRepairPaths?: string[];
}

export function normalizeProposalMetadata(
  input: ProposalCreateInput,
  approvedTagList: string[],
): Result<NormalizedProposalMetadata> {
  const operation = (input.operation ?? "").trim();
  if (!operation) {
    return fail("invalid-arguments", "operation must be a non-empty string");
  }
  if (!Array.isArray(input.sourceChunkIds)) {
    return fail("invalid-arguments", "sourceChunkIds must be an array when provided");
  }
  const approvedTags = uniqueStrings(input.approvedTags);
  const invalidTag = approvedTags.find((tag) => !approvedTagList.includes(tag));
  if (invalidTag) {
    return fail("proposal-unapproved-tag", `tag is not approved: ${invalidTag}`, { tag: invalidTag });
  }
  const rationale = String(input.rationale ?? "").trim();
  if (!rationale) {
    return fail("invalid-arguments", "rationale must be a non-empty string");
  }

  return {
    ok: true,
    value: {
      operation,
      bundleId: nonEmptyString(input.bundleId),
      contextPackId: nonEmptyString(input.contextPackId),
      sourceChunkIds: [...new Set(input.sourceChunkIds)],
      approvedTags,
      proposedTagGaps: uniqueStrings(input.proposedTagGaps),
      unresolvedQuestions: uniqueStrings(input.unresolvedQuestions),
      validationBlockers: uniqueStrings(input.validationBlockers),
      dependencies: uniqueStrings(input.dependencies),
      rationale,
      placementScorecard: isRecord(input.placementScorecard) ? input.placementScorecard : undefined,
    },
  };
}

export function normalizeCreateInput(
  environment: ProposalEnvironment,
  input: ProposalCreateInput,
  dependencies: NormalizeCreateInputDependencies,
  options: NormalizeCreateInputOptions = {},
): Result<NormalizedCreateInput> {
  const metadata = normalizeProposalMetadata(input, environment.approvedTags);
  if (!metadata.ok) {
    return metadata;
  }
  const explicitTargets = buildProposalTargets(environment, input.targets);
  if (!explicitTargets.ok) {
    return explicitTargets;
  }
  const pathActions = normalizePathActions(environment, input.pathActions ?? []);
  if (!pathActions.ok) {
    return pathActions;
  }
  const explicitTargetPaths = new Set<string>();
  for (const target of explicitTargets.value) {
    if (explicitTargetPaths.has(target.path)) {
      return fail("proposal-target-collision", "proposal contains duplicate normalized target paths", {
        path: target.path,
      });
    }
    explicitTargetPaths.add(target.path);
  }
  const vaultActionPaths = new Set<string>();
  for (const action of pathActions.value) {
    if (action.scope !== "vault") {
      continue;
    }
    for (const actionPath of [action.path, action.destinationPath]) {
      if (isDirectoryHomepagePath(actionPath, environment)) {
        return fail("proposal-path-collision", "vault path actions cannot move a directory homepage", {
          path: actionPath,
        });
      }
      if (vaultActionPaths.has(actionPath)) {
        return fail("proposal-path-collision", "vault path actions contain an overlapping source or destination", {
          path: actionPath,
        });
      }
      vaultActionPaths.add(actionPath);
    }
    if (explicitTargetPaths.has(action.path) || explicitTargetPaths.has(action.destinationPath)) {
      return fail("proposal-path-collision", "proposal target overlaps a vault path action", {
        path: explicitTargetPaths.has(action.path) ? action.path : action.destinationPath,
      });
    }
  }
  const directoryEnvironment = {
    vaultPath: environment.vaultPath,
    privateGlobs: environment.privateGlobs,
    conventionPolicy: environment.conventionPolicy,
  };
  const derivedIndexes = options.directoryIndexRepairPaths
    ? planDirectoryIndexRepairs(directoryEnvironment, {
        paths: options.directoryIndexRepairPaths,
      })
    : planDirectoryIndexChanges(
        directoryEnvironment,
        {
          targets: explicitTargets.value,
          pathActions: pathActions.value,
        },
      );
  if (!derivedIndexes.ok) {
    return derivedIndexes;
  }
  if (options.directoryIndexRepairPaths && derivedIndexes.value.targets.length === 0) {
    return fail("directory-index-no-drift", "selected directory homepages have no current drift");
  }
  const derivedTargets = buildProposalTargets(
    environment,
    derivedIndexes.value.targets.map((target) => ({
      path: target.path,
      mode: target.mode,
      body: target.body,
    })),
  );
  if (!derivedTargets.ok) {
    return derivedTargets;
  }
  for (const target of derivedTargets.value) {
    if (vaultActionPaths.has(target.path)) {
      return fail("proposal-path-collision", "derived directory homepage overlaps a vault path action", {
        path: target.path,
      });
    }
  }
  const targetMap = new Map(explicitTargets.value.map((target) => [target.path, target]));
  for (const target of derivedTargets.value) {
    targetMap.set(target.path, target);
  }
  const targets = [...targetMap.values()].sort((left, right) => compareVaultPaths(left.path, right.path));
  if (targets.length === 0 && pathActions.value.length === 0) {
    return fail("invalid-arguments", "proposal_create requires at least one target or path action");
  }
  const placementDebt = normalizePlacementDebt(environment, input.placementDebt, targets);
  if (!placementDebt.ok) {
    return placementDebt;
  }

  const db = dependencies.openDatabase(environment.databasePath);
  try {
    for (const dependencyId of metadata.value.dependencies) {
      const dependency = dependencies.loadProposalById(db, dependencyId);
      if (!dependency.ok) {
        throw structured("proposal-dependency-missing", `dependency proposal not found: ${dependencyId}`);
      }
      if (dependency.value.bundleId && metadata.value.bundleId && dependency.value.bundleId !== metadata.value.bundleId) {
        throw structured("proposal-dependency-bundle-mismatch", `dependency belongs to bundle ${dependency.value.bundleId}`);
      }
    }

    const sourceRows = metadata.value.sourceChunkIds.map((chunkId) => {
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
      provenance: "indexed-vault",
    }));
    const sourceHashes: Record<string, string> = Object.fromEntries(
      [...new Set(sourceRows.map((row) => row.relative_path))].map((relativePath) => {
        const absolutePath = path.join(environment.vaultPath, relativePath);
        return [relativePath, fileHash(absolutePath)];
      }),
    );
    const externalSourceHashes: Record<string, string> = {};
    for (const item of input.evidence ?? []) {
      const classified = classifyVaultPath({
        vaultPath: environment.vaultPath,
        input: item.path,
        privateGlobs: environment.privateGlobs,
      });
      if (classified.ok) {
        if (!sourceHashes[classified.value.normalizedRelativePath]) {
          throw structured(
            "proposal-vault-evidence-requires-source-chunk",
            `vault evidence requires a cited source chunk: ${classified.value.normalizedRelativePath}`,
          );
        }
        continue;
      }
      const inspection = inspectImportSource({
        rootDir: environment.rootDir,
        vaultPath: environment.vaultPath,
        privateGlobs: environment.privateGlobs,
        inputPath: item.path,
        explicitPathProvided: true,
      });
      if (!inspection.ok) {
        throw structured(inspection.error.code, inspection.error.message, inspection.error.path);
      }
      externalSourceHashes[inspection.value.absolutePath] = inspection.value.hash;
      evidence.push({
        path: inspection.value.absolutePath,
        excerpt: nonEmptyString(item.excerpt) ?? boundExcerpt(inspection.value.preview, PROPOSAL_EXCERPT_LIMIT),
        provenance: "external-file",
      });
    }
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
    return {
      ok: true,
      value: {
        ...metadata.value,
        candidatePaths,
        placementDebt: placementDebt.value,
        evidence,
        pathActions: pathActions.value,
        targets,
        sourceHashes,
        externalSourceHashes,
        candidateHashes,
      },
    };
  } catch (error) {
    return asStructuredResult(error);
  } finally {
    dependencies.closeDatabase(db);
  }
}

function isDirectoryHomepagePath(
  relativePath: string,
  environment: ProposalEnvironment,
): boolean {
  const directory = path.posix.dirname(relativePath);
  const folderName = path.posix.basename(directory);
  return path.posix.basename(relativePath)
    === environment.conventionPolicy.directoryIndex.filenamePattern.replace("<folder-name>", folderName);
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
    ?? new Date(Date.now() + DEFAULT_PROPOSAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
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
