import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { compareVaultPaths, scanVaultEntries } from "./files";
import { readMeta, readStoredFiles } from "./index-db";
import { INDEX_SCHEMA_VERSION } from "./index-schema";
import { refreshVaultIndex } from "./index-search";
import { initializeRuntimeState } from "./runtime";
import type { Result, StructuredError } from "./types";
import type { VaultEnvironment } from "./vault-environment";

const STALE_PATH_LIMIT = 25;

export type RuntimeReadinessState = "missing" | "incompatible" | "stale" | "ready";
export type RuntimeReadinessAction = "initialize" | "rebuild" | "refresh" | "none";

export interface RuntimeFreshness {
  state: RuntimeReadinessState;
  updatedPaths: string[];
  newPaths: string[];
  deletedPaths: string[];
  excludedPaths: string[];
  stalePaths: string[];
}

export interface RuntimeReadiness {
  action: RuntimeReadinessAction;
  generation: string;
  freshness: RuntimeFreshness;
}

export function inspectRuntimeReadiness(environment: VaultEnvironment): Result<RuntimeFreshness> {
  if (!fs.existsSync(environment.databasePath)) {
    return {
      ok: true,
      value: emptyFreshness("missing"),
    };
  }

  let db: Database.Database;
  try {
    db = openReadonlyRuntimeDatabase(environment.databasePath);
  } catch (error) {
    return failure("runtime-db-unavailable", "runtime database could not be opened", error);
  }

  try {
    if (!schemaCompatible(db)) {
      return {
        ok: true,
        value: emptyFreshness("incompatible"),
      };
    }

    const storedFiles = readStoredFiles(db);
    const storedByPath = new Map(storedFiles.map((file) => [file.relative_path, file]));
    const scan = scanVaultEntries({
      vaultPath: environment.vaultPath,
      privateGlobs: environment.privateGlobs,
    });
    const currentByPath = new Map(scan.files.map((file) => [file.relativePath, file]));
    const excludedPaths = new Set(scan.exclusions.map((item) => item.relativePath));
    const updatedPaths = scan.files
      .filter((file) => {
        const previous = storedByPath.get(file.relativePath);
        return Boolean(previous && previous.hash !== file.hash);
      })
      .map((file) => file.relativePath)
      .sort(compareVaultPaths);
    const newPaths = scan.files
      .filter((file) => !storedByPath.has(file.relativePath))
      .map((file) => file.relativePath)
      .sort(compareVaultPaths);
    const deletedPaths = storedFiles
      .filter((file) => !currentByPath.has(file.relative_path) && !excludedPaths.has(file.relative_path))
      .map((file) => file.relative_path)
      .sort(compareVaultPaths);
    const newlyExcludedPaths = storedFiles
      .filter((file) => !currentByPath.has(file.relative_path) && excludedPaths.has(file.relative_path))
      .map((file) => file.relative_path)
      .sort(compareVaultPaths);
    const hasChanges = updatedPaths.length > 0
      || newPaths.length > 0
      || deletedPaths.length > 0
      || newlyExcludedPaths.length > 0;

    return {
      ok: true,
      value: {
        state: hasChanges ? "stale" : "ready",
        updatedPaths,
        newPaths,
        deletedPaths,
        excludedPaths: newlyExcludedPaths,
        stalePaths: [...updatedPaths, ...newPaths].sort(compareVaultPaths).slice(0, STALE_PATH_LIMIT),
      },
    };
  } catch (error) {
    return failure("runtime-readiness-failed", "runtime readiness could not be inspected", error);
  } finally {
    db.close();
  }
}

export function ensureRuntimeReady(environment: VaultEnvironment): Result<RuntimeReadiness> {
  const before = inspectRuntimeReadiness(environment);
  if (!before.ok) {
    return before;
  }

  const action = actionFor(before.value.state);
  if (action === "none") {
    return readyResult(environment, action, before.value);
  }

  try {
    if (action === "rebuild") {
      removeRuntimeDatabase(environment);
    }
    initializeRuntimeState({ rootDir: environment.rootDir, config: environment.runtimeConfig });
    const refreshed = refreshVaultIndex({
      vaultPath: environment.vaultPath,
      databasePath: environment.databasePath,
      privateGlobs: environment.privateGlobs,
      approvedTags: environment.approvedTags,
      embeddingConfig: environment.embeddingConfig,
    });
    if (!refreshed.ok) {
      return normalizeRefreshError(refreshed.error);
    }
  } catch (error) {
    return failure("index-refresh-failed", "runtime index could not be refreshed", error);
  }

  const after = inspectRuntimeReadiness(environment);
  if (!after.ok) {
    return after;
  }
  if (after.value.state !== "ready") {
    return {
      ok: false,
      error: {
        code: "index-refresh-incomplete",
        message: "runtime index did not become ready after refresh",
      },
    };
  }
  return readyResult(environment, action, after.value);
}

function actionFor(state: RuntimeReadinessState): RuntimeReadinessAction {
  switch (state) {
    case "missing":
      return "initialize";
    case "incompatible":
      return "rebuild";
    case "stale":
      return "refresh";
    case "ready":
      return "none";
  }
}

function readyResult(
  environment: VaultEnvironment,
  action: RuntimeReadinessAction,
  freshness: RuntimeFreshness,
): Result<RuntimeReadiness> {
  let generation = "";
  try {
    const db = openReadonlyRuntimeDatabase(environment.databasePath);
    try {
      generation = readMeta(db, "index_generation") ?? "";
    } finally {
      db.close();
    }
  } catch (error) {
    return failure("runtime-db-unavailable", "runtime database could not be opened", error);
  }
  return {
    ok: true,
    value: {
      action,
      generation,
      freshness,
    },
  };
}

function schemaCompatible(db: Database.Database): boolean {
  if (readMeta(db, "schema_version") !== INDEX_SCHEMA_VERSION) {
    return false;
  }
  for (const tableName of ["files", "notes", "assets", "chunks", "chunks_fts", "graph_edges", "asset_references"]) {
    if (!tableExists(db, tableName)) {
      return false;
    }
  }
  if (!tableHasColumns(db, "asset_references", ["resolved_target_path"])) {
    return false;
  }
  return !tableExists(db, "proposals") || tableHasColumns(db, "proposals", ["placement_debt", "path_actions"]);
}

function openReadonlyRuntimeDatabase(databasePath: string): Database.Database {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 250");
  return db;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("select 1 as present from sqlite_schema where type = 'table' and name = ?")
    .get(tableName) as { present: number } | undefined;
  return Boolean(row?.present);
}

function tableHasColumns(db: Database.Database, tableName: string, columnNames: string[]): boolean {
  if (!tableExists(db, tableName)) {
    return false;
  }
  const columns = new Set(
    (db.prepare(`pragma table_info(${tableName})`).all() as Array<{ name: string }>).map((row) => row.name),
  );
  return columnNames.every((columnName) => columns.has(columnName));
}

function removeRuntimeDatabase(environment: VaultEnvironment): void {
  const runtimeDir = path.resolve(environment.runtimeDir);
  const databasePath = path.resolve(environment.databasePath);
  if (path.dirname(databasePath) !== runtimeDir || path.basename(databasePath) !== "notes.db") {
    throw new Error("runtime database path is not a managed notes database");
  }
  for (const targetPath of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
    }
  }
}

function emptyFreshness(state: "missing" | "incompatible"): RuntimeFreshness {
  return {
    state,
    updatedPaths: [],
    newPaths: [],
    deletedPaths: [],
    excludedPaths: [],
    stalePaths: [],
  };
}

function normalizeRefreshError(error: StructuredError): Result<RuntimeReadiness> {
  const busy = /SQLITE_BUSY|database is locked/i.test(error.message);
  return {
    ok: false,
    error: {
      code: busy ? "index-busy" : "index-refresh-failed",
      message: busy ? "runtime index is busy" : "runtime index could not be refreshed",
    },
  };
}

function failure<T>(code: string, message: string, error: unknown): Result<T> {
  const busy = error instanceof Error && /SQLITE_BUSY|database is locked/i.test(error.message);
  return {
    ok: false,
    error: {
      code: busy ? "index-busy" : code,
      message: busy ? "runtime index is busy" : message,
    },
  };
}
