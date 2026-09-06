import crypto from "crypto";
import fs from "fs";
import path from "path";
import { compareVaultPaths } from "./files";
import { classifyVaultPath } from "./path-safety";
import type { Result, StructuredError } from "./types";

const LOCK_STALE_MS = 10_000;
const WRITER_LOCK_FILENAME = "proposal-apply.lock";
const FAILURE_HOOK_ENV = "DREAMERS_NOTE_TEST_FAIL_AFTER_WRITE";
const SYMLINK_SWAP_HOOK_ENV = "DREAMERS_NOTE_TEST_SWAP_TARGET_WITH_SYMLINK";
const HARD_LINK_SWAP_HOOK_ENV = "DREAMERS_NOTE_TEST_SWAP_TARGET_WITH_HARD_LINK";
const CONTENT_SWAP_HOOK_ENV = "DREAMERS_NOTE_TEST_SWAP_TARGET_WITH_CONTENT";
const POST_HASH_CONTENT_SWAP_HOOK_ENV = "DREAMERS_NOTE_TEST_SWAP_TARGET_AFTER_HASH_WITH_CONTENT";
const ROLLBACK_REPLACEMENT_HOOK_ENV = "DREAMERS_NOTE_TEST_SWAP_ROLLBACK_TARGET_WITH_CONTENT";
const POST_TRUNCATE_CONTENT_SWAP_HOOK_ENV = "DREAMERS_NOTE_TEST_SWAP_TARGET_AFTER_TRUNCATE_WITH_CONTENT";
const ROLLBACK_CONTENT_MUTATION_HOOK_ENV = "DREAMERS_NOTE_TEST_MUTATE_ROLLBACK_TARGET_WITH_CONTENT";
const POST_MUTATION_JOURNAL_HOOK_ENV = "DREAMERS_NOTE_TEST_MUTATE_TARGET_BEFORE_OWNERSHIP_JOURNAL";
const SETUP_FAILURE_HOOK_ENV = "DREAMERS_NOTE_TEST_FAIL_AFTER_SETUP";
const O_PATH_LINUX = 0x200000;

interface LockHandle {
  lockPath: string;
  fd: number;
  device: number;
  inode: number;
}

interface VaultParent {
  fd: number;
  leaf: string;
  createdDirectories: string[];
}

interface PinnedRegularFile {
  fd: number;
  created: boolean;
}

interface FileIdentity {
  device: number;
  inode: number;
}

type NamespaceExpectation =
  | { state: "file"; identity: FileIdentity; contentHash?: string; provisional?: boolean }
  | { state: "missing" };

interface SecureMutationOptions {
  beforeMutation?: (createdDirectories: string[], identity: FileIdentity) => void;
  afterMutation?: (identity: FileIdentity, content: Buffer) => void;
  onDirectoryCreated?: (directory: string) => void;
  onLeafCreated?: (identity: FileIdentity) => void;
  expectedBeforeHash?: string | null;
  expectedIdentity?: FileIdentity;
  expectedContentHash?: string;
  triggerFailureHook?: boolean;
  invokeRaceHooks?: boolean;
}

export interface ChangeTransactionWrite {
  path: string;
  body: string | Buffer | ((current: Buffer | undefined) => string | Buffer);
  expectedBeforeHash?: string | null;
}

export interface ChangeTransactionMove {
  from: string;
  to: string;
  sourceBeforeHash?: string;
  destinationBeforeHash?: string | null;
}

export interface ChangeTransactionExternalDelete {
  path: string;
}

export interface ChangeTransactionOptions {
  vaultPath: string;
  runtimeDir: string;
  privateGlobs: string[];
  writes: ChangeTransactionWrite[];
  moves: ChangeTransactionMove[];
  externalDeletes?: ChangeTransactionExternalDelete[];
  refresh: () => Result<unknown>;
  beforeMutate?: () => Result<void>;
  finalize?: () => Result<void>;
  onFailure?: (failure: ChangeTransactionFailure) => Result<void>;
  onRefusal?: (refusal: StructuredError) => Result<void>;
}

export interface ChangeTransactionResult {
  changedPaths: string[];
  deletedExternalPaths: string[];
}

export interface ChangeTransactionFailure {
  code: "change-apply-failed" | "change-rollback-failed";
  message: string;
  affectedPaths: string[];
}

export function executeVaultChangeTransaction(
  options: ChangeTransactionOptions,
): Result<ChangeTransactionResult> {
  return withVaultChangeLock(options.runtimeDir, () => executeLockedVaultChangeTransaction(options));
}

export function withVaultChangeLock<T>(runtimeDir: string, callback: () => Result<T>): Result<T> {
  let lock: LockHandle | undefined;
  try {
    lock = acquireWriterLock(runtimeDir);
    if (!lock) {
      return fail("change-apply-locked", "another change lifecycle operation already owns the write lock");
    }
    return callback();
  } catch {
    return fail("change-apply-failed", "change lifecycle operation failed before completion");
  } finally {
    if (lock) {
      releaseWriterLock(lock);
    }
  }
}

function executeLockedVaultChangeTransaction(options: ChangeTransactionOptions): Result<ChangeTransactionResult> {
  const affectedPaths = collectVaultPaths(options);
  const originals = new Map<string, Buffer | undefined>();
  try {
    const ready = options.beforeMutate?.();
    if (ready && !ready.ok) {
      return ready;
    }
    for (const relativePath of affectedPaths) {
      const classified = classifyVaultPath({
        vaultPath: options.vaultPath,
        input: relativePath,
        privateGlobs: options.privateGlobs,
      });
      if (!classified.ok) {
        return fail(classified.error.code, classified.error.message, classified.error.path);
      }
      originals.set(classified.value.normalizedRelativePath, secureReadVaultFile(options.vaultPath, classified.value.normalizedRelativePath));
    }
  } catch {
    return notifyFailure(options, {
      code: "change-apply-failed",
      message: "change apply failed before mutation could begin",
      affectedPaths,
    });
  }

  const createdDirectories = new Set<string>();
  const createdLeaves = new Map<string, FileIdentity>();
  const rollbackOwnership = new Map<string, NamespaceExpectation>();
  const externalBackups = new Map<string, Buffer>();
  const touchedPaths = new Set<string>();
  try {
    let writesCompleted = 0;
    for (const write of [...options.writes].sort((left, right) => compareVaultPaths(left.path, right.path))) {
      const current = originals.get(write.path);
      const body = typeof write.body === "function" ? write.body(current) : write.body;
      if (typeof body !== "string" && !Buffer.isBuffer(body)) {
        throw new Error("change write body is invalid");
      }
      secureWriteVaultFile(
        options.vaultPath,
        write.path,
        body,
        {
          expectedBeforeHash: write.expectedBeforeHash,
          invokeRaceHooks: true,
          beforeMutation: (directories, identity) => {
            directories.forEach((directory) => createdDirectories.add(directory));
            touchedPaths.add(write.path);
            rollbackOwnership.set(write.path, { state: "file", identity });
          },
          afterMutation: (identity, content) => {
            rollbackOwnership.set(write.path, {
              state: "file",
              identity,
              contentHash: fileContentHash(content),
            });
          },
          onDirectoryCreated: (directory) => {
            createdDirectories.add(directory);
            maybeTriggerSetupFailure("directory-created");
          },
          onLeafCreated: (identity) => {
            touchedPaths.add(write.path);
            createdLeaves.set(write.path, identity);
            rollbackOwnership.set(write.path, {
              state: "file",
              identity,
              contentHash: fileContentHash(Buffer.alloc(0)),
              provisional: true,
            });
            maybeTriggerSetupFailure("leaf-created");
          },
        },
      );
      writesCompleted += 1;
      maybeSwapRollbackTargetWithContent(options.vaultPath, write.path);
      maybeMutateRollbackTargetWithContent(options.vaultPath, write.path);
      maybeTriggerApplyFailure("target-write", writesCompleted);
    }

    for (const move of [...options.moves].sort(compareMoves)) {
      secureRenameVaultFile(
        options.vaultPath,
        move.from,
        move.to,
        {
          expectedBeforeHash: move.sourceBeforeHash,
          invokeRaceHooks: true,
          beforeMutation: (directories, identity) => {
            directories.forEach((directory) => createdDirectories.add(directory));
            touchedPaths.add(move.from);
            touchedPaths.add(move.to);
            rollbackOwnership.set(move.from, { state: "file", identity });
            rollbackOwnership.set(move.to, { state: "missing" });
          },
          afterMutation: (identity, content) => {
            rollbackOwnership.set(move.from, { state: "missing" });
            rollbackOwnership.set(move.to, {
              state: "file",
              identity,
              contentHash: fileContentHash(content),
            });
          },
          onDirectoryCreated: (directory) => {
            createdDirectories.add(directory);
            maybeTriggerSetupFailure("directory-created");
          },
        },
        move.destinationBeforeHash,
      );
      maybeSwapRollbackTargetWithContent(options.vaultPath, move.from);
      maybeSwapRollbackTargetWithContent(options.vaultPath, move.to);
      maybeMutateRollbackTargetWithContent(options.vaultPath, move.from);
      maybeMutateRollbackTargetWithContent(options.vaultPath, move.to);
    }

    const deletedExternalPaths: string[] = [];
    for (const item of options.externalDeletes ?? []) {
      const backup = fs.readFileSync(item.path);
      externalBackups.set(item.path, backup);
      fs.unlinkSync(item.path);
      deletedExternalPaths.push(item.path);
    }
    maybeTriggerApplyFailure("after-path-actions");

    const refreshed = options.refresh();
    if (!refreshed.ok) {
      throw new Error("change index refresh failed");
    }
    maybeTriggerApplyFailure("after-refresh");
    const finalized = options.finalize?.();
    if (finalized && !finalized.ok) {
      throw new Error("change terminal state could not be persisted");
    }
    return {
      ok: true,
      value: {
        changedPaths: affectedPaths,
        deletedExternalPaths,
      },
    };
  } catch (error) {
    const refusal = error instanceof TransactionRefusal ? error.error : undefined;
    const restoredVault = restoreVaultFiles(
      options.vaultPath,
      originalsForPaths(originals, touchedPaths),
      createdDirectories,
      createdLeaves,
      rollbackOwnership,
    );
    const restoredExternal = restoreExternalFiles(externalBackups);
    const repaired = options.refresh();
    if (!restoredVault || !restoredExternal || !repaired.ok) {
      return notifyFailure(options, {
        code: "change-rollback-failed",
        message: "change apply failed and rollback could not be completed",
        affectedPaths,
      });
    }
    if (refusal) {
      const recorded = options.onRefusal?.(refusal);
      if (recorded && !recorded.ok) {
        return fail(
          "change-rollback-failed",
          "change apply refusal could not persist its terminal recovery state",
        );
      }
      return {
        ok: false,
        error: refusal,
      };
    }
    return notifyFailure(options, {
      code: "change-apply-failed",
      message: "change apply failed and was rolled back",
      affectedPaths,
    });
  }
}

function collectVaultPaths(options: ChangeTransactionOptions): string[] {
  return [
    ...new Set([
      ...options.writes.map((write) => write.path),
      ...options.moves.flatMap((move) => [move.from, move.to]),
    ]),
  ].sort(compareVaultPaths);
}

function compareMoves(left: ChangeTransactionMove, right: ChangeTransactionMove): number {
  return compareVaultPaths(left.from, right.from) || compareVaultPaths(left.to, right.to);
}

function acquireWriterLock(runtimeDir: string): LockHandle | undefined {
  const lockPath = path.join(runtimeDir, WRITER_LOCK_FILENAME);
  try {
    return openWriterLock(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs <= LOCK_STALE_MS) {
      return undefined;
    }
    if (lockOwnerIsLive(lockPath)) {
      return undefined;
    }
    const reclaimedPath = `${lockPath}.${process.pid}.${crypto.randomUUID()}.stale`;
    try {
      fs.renameSync(lockPath, reclaimedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    try {
      fs.unlinkSync(reclaimedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    return openWriterLock(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return undefined;
    }
    throw error;
  }
}

function openWriterLock(lockPath: string): LockHandle {
  const fd = fs.openSync(lockPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    const stat = fs.fstatSync(fd);
    return { lockPath, fd, device: stat.dev, inode: stat.ino };
  } catch (error) {
    try {
      fs.closeSync(fd);
      fs.unlinkSync(lockPath);
    } catch {
      // The next caller can use the stale-lock path if setup cleanup also fails.
    }
    throw error;
  }
}

function releaseWriterLock(lock: LockHandle): void {
  try {
    const current = fs.lstatSync(lock.lockPath);
    if (current.dev === lock.device && current.ino === lock.inode) {
      fs.unlinkSync(lock.lockPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  } finally {
    try {
      fs.closeSync(lock.fd);
    } catch {
      // The path ownership check above remains authoritative if close fails.
    }
  }
}

function lockOwnerIsLive(lockPath: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return true;
  }
  let pid: unknown;
  try {
    pid = JSON.parse(raw).pid;
  } catch {
    return true;
  }
  if (!Number.isInteger(pid) || (pid as number) <= 0) {
    return false;
  }
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function restoreVaultFiles(
  vaultPath: string,
  originals: Map<string, Buffer | undefined>,
  createdDirectories: Set<string>,
  createdLeaves: Map<string, FileIdentity>,
  rollbackOwnership: Map<string, NamespaceExpectation>,
): boolean {
  let restored = true;
  for (const [relativePath, original] of originals.entries()) {
    try {
      const createdLeaf = createdLeaves.get(relativePath);
      const expectation = rollbackOwnership.get(relativePath)
        ?? (createdLeaf
          ? {
              state: "file",
              identity: createdLeaf,
              contentHash: fileContentHash(Buffer.alloc(0)),
              provisional: true,
            } as const
          : undefined);
      if (!secureRestoreVaultFile(vaultPath, relativePath, original, expectation)) {
        restored = false;
      }
    } catch {
      restored = false;
    }
  }
  for (const directory of [...createdDirectories].sort((left, right) => right.localeCompare(left))) {
    try {
      fs.rmdirSync(directory);
    } catch {
      // A non-empty directory cannot be removed safely during rollback cleanup.
    }
  }
  return restored;
}

function restoreExternalFiles(backups: Map<string, Buffer>): boolean {
  let restored = true;
  for (const [targetPath, backup] of backups.entries()) {
    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(targetPath, backup, { mode: 0o600 });
    } catch {
      restored = false;
    }
  }
  return restored;
}

function originalsForPaths(
  originals: Map<string, Buffer | undefined>,
  paths: Set<string>,
): Map<string, Buffer | undefined> {
  return new Map([...originals].filter(([relativePath]) => paths.has(relativePath)));
}

function assertExpectedHashForContent(
  current: Buffer | undefined,
  expectedHash: string | null | undefined,
  role: "target" | "source" | "destination",
  relativePath: string,
): void {
  if (expectedHash === undefined) {
    return;
  }
  const currentHash = current === undefined
    ? null
    : crypto.createHash("sha256").update(current).digest("hex");
  if (currentHash === expectedHash) {
    return;
  }
  throw new TransactionRefusal(expectedHashError(role, expectedHash, currentHash, relativePath));
}

function expectedHashError(
  role: "target" | "source" | "destination",
  expectedHash: string | null,
  currentHash: string | null,
  relativePath: string,
): StructuredError {
  if (role === "target") {
    if (expectedHash === null && currentHash !== null) {
      return {
        code: "change-target-exists",
        message: "change target appeared before mutation",
        path: relativePath,
      };
    }
    if (currentHash === null) {
      return {
        code: "change-target-missing",
        message: "change target disappeared before mutation",
        path: relativePath,
      };
    }
    return {
      code: "change-target-changed",
      message: "change target changed before mutation",
      path: relativePath,
    };
  }
  if (role === "source") {
    if (currentHash === null) {
      return {
        code: "change-source-missing",
        message: "change move source disappeared before mutation",
        path: relativePath,
      };
    }
    return {
      code: "change-source-changed",
      message: "change move source changed before mutation",
      path: relativePath,
    };
  }
  return {
    code: "change-destination-changed",
    message: "change move destination changed before mutation",
    path: relativePath,
  };
}

function assertPinnedPathStillMatches(
  parentFd: number,
  leaf: string,
  pinned: PinnedRegularFile | undefined,
  expectedHash: string | null | undefined,
  expectedIdentity: FileIdentity | undefined,
  role: "target" | "source" | "destination",
  relativePath: string,
): void {
  if (expectedHash === undefined && !expectedIdentity) {
    return;
  }
  let current: fs.Stats | undefined;
  try {
    current = fs.lstatSync(fdPath(parentFd, leaf));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new TransactionRefusal({
        code: `change-${role}-invalid`,
        message: `change ${role} could not be securely inspected before mutation`,
        path: relativePath,
      });
    }
  }
  if (!pinned) {
    if (current === undefined && !expectedIdentity) {
      return;
    }
    if (expectedHash !== undefined) {
      throw new TransactionRefusal(expectedHashError(role, expectedHash, "present", relativePath));
    }
    throw new TransactionRefusal({
      code: "change-rollback-ownership-lost",
      message: "change rollback target no longer belongs to this transaction",
      path: relativePath,
    });
  }
  const pinnedStat = fs.fstatSync(pinned.fd);
  if (
    !current
    || !current.isFile()
    || current.nlink !== 1
    || current.dev !== pinnedStat.dev
    || current.ino !== pinnedStat.ino
    || (expectedIdentity !== undefined
      && (pinnedStat.dev !== expectedIdentity.device || pinnedStat.ino !== expectedIdentity.inode))
  ) {
    if (expectedHash !== undefined) {
      throw new TransactionRefusal(expectedHashError(
        role,
        expectedHash,
        current === undefined ? null : "changed",
        relativePath,
      ));
    }
    throw new TransactionRefusal({
      code: "change-rollback-ownership-lost",
      message: "change rollback target no longer belongs to this transaction",
      path: relativePath,
    });
  }
}

function notifyFailure(
  options: ChangeTransactionOptions,
  failure: ChangeTransactionFailure,
): Result<never> {
  const reported = options.onFailure?.(failure);
  if (reported && !reported.ok) {
    return fail(
      "change-rollback-failed",
      "change apply rollback completed but its recovery state could not be persisted",
      undefined,
      failure.affectedPaths,
    );
  }
  return fail(failure.code, failure.message, undefined, failure.affectedPaths);
}

class TransactionRefusal extends Error {
  constructor(readonly error: StructuredError) {
    super(error.message);
  }
}

function secureReadVaultFile(vaultPath: string, relativePath: string): Buffer | undefined {
  let parent: VaultParent;
  try {
    parent = secureEnsureVaultParent(vaultPath, relativePath, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  try {
    return readPinnedRegularFile(parent.fd, parent.leaf);
  } finally {
    fs.closeSync(parent.fd);
  }
}

function readPinnedRegularFile(parentFd: number, leaf: string): Buffer | undefined {
  const pinned = openPinnedRegularFileIfPresent(parentFd, leaf);
  if (!pinned) {
    return undefined;
  }
  try {
    return readOpenedPinnedFile(pinned);
  } finally {
    fs.closeSync(pinned.fd);
  }
}

function openPinnedRegularFileIfPresent(parentFd: number, leaf: string): PinnedRegularFile | undefined {
  try {
    return openPinnedRegularFile(parentFd, leaf, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function readOpenedPinnedFile(pinned: PinnedRegularFile): Buffer {
  const fd = fs.openSync(fdSelfPath(pinned.fd), fs.constants.O_RDONLY);
  try {
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fileIdentity(fd: number): FileIdentity {
  const stat = fs.fstatSync(fd);
  return { device: stat.dev, inode: stat.ino };
}

function fileContentHash(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function secureWriteVaultFile(
  vaultPath: string,
  relativePath: string,
  content: string | Buffer,
  options: SecureMutationOptions = {},
): string[] {
  if (options.invokeRaceHooks) {
    maybeSwapTargetWithSymlink(vaultPath, relativePath);
    maybeSwapTargetWithHardLink(vaultPath, relativePath);
    maybeSwapTargetWithContent(vaultPath, relativePath);
  }
  const parent = secureEnsureVaultParent(vaultPath, relativePath, true, options.onDirectoryCreated);
  try {
    const leaf = openPinnedRegularFile(parent.fd, parent.leaf, true, options.onLeafCreated);
    try {
      const fd = fs.openSync(fdSelfPath(leaf.fd), fs.constants.O_RDWR);
      try {
        assertExpectedPinnedWriteTarget(
          leaf,
          parent.fd,
          parent.leaf,
          options.expectedBeforeHash,
          options.expectedIdentity,
          options.expectedContentHash,
          relativePath,
        );
        maybeSwapTargetAfterHashWithContent(vaultPath, relativePath);
        assertExpectedPinnedWriteTarget(
          leaf,
          parent.fd,
          parent.leaf,
          options.expectedBeforeHash,
          options.expectedIdentity,
          options.expectedContentHash,
          relativePath,
        );
        const identity = fileIdentity(leaf.fd);
        options.beforeMutation?.(parent.createdDirectories, identity);
        fs.ftruncateSync(fd, 0);
        options.afterMutation?.(identity, Buffer.alloc(0));
        maybeSwapTargetAfterTruncateWithContent(vaultPath, relativePath);
        if (options.triggerFailureHook !== false) {
          maybeTriggerApplyFailure("after-truncate");
        }
        writeAll(fd, content);
        maybeMutateTargetBeforeOwnershipJournal(vaultPath, relativePath);
        options.afterMutation?.(identity, Buffer.isBuffer(content) ? content : Buffer.from(content));
      } finally {
        fs.closeSync(fd);
      }
    } finally {
      fs.closeSync(leaf.fd);
    }
    return parent.createdDirectories;
  } finally {
    fs.closeSync(parent.fd);
  }
}

function assertExpectedPinnedWriteTarget(
  pinned: PinnedRegularFile,
  parentFd: number,
  leaf: string,
  expectedHash: string | null | undefined,
  expectedIdentity: FileIdentity | undefined,
  expectedContentHash: string | undefined,
  relativePath: string,
): void {
  const current = readOpenedPinnedFile(pinned);
  if (!(pinned.created && expectedHash === null && current.length === 0)) {
    assertExpectedHashForContent(current, expectedHash, "target", relativePath);
  }
  if (expectedContentHash !== undefined && fileContentHash(current) !== expectedContentHash) {
    throw new TransactionRefusal({
      code: "change-rollback-ownership-lost",
      message: "change rollback target no longer belongs to this transaction",
      path: relativePath,
    });
  }
  assertPinnedPathStillMatches(
    parentFd,
    leaf,
    pinned,
    expectedHash,
    expectedIdentity,
    "target",
    relativePath,
  );
}

function secureRestoreVaultFile(
  vaultPath: string,
  relativePath: string,
  original: Buffer | undefined,
  expectation?: NamespaceExpectation,
): boolean {
  if (original !== undefined) {
    if (expectation?.state === "missing") {
      let parent: VaultParent | undefined;
      try {
        parent = secureEnsureVaultParent(vaultPath, relativePath, false);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      if (parent) {
        try {
          try {
            fs.lstatSync(fdPath(parent.fd, parent.leaf));
            return false;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw error;
            }
          }
        } finally {
          fs.closeSync(parent.fd);
        }
      }
    }
    secureWriteVaultFile(vaultPath, relativePath, original, {
      triggerFailureHook: false,
      expectedBeforeHash: expectation?.state === "missing" ? null : undefined,
      expectedIdentity: expectation?.state === "file" ? expectation.identity : undefined,
      expectedContentHash: expectation?.state === "file" ? expectation.contentHash : undefined,
    });
    return true;
  }
  let parent: VaultParent;
  try {
    parent = secureEnsureVaultParent(vaultPath, relativePath, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }
  try {
    try {
      if (expectation?.state === "missing") {
        try {
          fs.lstatSync(fdPath(parent.fd, parent.leaf));
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return true;
          }
          throw error;
        }
      }
      if (expectation?.state === "file") {
        const pinned = openPinnedRegularFileIfPresent(parent.fd, parent.leaf);
        if (!pinned) {
          return true;
        }
        try {
          const current = fs.lstatSync(fdPath(parent.fd, parent.leaf));
          const identity = fileIdentity(pinned.fd);
          const contentMatches = expectation.contentHash === undefined
            || fileContentHash(readOpenedPinnedFile(pinned)) === expectation.contentHash;
          if (
            !current.isFile()
            || current.dev !== identity.device
            || current.ino !== identity.inode
            || identity.device !== expectation.identity.device
            || identity.inode !== expectation.identity.inode
            || !contentMatches
          ) {
            return expectation.provisional === true;
          }
        } finally {
          fs.closeSync(pinned.fd);
        }
      }
      fs.unlinkSync(fdPath(parent.fd, parent.leaf));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    return true;
  } finally {
    fs.closeSync(parent.fd);
  }
}

function secureRenameVaultFile(
  vaultPath: string,
  fromPath: string,
  toPath: string,
  options: SecureMutationOptions = {},
  destinationBeforeHash?: string | null,
): string[] {
  if (options.invokeRaceHooks) {
    maybeSwapTargetWithContent(vaultPath, fromPath);
    maybeSwapTargetWithContent(vaultPath, toPath);
  }
  const from = secureEnsureVaultParent(vaultPath, fromPath, false);
  let to: VaultParent | undefined;
  try {
    to = secureEnsureVaultParent(vaultPath, toPath, true, options.onDirectoryCreated);
    let sourcePinned: PinnedRegularFile | undefined;
    let destinationPinned: PinnedRegularFile | undefined;
    try {
      sourcePinned = openPinnedRegularFileIfPresent(from.fd, from.leaf);
      destinationPinned = openPinnedRegularFileIfPresent(to.fd, to.leaf);
    } catch {
      if (destinationPinned) {
        fs.closeSync(destinationPinned.fd);
      }
      if (sourcePinned) {
        fs.closeSync(sourcePinned.fd);
      }
      throw new TransactionRefusal({
        code: "change-source-invalid",
        message: "change move paths could not be securely inspected before mutation",
        path: fromPath,
      });
    }
    try {
      const source = sourcePinned ? readOpenedPinnedFile(sourcePinned) : undefined;
      const destination = destinationPinned ? readOpenedPinnedFile(destinationPinned) : undefined;
      assertExpectedHashForContent(source, options.expectedBeforeHash, "source", fromPath);
      assertExpectedHashForContent(destination, destinationBeforeHash, "destination", toPath);
      maybeSwapTargetAfterHashWithContent(vaultPath, fromPath);
      maybeSwapTargetAfterHashWithContent(vaultPath, toPath);
      const sourceAfterChecks = sourcePinned ? readOpenedPinnedFile(sourcePinned) : undefined;
      assertExpectedHashForContent(
        sourceAfterChecks,
        options.expectedBeforeHash,
        "source",
        fromPath,
      );
      assertExpectedHashForContent(
        destinationPinned ? readOpenedPinnedFile(destinationPinned) : undefined,
        destinationBeforeHash,
        "destination",
        toPath,
      );
      assertPinnedPathStillMatches(
        from.fd,
        from.leaf,
        sourcePinned,
        options.expectedBeforeHash,
        undefined,
        "source",
        fromPath,
      );
      assertPinnedPathStillMatches(
        to.fd,
        to.leaf,
        destinationPinned,
        destinationBeforeHash,
        undefined,
        "destination",
        toPath,
      );
      if (source === undefined || sourceAfterChecks === undefined || !sourcePinned) {
        throw new Error("change move source is not a regular file");
      }
      if (destination !== undefined) {
        throw new Error("change move destination already exists");
      }
      const sourceIdentity = fileIdentity(sourcePinned.fd);
      options.beforeMutation?.(to.createdDirectories, sourceIdentity);
      fs.renameSync(fdPath(from.fd, from.leaf), fdPath(to.fd, to.leaf));
      maybeMutateTargetBeforeOwnershipJournal(vaultPath, toPath);
      options.afterMutation?.(sourceIdentity, sourceAfterChecks);
      return to.createdDirectories;
    } finally {
      if (destinationPinned) {
        fs.closeSync(destinationPinned.fd);
      }
      if (sourcePinned) {
        fs.closeSync(sourcePinned.fd);
      }
    }
  } finally {
    if (to) {
      fs.closeSync(to.fd);
    }
    fs.closeSync(from.fd);
  }
}

function secureEnsureVaultParent(
  vaultPath: string,
  relativePath: string,
  create: boolean,
  onDirectoryCreated?: (directory: string) => void,
): VaultParent {
  if (process.platform !== "linux" || !fs.existsSync("/proc/self/fd")) {
    throw new Error("secure change application requires Linux descriptor-anchored filesystem support");
  }
  const parts = relativePath.split("/").filter(Boolean);
  const leaf = parts.pop();
  if (!leaf || parts.some((part) => part === "." || part === "..")) {
    throw new Error("unsafe vault path");
  }
  let fd = fs.openSync(vaultPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | requireNoFollow());
  const createdDirectories: string[] = [];
  let absolute = vaultPath;
  try {
    for (const part of parts) {
      const candidate = fdPath(fd, part);
      const childAbsolute = path.join(absolute, part);
      let nextFd: number;
      try {
        nextFd = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | requireNoFollow());
      } catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        fs.mkdirSync(candidate, { mode: 0o700 });
        createdDirectories.push(childAbsolute);
        onDirectoryCreated?.(childAbsolute);
        nextFd = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | requireNoFollow());
      }
      fs.closeSync(fd);
      fd = nextFd;
      absolute = childAbsolute;
    }
    return { fd, leaf, createdDirectories };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function openPinnedRegularFile(
  parentFd: number,
  leaf: string,
  create: boolean,
  onCreated?: (identity: FileIdentity) => void,
): PinnedRegularFile {
  const target = fdPath(parentFd, leaf);
  let leafFd: number;
  let created = false;
  try {
    leafFd = fs.openSync(target, O_PATH_LINUX | requireNoFollow());
  } catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    const createdFd = fs.openSync(
      target,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | requireNoFollow(),
      0o600,
    );
    try {
      created = true;
      const stat = fs.fstatSync(createdFd);
      onCreated?.({ device: stat.dev, inode: stat.ino });
    } finally {
      fs.closeSync(createdFd);
    }
    leafFd = fs.openSync(target, O_PATH_LINUX | requireNoFollow());
  }
  const stat = fs.fstatSync(leafFd);
  if (!stat.isFile() || stat.nlink !== 1) {
    fs.closeSync(leafFd);
    throw new Error("change target is not a regular file");
  }
  return { fd: leafFd, created };
}

function requireNoFollow(): number {
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    throw new Error("secure change application requires O_NOFOLLOW support");
  }
  return fs.constants.O_NOFOLLOW;
}

function fdPath(fd: number, child: string): string {
  return `/proc/self/fd/${fd}/${child}`;
}

function fdSelfPath(fd: number): string {
  return `/proc/self/fd/${fd}`;
}

function writeAll(fd: number, content: string | Buffer): void {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (written <= 0) {
      throw new Error("change write made no progress");
    }
    offset += written;
  }
}

function maybeTriggerApplyFailure(
  stage: "target-write" | "after-truncate" | "after-path-actions" | "after-refresh",
  writesCompleted = 0,
): void {
  const hook = process.env[FAILURE_HOOK_ENV];
  if (!hook) {
    return;
  }
  const targetWriteLimit = Number(hook);
  if (stage === "target-write" && Number.isFinite(targetWriteLimit) && targetWriteLimit > 0 && writesCompleted >= targetWriteLimit) {
    throw new Error("change failure hook triggered");
  }
  if (hook === stage) {
    throw new Error("change failure hook triggered");
  }
}

function maybeTriggerSetupFailure(stage: "directory-created" | "leaf-created"): void {
  if (process.env[SETUP_FAILURE_HOOK_ENV] === stage) {
    throw new Error("change setup failure hook triggered");
  }
}

function maybeSwapTargetWithSymlink(vaultPath: string, relativePath: string): void {
  const hook = process.env[SYMLINK_SWAP_HOOK_ENV];
  if (!hook) {
    return;
  }
  const [target, referent] = hook.split("::", 2);
  if (target !== relativePath || !referent) {
    return;
  }
  const absolutePath = path.join(vaultPath, relativePath);
  fs.unlinkSync(absolutePath);
  fs.symlinkSync(referent, absolutePath);
}

function maybeSwapTargetWithHardLink(vaultPath: string, relativePath: string): void {
  const hook = process.env[HARD_LINK_SWAP_HOOK_ENV];
  if (!hook) {
    return;
  }
  const [target, referent] = hook.split("::", 2);
  if (target !== relativePath || !referent) {
    return;
  }
  const absolutePath = path.join(vaultPath, relativePath);
  fs.unlinkSync(absolutePath);
  fs.linkSync(referent, absolutePath);
}

function maybeSwapTargetWithContent(vaultPath: string, relativePath: string): void {
  const hook = process.env[CONTENT_SWAP_HOOK_ENV];
  if (!hook) {
    return;
  }
  const [target, content] = hook.split("::", 2);
  if (target !== relativePath || content === undefined) {
    return;
  }
  fs.writeFileSync(path.join(vaultPath, relativePath), content, { mode: 0o600 });
}

function maybeSwapTargetAfterHashWithContent(vaultPath: string, relativePath: string): void {
  const hook = process.env[POST_HASH_CONTENT_SWAP_HOOK_ENV];
  if (!hook) {
    return;
  }
  const [target, content] = hook.split("::", 2);
  if (target !== relativePath || content === undefined) {
    return;
  }
  const absolutePath = path.join(vaultPath, relativePath);
  try {
    fs.unlinkSync(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  fs.writeFileSync(absolutePath, content, { mode: 0o600 });
}

function maybeSwapTargetAfterTruncateWithContent(vaultPath: string, relativePath: string): void {
  const hook = process.env[POST_TRUNCATE_CONTENT_SWAP_HOOK_ENV];
  if (!hook) {
    return;
  }
  const [target, content] = hook.split("::", 2);
  if (target !== relativePath || content === undefined) {
    return;
  }
  fs.writeFileSync(path.join(vaultPath, relativePath), content, { mode: 0o600 });
}

function maybeSwapRollbackTargetWithContent(vaultPath: string, relativePath: string): void {
  const hook = process.env[ROLLBACK_REPLACEMENT_HOOK_ENV];
  if (!hook) {
    return;
  }
  const [target, content] = hook.split("::", 2);
  if (target !== relativePath || content === undefined) {
    return;
  }
  const absolutePath = path.join(vaultPath, relativePath);
  try {
    fs.unlinkSync(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  fs.writeFileSync(absolutePath, content, { mode: 0o600 });
}

function maybeMutateRollbackTargetWithContent(vaultPath: string, relativePath: string): void {
  const hook = process.env[ROLLBACK_CONTENT_MUTATION_HOOK_ENV];
  if (!hook) {
    return;
  }
  const [target, content] = hook.split("::", 2);
  if (target !== relativePath || content === undefined) {
    return;
  }
  fs.writeFileSync(path.join(vaultPath, relativePath), content, { mode: 0o600 });
}

function maybeMutateTargetBeforeOwnershipJournal(vaultPath: string, relativePath: string): void {
  const hook = process.env[POST_MUTATION_JOURNAL_HOOK_ENV];
  if (!hook) {
    return;
  }
  const [target, content] = hook.split("::", 2);
  if (target !== relativePath || content === undefined) {
    return;
  }
  fs.writeFileSync(path.join(vaultPath, relativePath), content, { mode: 0o600 });
}

function fail<T>(code: string, message: string, pathValue?: string, affectedPaths?: string[]): Result<T> {
  const causes: StructuredError[] | undefined = affectedPaths?.map((path) => ({
    code: "change-rollback-affected",
    message: "path was affected during rollback",
    path,
  }));
  return {
    ok: false,
    error: {
      code,
      message,
      path: pathValue,
      causes,
    },
  };
}
