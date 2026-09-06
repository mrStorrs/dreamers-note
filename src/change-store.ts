import type { SqliteDatabase } from "./index-db";
import type {
  ChangeListItem,
  ChangeStatus,
  StoredChange,
} from "./change-contracts";
import type { Result } from "./types";

interface ChangeRow {
  change_id: string;
  status: ChangeStatus;
  summary: string;
  created_at: string;
  updated_at: string;
  revision: string;
  writes: string;
  moves: string;
  derived_paths: string;
  blockers: string;
  diff_text: string | null;
  diff_truncated: number;
  diff_hash: string;
  fingerprint: string;
  last_error: string | null;
}

export function ensureChangeStorage(db: SqliteDatabase): void {
  db.exec(`
    create table if not exists changes (
      change_id text primary key,
      status text not null,
      summary text not null,
      created_at text not null,
      updated_at text not null,
      revision text not null,
      writes text not null,
      moves text not null,
      derived_paths text not null,
      blockers text not null,
      diff_text text,
      diff_truncated integer not null,
      diff_hash text not null,
      fingerprint text not null,
      last_error text
    );
    create index if not exists changes_status_idx on changes(status);
  `);
}

export function insertStoredChange(db: SqliteDatabase, change: StoredChange): void {
  db.prepare(
    [
      "insert into changes",
      "(change_id, status, summary, created_at, updated_at, revision, writes, moves, derived_paths, blockers, diff_text, diff_truncated, diff_hash, fingerprint, last_error)",
      "values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ].join(" "),
  ).run(
    change.id,
    change.status,
    change.summary,
    change.createdAt,
    change.updatedAt,
    change.revision,
    stringify(change.writes),
    stringify(change.moves),
    stringify(change.derivedPaths),
    stringify(change.blockers),
    change.diffText ?? null,
    change.diffTruncated ? 1 : 0,
    change.diffHash,
    stringify(change.fingerprint),
    change.lastError ? stringify(change.lastError) : null,
  );
}

export function loadStoredChange(db: SqliteDatabase, id: string): Result<StoredChange> {
  if (!changeTableExists(db)) {
    return changeNotFound(id);
  }
  const row = db.prepare("select * from changes where change_id = ?").get(id) as ChangeRow | undefined;
  if (!row) {
    return changeNotFound(id);
  }
  return {
    ok: true,
    value: hydrateChange(row),
  };
}

export function listStoredChanges(db: SqliteDatabase, limit?: number): ChangeListItem[] {
  if (!changeTableExists(db)) {
    return [];
  }
  const rows = limit === undefined
    ? db.prepare("select * from changes order by created_at asc, change_id asc").all() as ChangeRow[]
    : db.prepare("select * from changes order by created_at asc, change_id asc limit ?").all(limit) as ChangeRow[];
  return rows.map((row) => {
    const change = hydrateChange(row);
    return {
      id: change.id,
      status: change.status,
      summary: change.summary,
      createdAt: change.createdAt,
      updatedAt: change.updatedAt,
      revision: change.revision,
      changedPaths: changedPaths(change),
      derivedPaths: change.derivedPaths,
      lastError: change.lastError,
    };
  });
}

export function updateStoredChange(db: SqliteDatabase, change: StoredChange): void {
  const result = db.prepare(
    [
      "update changes set",
      "status = ?, summary = ?, created_at = ?, updated_at = ?, revision = ?, writes = ?, moves = ?, derived_paths = ?, blockers = ?,",
      "diff_text = ?, diff_truncated = ?, diff_hash = ?, fingerprint = ?, last_error = ?",
      "where change_id = ?",
    ].join(" "),
  ).run(
    change.status,
    change.summary,
    change.createdAt,
    change.updatedAt,
    change.revision,
    stringify(change.writes),
    stringify(change.moves),
    stringify(change.derivedPaths),
    stringify(change.blockers),
    change.diffText ?? null,
    change.diffTruncated ? 1 : 0,
    change.diffHash,
    stringify(change.fingerprint),
    change.lastError ? stringify(change.lastError) : null,
    change.id,
  );
  if (result.changes !== 1) {
    throw new Error("change record disappeared during update");
  }
}

export function redactStoredChange(change: StoredChange, status: Extract<ChangeStatus, "applied" | "rejected">): StoredChange {
  return {
    ...change,
    status,
    updatedAt: new Date().toISOString(),
    writes: change.writes.map((write) => ({
      ...write,
      body: undefined,
    })),
    blockers: [],
    diffText: undefined,
    diffTruncated: false,
    lastError: undefined,
  };
}

function hydrateChange(row: ChangeRow): StoredChange {
  return {
    id: row.change_id,
    status: row.status,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
    writes: parse(row.writes, []),
    moves: parse(row.moves, []),
    derivedPaths: parse(row.derived_paths, []),
    blockers: parse(row.blockers, []),
    diffText: row.diff_text ?? undefined,
    diffTruncated: row.diff_truncated === 1,
    diffHash: row.diff_hash,
    fingerprint: parse(row.fingerprint, {
      branch: "",
      gitStatusHash: "",
      taxonomyHash: "",
      exclusionConfigHash: "",
    }),
    lastError: row.last_error ? parse(row.last_error, undefined) : undefined,
  };
}

function changedPaths(change: StoredChange): string[] {
  return [
    ...new Set([
      ...change.writes.map((write) => write.path),
      ...change.moves.flatMap((move) => [move.from, move.to]),
    ]),
  ].sort();
}

function changeTableExists(db: SqliteDatabase): boolean {
  const row = db
    .prepare("select 1 as present from sqlite_schema where type = 'table' and name = 'changes'")
    .get() as { present: number } | undefined;
  return Boolean(row?.present);
}

function changeNotFound(id: string): Result<never> {
  return {
    ok: false,
    error: {
      code: "change-not-found",
      message: "change was not found",
      path: id,
    },
  };
}

function parse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function stringify(value: unknown): string {
  return JSON.stringify(value);
}
