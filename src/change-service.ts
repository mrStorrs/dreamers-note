import crypto from "crypto";
import fs from "fs";
import { spawnSync } from "child_process";
import Database from "better-sqlite3";
import { planDirectoryIndexChanges } from "./directory-index";
import { compareVaultPaths, readVaultRegularFile } from "./files";
import { openIndexDatabase, secureRuntimeFiles, type SqliteDatabase } from "./index-db";
import { refreshVaultIndex } from "./index-search";
import { classifyVaultPath } from "./path-safety";
import { ensureRuntimeReady } from "./runtime-readiness";
import {
  insertStoredChange,
  listStoredChanges,
  loadStoredChange,
  redactStoredChange,
  updateStoredChange,
} from "./change-store";
import {
  executeVaultChangeTransaction,
  withVaultChangeLock,
  type ChangeTransactionWrite,
} from "./change-transaction";
import type {
  ChangeApplyInput,
  ChangeApplyResult,
  ChangeCreateInput,
  ChangeCreateResult,
  ChangeFingerprint,
  ChangeListItem,
  ChangeShowResult,
  ChangeShowOptions,
  ChangeValidation,
  ChangeView,
  ChangeWrite,
  StoredChange,
} from "./change-contracts";
import type { Result, StructuredError } from "./types";
import type { VaultEnvironment } from "./vault-environment";

const MAX_SUMMARY_CHARS = 500;
const MAX_BODY_CHARS = 1_000_000;
const MAX_DIFF_CHARS = 12_000;
const DEFAULT_PAGE_CHARS = 1_200;
const MAX_PAGE_CHARS = 12_000;
const MAX_CHANGE_LIST_ITEMS = 50;
const MAX_CHANGE_LIST_RESULT_BYTES = 512 * 1024;
const FINALIZATION_FAILURE_HOOK_ENV = "DREAMERS_NOTE_TEST_FAIL_CHANGE_FINALIZATION";
const CREATE_SYMLINK_SWAP_HOOK_ENV = "DREAMERS_NOTE_TEST_SWAP_CREATE_TARGET_WITH_SYMLINK";

interface MaterializedChange {
  summary: string;
  writes: ChangeWrite[];
  moves: StoredChange["moves"];
  derivedPaths: string[];
}

export function createChange(
  environment: VaultEnvironment,
  input: ChangeCreateInput,
): Result<ChangeCreateResult> {
  const readiness = ensureRuntimeReady(environment);
  if (!readiness.ok) {
    return readiness;
  }
  const materialized = sanitizeChangeResult(materializeChange(environment, input));
  if (!materialized.ok) {
    return materialized;
  }
  const fingerprint = readVaultFingerprint(environment);
  if (!fingerprint.ok) {
    return fingerprint;
  }
  const fullDiff = sanitizeChangeResult(buildFullDiff(environment, materialized.value.writes, materialized.value.moves));
  if (!fullDiff.ok) {
    return fullDiff;
  }
  const now = new Date().toISOString();
  const diffHash = sha256(fullDiff.value);
  const bounded = boundDiff(fullDiff.value);
  const change: StoredChange = {
    id: crypto.randomUUID(),
    status: "pending",
    summary: materialized.value.summary,
    createdAt: now,
    updatedAt: now,
    revision: "",
    writes: materialized.value.writes,
    moves: materialized.value.moves,
    derivedPaths: materialized.value.derivedPaths,
    blockers: [],
    diffText: bounded.text,
    diffTruncated: bounded.truncated,
    diffHash,
    fingerprint: fingerprint.value,
  };
  change.revision = revisionFor(change);

  const db = openIndexDatabase(environment.databasePath);
  try {
    insertStoredChange(db, change);
    return {
      ok: true,
      value: {
        id: change.id,
        status: "pending",
        revision: change.revision,
        derivedPaths: change.derivedPaths,
        changedPaths: changedPaths(change),
      },
    };
  } catch {
    return fail("change-create-failed", "change could not be stored");
  } finally {
    db.close();
    secureRuntimeFiles(environment.databasePath);
  }
}

export function listChanges(environment: VaultEnvironment): Result<{ items: ChangeListItem[] }> {
  const db = openReadonlyDatabase(environment.databasePath);
  if (!db) {
    return { ok: true, value: { items: [] } };
  }
  try {
    const stored = listStoredChanges(db, MAX_CHANGE_LIST_ITEMS + 1);
    if (stored.length > MAX_CHANGE_LIST_ITEMS) {
      return fail("change-list-too-large", "change history exceeds the bounded list limit");
    }
    const items = stored.map((item) => isChangeCurrentlyExcluded(environment, item.changedPaths, item.derivedPaths)
      ? redactedChangeListItem(item)
      : item);
    const value = { items };
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_CHANGE_LIST_RESULT_BYTES) {
      return fail("change-list-too-large", "change history exceeds the reviewable output limit");
    }
    return {
      ok: true,
      value,
    };
  } catch {
    return fail("change-list-failed", "changes could not be listed");
  } finally {
    db.close();
  }
}

export function showChange(
  environment: VaultEnvironment,
  id: string,
  options: ChangeShowOptions = {},
): Result<ChangeShowResult> {
  const db = openReadonlyDatabase(environment.databasePath);
  if (!db) {
    return fail("change-not-found", "change was not found", id);
  }
  try {
    const loaded = loadStoredChange(db, id);
    if (!loaded.ok) {
      return loaded;
    }
    const excludedValidation = excludedChangeValidation(environment, loaded.value);
    if (excludedValidation) {
      return {
        ok: true,
        value: {
          change: redactedChangeView(loaded.value, excludedValidation),
          validation: excludedValidation,
          diff: {
            text: "Change content is unavailable because one or more paths are excluded by current policy.",
            truncated: false,
          },
        },
      };
    }
    const validation = sanitizeChangeValidation(validateChange(environment, loaded.value));
    const page = pageChangeBody(loaded.value, options);
    if (!page.ok) {
      return page as Result<ChangeShowResult>;
    }
    return {
      ok: true,
      value: {
        change: toChangeView(loaded.value, validation),
        validation,
        diff: loaded.value.diffText === undefined
          ? { text: "Change content has been redacted.", truncated: false }
          : { text: loaded.value.diffText, truncated: loaded.value.diffTruncated },
        page: page.value,
      },
    };
  } catch {
    return fail("change-show-failed", "change could not be shown");
  } finally {
    db.close();
  }
}

export function rejectChange(environment: VaultEnvironment, id: string): Result<{ id: string; status: "rejected" }> {
  if (!fs.existsSync(environment.databasePath)) {
    return fail("change-not-found", "change was not found", id);
  }
  return withVaultChangeLock(environment.runtimeDir, () => {
    const db = openIndexDatabase(environment.databasePath);
    try {
      const loaded = loadStoredChange(db, id);
      if (!loaded.ok) {
        return loaded;
      }
      if (loaded.value.status !== "pending") {
        return fail("change-not-pending", "change is not pending", id);
      }
      persistChange(db, redactStoredChange(loaded.value, "rejected"));
      return {
        ok: true,
        value: {
          id,
          status: "rejected",
        },
      };
    } catch {
      return fail("change-reject-failed", "change could not be rejected");
    } finally {
      db.close();
      secureRuntimeFiles(environment.databasePath);
    }
  });
}

export function applyChange(
  environment: VaultEnvironment,
  input: ChangeApplyInput,
): Result<ChangeApplyResult> {
  if (!isNonEmptyString(input?.id) || !isNonEmptyString(input?.revision)) {
    return fail("invalid-arguments", "change apply requires an id and revision");
  }
  if (!fs.existsSync(environment.databasePath)) {
    return fail("change-not-found", "change was not found", input.id);
  }
  const readiness = ensureRuntimeReady(environment);
  if (!readiness.ok) {
    return readiness;
  }
  const db = openIndexDatabase(environment.databasePath);
  let current: StoredChange | undefined;
  try {
    const initial = loadStoredChange(db, input.id);
    if (!initial.ok) {
      return initial;
    }
    const transaction = executeVaultChangeTransaction({
      vaultPath: environment.vaultPath,
      runtimeDir: environment.runtimeDir,
      privateGlobs: environment.privateGlobs,
      writes: transactionWrites(initial.value),
      moves: initial.value.moves.map((move) => ({
        from: move.from,
        to: move.to,
        sourceBeforeHash: preMoveWrite(initial.value, move.from)?.bodyHash ?? move.sourceBeforeHash,
        destinationBeforeHash: move.destinationBeforeHash,
      })),
      refresh: () => refreshVaultIndex({
        vaultPath: environment.vaultPath,
        databasePath: environment.databasePath,
        privateGlobs: environment.privateGlobs,
        approvedTags: environment.approvedTags,
      }),
      beforeMutate() {
        const reloaded = loadStoredChange(db, input.id);
        if (!reloaded.ok) {
          return reloaded;
        }
        current = reloaded.value;
        if (current.status !== "pending") {
          return fail("change-not-pending", "change is not pending", input.id);
        }
        if (current.revision !== initial.value.revision || current.revision !== input.revision) {
          return fail("change-revision-mismatch", "change revision no longer matches the requested apply", input.id);
        }
        const excludedValidation = excludedChangeValidation(environment, current);
        if (excludedValidation) {
          return {
            ok: false,
            error: validationError(excludedValidation),
          };
        }
        const validation = sanitizeChangeValidation(validateChange(environment, current));
        if (validation.state === "blocked") {
          return {
            ok: false,
            error: validationError(validation),
          };
        }
        return { ok: true, value: undefined };
      },
      finalize() {
        if (!current) {
          return fail("change-apply-failed", "change apply did not load a pending record");
        }
        if (process.env[FINALIZATION_FAILURE_HOOK_ENV]) {
          return fail("change-apply-failed", "change terminal state could not be persisted");
        }
        try {
          persistChange(db, redactStoredChange(current, "applied"));
          return { ok: true, value: undefined };
        } catch {
          return fail("change-apply-failed", "change terminal state could not be persisted");
        }
      },
      onFailure(failure) {
        if (!current) {
          return { ok: true, value: undefined };
        }
        try {
          persistChange(db, {
            ...current,
            updatedAt: new Date().toISOString(),
            blockers: [],
            lastError: {
              code: failure.code,
              message: failure.message,
              affectedPaths: failure.affectedPaths,
            },
          });
          return { ok: true, value: undefined };
        } catch {
          return fail("change-rollback-failed", "change recovery state could not be persisted");
        }
      },
    });
    if (!transaction.ok) {
      return {
        ok: false,
        error: sanitizeChangeError(transaction.error),
      };
    }
    if (!current) {
      return fail("change-apply-failed", "change apply did not load a pending record");
    }
    return {
      ok: true,
      value: {
        id: input.id,
        status: "applied",
        changedPaths: transaction.value.changedPaths,
      },
    };
  } catch {
    return fail("change-apply-failed", "change apply failed before completion");
  } finally {
    db.close();
    secureRuntimeFiles(environment.databasePath);
  }
}

function materializeChange(environment: VaultEnvironment, input: ChangeCreateInput): Result<MaterializedChange> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return fail("invalid-arguments", "change input must be an object");
  }
  const rawInput = input as ChangeCreateInput & Record<string, unknown>;
  if (Object.hasOwn(rawInput, "deletes") || Object.hasOwn(rawInput, "pathActions")) {
    return fail("change-delete-unsupported", "changes support full-body writes and vault moves only");
  }
  const summary = typeof rawInput.summary === "string" ? rawInput.summary.trim() : "";
  if (!summary || summary.length > MAX_SUMMARY_CHARS) {
    return fail("invalid-arguments", "change summary must be a bounded non-empty string");
  }
  const rawWrites = rawInput.writes ?? [];
  const rawMoves = rawInput.moves ?? [];
  if (!Array.isArray(rawWrites) || !Array.isArray(rawMoves)) {
    return fail("invalid-arguments", "change writes and moves must be arrays when provided");
  }
  if (rawWrites.length === 0 && rawMoves.length === 0) {
    return fail("change-empty", "change requires at least one write or move");
  }

  const writes: ChangeWrite[] = [];
  for (const rawWrite of rawWrites) {
    const write = materializeWrite(environment, rawWrite, false);
    if (!write.ok) {
      return write;
    }
    writes.push(write.value);
  }
  const moves: StoredChange["moves"] = [];
  for (const rawMove of rawMoves) {
    const move = materializeMove(environment, rawMove);
    if (!move.ok) {
      return move;
    }
    moves.push(move.value);
  }
  const explicitPaths: string[] = [];
  for (const write of writes) {
    if (hasOverlappingChangePath(explicitPaths, write.path)) {
      return fail("change-path-collision", "change contains overlapping write or move paths", write.path);
    }
    explicitPaths.push(write.path);
  }
  for (const move of moves) {
    if (moves.some((other) => other !== move && other.from === move.from)) {
      return fail("change-path-collision", "change contains overlapping write or move paths", move.from);
    }
    for (const movePath of [move.from, move.to]) {
      const pairedPreMoveWrite = movePath === move.from && writes.some((write) => write.path === move.from && write.beforeMove);
      const comparedPaths = pairedPreMoveWrite
        ? explicitPaths.filter((existing) => existing !== move.from)
        : explicitPaths;
      if (hasOverlappingChangePath(comparedPaths, movePath)) {
        return fail("change-path-collision", "change contains overlapping write or move paths", movePath);
      }
      explicitPaths.push(movePath);
    }
  }
  for (const write of writes) {
    if (write.beforeMove && !moves.some((move) => move.from === write.path)) {
      return fail("invalid-arguments", "before-move writes must pair with a move source", write.path);
    }
  }

  const derived = planDirectoryIndexChanges(
    {
      vaultPath: environment.vaultPath,
      privateGlobs: environment.privateGlobs,
      conventionPolicy: environment.conventionPolicy,
    },
    {
      targets: writes.map((write) => ({
        path: write.path,
        mode: write.beforeHash === null ? "create" : "replace",
        body: write.body as string,
      })),
      pathActions: moves.map((move) => ({
        type: "move" as const,
        scope: "vault" as const,
        path: move.from,
        destinationPath: move.to,
      })),
    },
  );
  if (!derived.ok) {
    return derived;
  }
  const derivedPaths: string[] = [];
  for (const target of derived.value.targets) {
    const write = materializeWrite(environment, target, true);
    if (!write.ok) {
      return write;
    }
    if (hasOverlappingChangePath(explicitPaths, write.value.path)) {
      return fail("change-path-collision", "derived homepage overlaps an explicit change path", write.value.path);
    }
    explicitPaths.push(write.value.path);
    writes.push(write.value);
    derivedPaths.push(write.value.path);
  }
  return {
    ok: true,
    value: {
      summary,
      writes: writes.sort((left, right) => compareVaultPaths(left.path, right.path)),
      moves: moves.sort((left, right) => compareVaultPaths(left.from, right.from) || compareVaultPaths(left.to, right.to)),
      derivedPaths: derivedPaths.sort(compareVaultPaths),
    },
  };
}

function hasOverlappingChangePath(existingPaths: string[], candidate: string): boolean {
  return existingPaths.some((existing) => existing === candidate
    || existing.startsWith(`${candidate}/`)
    || candidate.startsWith(`${existing}/`));
}

function materializeWrite(
  environment: VaultEnvironment,
  rawWrite: unknown,
  derived: boolean,
): Result<ChangeWrite> {
  if (!rawWrite || typeof rawWrite !== "object" || Array.isArray(rawWrite)) {
    return fail("invalid-arguments", "change writes must be objects");
  }
  const candidate = rawWrite as Record<string, unknown>;
  if (!isNonEmptyString(candidate.path)) {
    return fail("invalid-arguments", "change write path must be a non-empty string");
  }
  if (typeof candidate.body !== "string" || candidate.body.length === 0 || candidate.body.length > MAX_BODY_CHARS) {
    return fail("invalid-arguments", "change write body must be a bounded non-empty string");
  }
  if (Object.hasOwn(candidate, "beforeMove") && typeof candidate.beforeMove !== "boolean") {
    return fail("invalid-arguments", "change before-move marker must be boolean");
  }
  const classified = classifyVaultPath({
    vaultPath: environment.vaultPath,
    input: candidate.path,
    privateGlobs: environment.privateGlobs,
  });
  if (!classified.ok) {
    return classified;
  }
  maybeSwapCreateTargetWithSymlink(classified.value.absolutePath, classified.value.normalizedRelativePath);
  const before = inspectRegularFile(
    environment.vaultPath,
    classified.value.normalizedRelativePath,
    "change-target-invalid",
  );
  if (!before.ok) {
    return before;
  }
  return {
    ok: true,
    value: {
      path: classified.value.normalizedRelativePath,
      beforeHash: hashForFile(before.value),
      body: candidate.body,
      bodyHash: sha256(candidate.body),
      derived,
      beforeMove: candidate.beforeMove === true,
    },
  };
}

function materializeMove(environment: VaultEnvironment, rawMove: unknown): Result<StoredChange["moves"][number]> {
  if (!rawMove || typeof rawMove !== "object" || Array.isArray(rawMove)) {
    return fail("invalid-arguments", "change moves must be objects");
  }
  const candidate = rawMove as Record<string, unknown>;
  if (!isNonEmptyString(candidate.from) || !isNonEmptyString(candidate.to)) {
    return fail("invalid-arguments", "change move paths must be non-empty strings");
  }
  const from = classifyVaultPath({
    vaultPath: environment.vaultPath,
    input: candidate.from,
    privateGlobs: environment.privateGlobs,
  });
  if (!from.ok) {
    return from;
  }
  const to = classifyVaultPath({
    vaultPath: environment.vaultPath,
    input: candidate.to,
    privateGlobs: environment.privateGlobs,
  });
  if (!to.ok) {
    return to;
  }
  if (from.value.normalizedRelativePath === to.value.normalizedRelativePath) {
    return fail("invalid-arguments", "change move source and destination must differ");
  }
  const source = inspectRegularFile(environment.vaultPath, from.value.normalizedRelativePath, "change-source-invalid");
  if (!source.ok) {
    return source;
  }
  if (source.value === undefined) {
    return fail("change-source-missing", "change move source is missing", from.value.normalizedRelativePath);
  }
  const destination = inspectRegularFile(environment.vaultPath, to.value.normalizedRelativePath, "change-destination-invalid");
  if (!destination.ok) {
    return destination;
  }
  if (destination.value !== undefined) {
    return fail("change-destination-exists", "change move destination already exists", to.value.normalizedRelativePath);
  }
  return {
    ok: true,
    value: {
      from: from.value.normalizedRelativePath,
      to: to.value.normalizedRelativePath,
      sourceBeforeHash: sha256(source.value),
      destinationBeforeHash: null,
    },
  };
}

function validateChange(environment: VaultEnvironment, change: StoredChange): ChangeValidation {
  const blockers: StructuredError[] = [];
  if (change.status !== "pending") {
    blockers.push({
      code: "change-not-pending",
      message: "change is not pending",
      path: change.id,
    });
    return { state: "blocked", blockers };
  }
  if (!hasCurrentRevision(change)) {
    blockers.push({
      code: "change-revision-corrupt",
      message: "stored change revision is not internally consistent",
      path: change.id,
    });
  }
  if (taxonomyHash(environment.approvedTags) !== change.fingerprint.taxonomyHash) {
    blockers.push({
      code: "change-taxonomy-changed",
      message: "approved tags changed after change creation",
    });
  }
  if (exclusionHash(environment.privateGlobs) !== change.fingerprint.exclusionConfigHash) {
    blockers.push({
      code: "change-exclusion-config-changed",
      message: "private path configuration changed after change creation",
    });
  }
  for (const write of change.writes) {
    const current = currentHashForPath(environment, write.path, "change-target-invalid");
    if (!current.ok) {
      blockers.push(current.error);
      continue;
    }
    if (current.value !== write.beforeHash) {
      blockers.push({
        code: write.beforeHash === null ? "change-target-exists" : current.value === null ? "change-target-missing" : "change-target-changed",
        message: "change target changed after change creation",
        path: write.path,
      });
    }
  }
  for (const move of change.moves) {
    const pairedWrite = preMoveWrite(change, move.from);
    const source = currentHashForPath(environment, move.from, "change-source-invalid");
    if (!source.ok) {
      blockers.push(source.error);
    } else if (source.value === null) {
      blockers.push({ code: "change-source-missing", message: "change move source is missing", path: move.from });
    } else if (source.value !== (pairedWrite?.beforeHash ?? move.sourceBeforeHash)) {
      blockers.push({ code: "change-source-changed", message: "change move source changed after creation", path: move.from });
    }
    const destination = currentHashForPath(environment, move.to, "change-destination-invalid");
    if (!destination.ok) {
      blockers.push(destination.error);
    } else if (destination.value !== move.destinationBeforeHash) {
      blockers.push({
        code: "change-destination-changed",
        message: "change move destination changed after creation",
        path: move.to,
      });
    }
  }
  const fingerprint = readVaultFingerprint(environment);
  if (!fingerprint.ok) {
    blockers.push(fingerprint.error);
  } else {
    if (fingerprint.value.branch !== change.fingerprint.branch) {
      blockers.push({ code: "change-branch-changed", message: "vault git branch changed after change creation" });
    }
    if (fingerprint.value.gitStatusHash !== change.fingerprint.gitStatusHash) {
      blockers.push({ code: "change-git-state-changed", message: "vault git state changed after change creation" });
    }
  }
  return {
    state: blockers.length === 0 ? "current" : "blocked",
    blockers,
  };
}

function preMoveWrite(change: Pick<StoredChange, "writes">, sourcePath: string): ChangeWrite | undefined {
  return change.writes.find((write) => write.path === sourcePath && write.beforeMove);
}

function pageChangeBody(
  change: StoredChange,
  options: ChangeShowOptions,
): Result<ChangeShowResult["page"]> {
  if (!options.path) {
    if (options.offset !== undefined || options.maxChars !== undefined) {
      return fail("change-page-selection-invalid", "change page bounds require a write path");
    }
    return { ok: true, value: undefined };
  }
  const write = change.writes.find((candidate) => candidate.path === options.path);
  if (!write) {
    return fail("change-page-path-invalid", "change page path is not a stored write target");
  }
  if (typeof write.body !== "string") {
    return fail("change-content-redacted", "change content has been redacted");
  }
  const offset = options.offset ?? 0;
  const maxChars = options.maxChars ?? DEFAULT_PAGE_CHARS;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(maxChars) || maxChars < 1 || maxChars > MAX_PAGE_CHARS) {
    return fail("change-page-bounds-invalid", "change page bounds are outside the safe range");
  }
  const text = write.body.slice(offset, offset + maxChars);
  const next = offset + text.length;
  return {
    ok: true,
    value: {
      path: write.path,
      offset,
      maxChars,
      text,
      nextOffset: next < write.body.length ? next : null,
      bodyHash: write.bodyHash,
    },
  };
}

function currentHashForPath(
  environment: VaultEnvironment,
  relativePath: string,
  invalidCode: string,
): Result<string | null> {
  const classified = classifyVaultPath({
    vaultPath: environment.vaultPath,
    input: relativePath,
    privateGlobs: environment.privateGlobs,
  });
  if (!classified.ok) {
    return classified;
  }
  const inspected = inspectRegularFile(environment.vaultPath, classified.value.normalizedRelativePath, invalidCode);
  if (!inspected.ok) {
    return inspected;
  }
  return { ok: true, value: hashForFile(inspected.value) };
}

function inspectRegularFile(
  vaultPath: string,
  relativePath: string,
  invalidCode: string,
): Result<Buffer | undefined> {
  try {
    return { ok: true, value: readVaultRegularFile(vaultPath, relativePath) };
  } catch (error) {
    return fail(invalidCode, "change path could not be inspected");
  }
}

function hashForFile(content: Buffer | undefined): string | null {
  return content === undefined ? null : sha256(content);
}

function readVaultFingerprint(environment: VaultEnvironment): Result<ChangeFingerprint> {
  const branch = spawnSync("git", ["-C", environment.vaultPath, "rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
  });
  if (branch.status !== 0) {
    return fail("change-git-unavailable", "vault must be a readable git repository");
  }
  const status = spawnSync("git", ["-C", environment.vaultPath, "status", "--short"], {
    encoding: "utf8",
  });
  if (status.status !== 0) {
    return fail("change-git-unavailable", "vault git status is unavailable");
  }
  return {
    ok: true,
    value: {
      branch: branch.stdout.trim(),
      gitStatusHash: sha256(status.stdout),
      taxonomyHash: taxonomyHash(environment.approvedTags),
      exclusionConfigHash: exclusionHash(environment.privateGlobs),
    },
  };
}

function buildFullDiff(
  environment: VaultEnvironment,
  writes: ChangeWrite[],
  moves: StoredChange["moves"],
): Result<string> {
  const sections: string[] = [];
  for (const write of writes) {
    const classified = classifyVaultPath({
      vaultPath: environment.vaultPath,
      input: write.path,
      privateGlobs: environment.privateGlobs,
    });
    if (!classified.ok) {
      return classified;
    }
    const current = inspectRegularFile(
      environment.vaultPath,
      classified.value.normalizedRelativePath,
      "change-target-invalid",
    );
    if (!current.ok) {
      return current;
    }
    const currentHash = hashForFile(current.value);
    if (currentHash !== write.beforeHash) {
      return fail("change-target-changed", "change target changed during materialization", write.path);
    }
    const before = current.value?.toString("utf8") ?? "";
    sections.push(unifiedWriteDiff(write.path, before, write.body ?? ""));
  }
  for (const move of moves) {
    sections.push([`rename from ${move.from}`, `rename to ${move.to}`].join("\n"));
  }
  return {
    ok: true,
    value: sections.join("\n\n"),
  };
}

function unifiedWriteDiff(relativePath: string, before: string, after: string): string {
  const lines = [`--- a/${relativePath}`, `+++ b/${relativePath}`];
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const length = Math.max(beforeLines.length, afterLines.length);
  for (let index = 0; index < length; index += 1) {
    const left = beforeLines[index] ?? "";
    const right = afterLines[index] ?? "";
    if (left === right) {
      continue;
    }
    if (index < beforeLines.length) {
      lines.push(`- ${left}`);
    }
    if (index < afterLines.length) {
      lines.push(`+ ${right}`);
    }
  }
  return lines.join("\n");
}

function transactionWrites(change: StoredChange): ChangeTransactionWrite[] {
  return change.writes.map((write) => ({
    path: write.path,
    body: write.body ?? "",
    expectedBeforeHash: write.beforeHash,
  }));
}

function changedPaths(change: Pick<StoredChange, "writes" | "moves">): string[] {
  return [
    ...new Set([
      ...change.writes.map((write) => write.path),
      ...change.moves.flatMap((move) => [move.from, move.to]),
    ]),
  ].sort(compareVaultPaths);
}

function persistChange(db: SqliteDatabase, change: StoredChange): void {
  db.transaction(() => updateStoredChange(db, change))();
}

function excludedChangeValidation(
  environment: VaultEnvironment,
  change: StoredChange,
): ChangeValidation | undefined {
  if (!isChangeCurrentlyExcluded(environment, changedPaths(change), change.derivedPaths)) {
    return undefined;
  }
  if (exclusionHash(environment.privateGlobs) !== change.fingerprint.exclusionConfigHash) {
    return {
      state: "blocked",
      blockers: [{
        code: "change-exclusion-config-changed",
        message: "private path configuration changed after change creation",
      }],
    };
  }
  return {
    state: "blocked",
    blockers: [{
      code: "private-path",
      message: "change includes a path excluded by current policy",
    }],
  };
}

function isChangeCurrentlyExcluded(
  environment: VaultEnvironment,
  paths: string[],
  derivedPaths: string[],
): boolean {
  return [...paths, ...derivedPaths].some((relativePath) => {
    const classified = classifyVaultPath({
      vaultPath: environment.vaultPath,
      input: relativePath,
      privateGlobs: environment.privateGlobs,
    });
    return !classified.ok && isPolicyPathError(classified.error);
  });
}

function redactedChangeListItem(item: ChangeListItem): ChangeListItem {
  return {
    ...item,
    summary: "Change details are unavailable because one or more paths are excluded by current policy.",
    changedPaths: [],
    derivedPaths: [],
    lastError: undefined,
  };
}

function redactedChangeView(change: StoredChange, validation: ChangeValidation): ChangeView {
  return {
    id: change.id,
    status: change.status,
    summary: "Change details are unavailable because one or more paths are excluded by current policy.",
    createdAt: change.createdAt,
    updatedAt: change.updatedAt,
    revision: change.revision,
    writes: [],
    moves: [],
    derivedPaths: [],
    blockers: validation.blockers,
  };
}

function toChangeView(change: StoredChange, validation: ChangeValidation): ChangeView {
  return {
    id: change.id,
    status: change.status,
    summary: change.summary,
    createdAt: change.createdAt,
    updatedAt: change.updatedAt,
    revision: change.revision,
    writes: change.writes.map(({ path: writePath, beforeHash, bodyHash, derived, beforeMove }) => ({
      path: writePath,
      beforeHash,
      bodyHash,
      derived,
      beforeMove,
    })),
    moves: change.moves,
    derivedPaths: change.derivedPaths,
    blockers: validation.blockers,
    lastError: change.lastError,
  };
}

function validationError(validation: ChangeValidation): StructuredError {
  const sanitized = sanitizeChangeValidation(validation);
  const first = sanitized.blockers[0] ?? {
    code: "change-validation-failed",
    message: "change validation failed",
  };
  return {
    ...first,
    causes: sanitized.blockers,
  };
}

function sanitizeChangeValidation(validation: ChangeValidation): ChangeValidation {
  return {
    state: validation.state,
    blockers: validation.blockers.map(sanitizeChangeError),
  };
}

function sanitizeChangeResult<T>(result: Result<T>): Result<T> {
  if (result.ok) {
    return result;
  }
  return {
    ok: false,
    error: sanitizeChangeError(result.error),
  };
}

function sanitizeChangeError(error: StructuredError): StructuredError {
  if (isPolicyPathError(error)) {
    return {
      code: error.code,
      message: "change path is excluded by current policy",
    };
  }
  return {
    ...error,
    causes: error.causes?.map(sanitizeChangeError),
  };
}

function isPolicyPathError(error: StructuredError): boolean {
  return error.code === "private-path" || error.code === "excluded-root";
}

function hasCurrentRevision(change: StoredChange): boolean {
  if (change.writes.some((write) => typeof write.body !== "string" || sha256(write.body) !== write.bodyHash)) {
    return false;
  }
  return change.revision === revisionFor(change);
}

function revisionFor(change: Pick<StoredChange, "writes" | "moves" | "diffHash" | "fingerprint">): string {
  return sha256(JSON.stringify({
    writes: change.writes.map((write) => ({
      path: write.path,
      beforeHash: write.beforeHash,
      body: write.body,
      bodyHash: write.bodyHash,
      derived: write.derived,
      beforeMove: write.beforeMove,
    })),
    moves: change.moves.map((move) => ({
      from: move.from,
      to: move.to,
      sourceBeforeHash: move.sourceBeforeHash,
      destinationBeforeHash: move.destinationBeforeHash,
    })),
    diffHash: change.diffHash,
    fingerprint: change.fingerprint,
  }));
}

function boundDiff(diff: string): { text: string; truncated: boolean } {
  if (diff.length <= MAX_DIFF_CHARS) {
    return { text: diff, truncated: false };
  }
  return {
    text: `${diff.slice(0, MAX_DIFF_CHARS - 3)}...`,
    truncated: true,
  };
}

function taxonomyHash(tags: string[]): string {
  return sha256(JSON.stringify([...new Set(tags)].sort()));
}

function exclusionHash(privateGlobs: string[]): string {
  return sha256(JSON.stringify([...new Set(privateGlobs)].sort()));
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function openReadonlyDatabase(databasePath: string): SqliteDatabase | undefined {
  if (!fs.existsSync(databasePath)) {
    return undefined;
  }
  return new Database(databasePath, { readonly: true, fileMustExist: true });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function maybeSwapCreateTargetWithSymlink(absolutePath: string, relativePath: string): void {
  const hook = process.env[CREATE_SYMLINK_SWAP_HOOK_ENV];
  if (!hook) {
    return;
  }
  const [target, referent] = hook.split("::", 2);
  if (target !== relativePath || !referent) {
    return;
  }
  try {
    fs.unlinkSync(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  fs.symlinkSync(referent, absolutePath);
}

function fail<T>(code: string, message: string, pathValue?: string): Result<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      path: pathValue,
    },
  };
}
