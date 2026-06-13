import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import type { ExcludedFile, RebuildVaultIndexOptions, Tombstone } from "./index-search";
import type { Result } from "./types";

export type SqliteDatabase = Database.Database;

export interface StoredFile {
  relative_path: string;
  kind: "note" | "asset";
  hash: string;
}

const SCHEMA_VERSION = "1";

export function openIndexDatabase(databasePath: string): SqliteDatabase {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(databasePath), 0o700);
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
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
  const statement = db.prepare("insert or replace into meta (key, value) values (?, ?)");
  for (const [key, value] of values) {
    statement.run(key, value);
  }
}

export function upsertExclusion(db: SqliteDatabase, exclusion: ExcludedFile): void {
  db.prepare(
    "insert or replace into exclusions (relative_path, reason, recorded_at) values (?, ?, ?)",
  ).run(exclusion.relativePath, exclusion.reason, new Date(0).toISOString());
}

export function purgeIndexedPath(db: SqliteDatabase, relativePath: string): void {
  db.prepare("delete from chunks_fts where relative_path = ?").run(relativePath);
  for (const table of [
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
  db.prepare("insert into operation_history (operation, detail, recorded_at) values (?, ?, ?)").run(
    operation,
    detail,
    new Date(0).toISOString(),
  );
}

export function readMeta(db: SqliteDatabase, key: string): string | undefined {
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

function migrate(db: SqliteDatabase): void {
  db.exec(`
    create table if not exists meta (
      key text primary key,
      value text not null
    );
    create table if not exists files (
      relative_path text primary key,
      kind text not null,
      hash text not null,
      size integer not null,
      mtime_ms real not null,
      indexed_at text not null
    );
    create table if not exists exclusions (
      relative_path text primary key,
      reason text not null,
      recorded_at text not null
    );
    create table if not exists notes (
      relative_path text primary key,
      title text not null,
      approved_tags text not null,
      unapproved_tags text not null
    );
    create table if not exists assets (
      relative_path text primary key,
      filename text not null,
      extension text not null,
      hash text not null,
      size integer not null
    );
    create table if not exists headings (
      id integer primary key autoincrement,
      relative_path text not null,
      heading_path text not null,
      level integer not null,
      text text not null,
      line integer not null
    );
    create table if not exists chunks (
      chunk_id text primary key,
      relative_path text not null,
      heading_path text not null,
      ordinal integer not null,
      text text not null
    );
    create virtual table if not exists chunks_fts using fts5(
      chunk_id unindexed,
      relative_path unindexed,
      title,
      heading_path,
      tags,
      text,
      tokenize='unicode61'
    );
    create table if not exists graph_edges (
      id integer primary key autoincrement,
      relative_path text not null,
      kind text not null,
      raw_target text not null,
      target_path text,
      target_heading text,
      alias text,
      resolved integer not null,
      is_embed integer not null
    );
    create table if not exists asset_references (
      id integer primary key autoincrement,
      relative_path text not null,
      target text not null,
      is_embed integer not null
    );
    create table if not exists parse_warnings (
      id integer primary key autoincrement,
      relative_path text not null,
      code text not null,
      message text not null
    );
    create table if not exists tombstones (
      id integer primary key autoincrement,
      relative_path text not null,
      previous_hash text,
      reason text not null,
      new_path text,
      recorded_at text not null
    );
    create table if not exists operation_history (
      id integer primary key autoincrement,
      operation text not null,
      detail text not null,
      recorded_at text not null
    );
    create index if not exists files_kind_idx on files(kind);
    create index if not exists graph_edges_target_path_idx on graph_edges(target_path);
    create index if not exists asset_references_target_idx on asset_references(target);
  `);
  db.prepare("insert or replace into meta (key, value) values ('schema_version', ?)").run(SCHEMA_VERSION);
}
