import type Database from "better-sqlite3";

// Version 7 intentionally rebuilds version-6 caches rather than carrying forward
// optional vector or retired transient state.
export const INDEX_SCHEMA_VERSION = "7";

export function ensureIndexStorage(db: Database.Database): void {
  db.exec(`
    create table if not exists meta (key text primary key, value text not null);
    create table if not exists files (
      relative_path text primary key, kind text not null, hash text not null,
      size integer not null, mtime_ms real not null, indexed_at text not null
    );
    create table if not exists exclusions (
      relative_path text primary key, reason text not null, recorded_at text not null
    );
    create table if not exists notes (
      relative_path text primary key, title text not null, approved_tags text not null, unapproved_tags text not null
    );
    create table if not exists assets (
      relative_path text primary key, filename text not null, extension text not null, hash text not null, size integer not null
    );
    create table if not exists headings (
      id integer primary key autoincrement, relative_path text not null, heading_path text not null,
      level integer not null, text text not null, line integer not null
    );
    create table if not exists chunks (
      chunk_id text primary key, relative_path text not null, heading_path text not null, ordinal integer not null, text text not null
    );
    create virtual table if not exists chunks_fts using fts5(
      chunk_id unindexed, relative_path unindexed, title, heading_path, tags, text, tokenize='unicode61'
    );
    create table if not exists graph_edges (
      id integer primary key autoincrement, relative_path text not null, kind text not null,
      raw_target text not null, target_path text, target_heading text, alias text,
      resolved integer not null, is_embed integer not null
    );
    create table if not exists asset_references (
      id integer primary key autoincrement, relative_path text not null, target text not null,
      resolved_target_path text, is_embed integer not null
    );
    create table if not exists parse_warnings (
      id integer primary key autoincrement, relative_path text not null, code text not null, message text not null
    );
    create table if not exists tombstones (
      id integer primary key autoincrement, relative_path text not null, previous_hash text,
      reason text not null, new_path text, recorded_at text not null
    );
    drop table if exists operation_history;
    create index if not exists files_kind_idx on files(kind);
    create index if not exists graph_edges_target_path_idx on graph_edges(target_path);
    create index if not exists asset_references_target_idx on asset_references(target);
    create index if not exists asset_references_resolved_target_path_idx on asset_references(resolved_target_path);
  `);
  db.prepare("insert or replace into meta (key, value) values ('schema_version', ?)").run(INDEX_SCHEMA_VERSION);
}
