import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import type { ExcludedFile, RebuildVaultIndexOptions, Tombstone } from "./index-contracts";
import type { Result } from "./types";

const SQLITE_BUSY_TIMEOUT_MS = 250;

export type SqliteDatabase = Database.Database;

export interface StoredFile {
  relative_path: string;
  kind: "note" | "asset";
  hash: string;
}

export function openIndexDatabase(databasePath: string): SqliteDatabase {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(databasePath), 0o700);
  const db = new Database(databasePath);
  db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  secureRuntimeFiles(databasePath);
  return db;
}

export function clearIndex(db: SqliteDatabase): void {
  for (const table of [
    "files",
    "exclusions",
    "notes",
    "assets",
    "headings",
    "chunks",
    "chunks_fts",
    "chunk_embeddings",
    "graph_edges",
    "asset_references",
    "parse_warnings",
    "tombstones",
    "operation_history",
  ]) {
    db.prepare(`delete from ${table}`).run();
  }
}

export function clearExclusions(db: SqliteDatabase): void {
  db.prepare("delete from exclusions").run();
}

export function writeMeta(db: SqliteDatabase, options: RebuildVaultIndexOptions): void {
  const values = [
    ["vault_path", path.resolve(options.vaultPath)],
    ["private_globs", JSON.stringify(options.privateGlobs ?? [])],
    ["indexed_at", new Date(0).toISOString()],
  ];
  for (const [key, value] of values) {
    writeMetaValue(db, key, value);
  }
}

export function writeMetaValue(db: SqliteDatabase, key: string, value: string): void {
  db.prepare("insert or replace into meta (key, value) values (?, ?)").run(key, value);
}

export function upsertExclusion(db: SqliteDatabase, exclusion: ExcludedFile): void {
  db.prepare(
    "insert or replace into exclusions (relative_path, reason, recorded_at) values (?, ?, ?)",
  ).run(exclusion.relativePath, exclusion.reason, new Date(0).toISOString());
}

export function purgeIndexedPath(db: SqliteDatabase, relativePath: string): void {
  db.prepare("delete from chunks_fts where relative_path = ?").run(relativePath);
  for (const table of [
    "chunk_embeddings",
    "chunks",
    "headings",
    "graph_edges",
    "asset_references",
    "parse_warnings",
    "notes",
    "assets",
    "files",
  ]) {
    db.prepare(`delete from ${table} where relative_path = ?`).run(relativePath);
  }
}

export function readStoredFiles(db: SqliteDatabase): StoredFile[] {
  if (!tableExists(db, "files")) {
    return [];
  }
  return db.prepare("select relative_path, kind, hash from files order by relative_path").all() as StoredFile[];
}

export function writeTombstone(
  db: SqliteDatabase,
  relativePath: string,
  reason: Tombstone["reason"],
  previousHash?: string,
  newPath?: string,
): Tombstone {
  db.prepare(
    "insert into tombstones (relative_path, previous_hash, reason, new_path, recorded_at) values (?, ?, ?, ?, ?)",
  ).run(relativePath, previousHash ?? null, reason, newPath ?? null, new Date(0).toISOString());
  return {
    relativePath,
    previousHash,
    reason,
    newPath,
  };
}

export function recordOperation(db: SqliteDatabase, operation: string, detail: string): void {
  ensureOperationHistoryStorage(db);
  db.prepare("insert into operation_history (operation, detail, recorded_at) values (?, ?, ?)").run(
    operation,
    detail,
    new Date().toISOString(),
  );
}

export function readMeta(db: SqliteDatabase, key: string): string | undefined {
  if (!tableExists(db, "meta")) {
    return undefined;
  }
  const row = db.prepare("select value from meta where key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function secureRuntimeFiles(databasePath: string): void {
  for (const filePath of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (fs.existsSync(filePath)) {
      fs.chmodSync(filePath, 0o600);
    }
  }
}

export function withStructuredErrors<T>(code: string, callback: () => T): Result<T> {
  try {
    return {
      ok: true,
      value: callback(),
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function ensureOperationHistoryStorage(db: SqliteDatabase): void {
  db.exec(`
    create table if not exists operation_history (
      id integer primary key autoincrement,
      operation text not null,
      detail text not null,
      recorded_at text not null
    );
  `);
}

function tableExists(db: SqliteDatabase, tableName: string): boolean {
  const row = db
    .prepare("select 1 as present from sqlite_schema where type = 'table' and name = ?")
    .get(tableName) as { present: number } | undefined;
  return Boolean(row?.present);
}
