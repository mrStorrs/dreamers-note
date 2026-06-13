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

const SCHEMA_VERSION = "3";

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
    create table if not exists chunk_embeddings (
      chunk_id text primary key,
      relative_path text not null,
      content_hash text not null,
      vector text not null,
      dimensions integer not null,
      model_name text not null,
      model_version text not null,
      provider text not null,
      policy_hash text not null,
      indexed_at text not null
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
      resolved_target_path text,
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
    create table if not exists retrieval_feedback (
      id integer primary key autoincrement,
      query text not null,
      selected_paths text not null,
      rejected_paths text not null,
      reason_codes text not null,
      proposal_id text,
      recorded_at text not null
    );
    create table if not exists proposals (
      proposal_id text primary key,
      bundle_id text,
      operation text not null,
      status text not null,
      revision integer not null,
      created_at text not null,
      updated_at text not null,
      expires_at text,
      target_paths text not null,
      source_paths text not null,
      candidate_paths text not null,
      dependencies text not null,
      approved_tags text not null,
      proposed_tag_gaps text not null,
      unresolved_questions text not null,
      validation_blockers text not null,
      rationale text not null,
      placement_scorecard text not null,
      evidence text not null,
      targets text not null,
      lineage text not null,
      diff_hash text not null,
      last_error text
    );
    create table if not exists proposal_authorizations (
      authorization_id text primary key,
      proposal_id text not null,
      proposal_revision integer not null,
      diff_hash text not null,
      target_paths text not null,
      before_hashes text not null,
      git_branch text,
      git_status_hash text,
      taxonomy_hash text not null,
      exclusion_config_hash text not null,
      created_at text not null,
      used_at text
    );
    create index if not exists files_kind_idx on files(kind);
    create index if not exists chunk_embeddings_relative_path_idx on chunk_embeddings(relative_path);
    create index if not exists graph_edges_target_path_idx on graph_edges(target_path);
    create index if not exists asset_references_target_idx on asset_references(target);
    create index if not exists asset_references_resolved_target_path_idx on asset_references(resolved_target_path);
    create index if not exists retrieval_feedback_query_idx on retrieval_feedback(query);
    create index if not exists proposals_status_idx on proposals(status);
    create index if not exists proposals_bundle_idx on proposals(bundle_id);
    create index if not exists proposal_authorizations_proposal_idx on proposal_authorizations(proposal_id);
  `);
  ensureColumn(db, "asset_references", "resolved_target_path", "text");
  db.prepare("insert or replace into meta (key, value) values ('schema_version', ?)").run(SCHEMA_VERSION);
}

function ensureColumn(db: SqliteDatabase, tableName: string, columnName: string, columnType: string): void {
  const rows = db.prepare(`pragma table_info(${tableName})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === columnName)) {
    return;
  }
  db.exec(`alter table ${tableName} add column ${columnName} ${columnType}`);
}
