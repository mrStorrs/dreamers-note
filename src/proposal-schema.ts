import type Database from "better-sqlite3";

export function ensureProposalStorage(db: Database.Database): void {
  db.exec(`
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
      placement_debt text not null default 'null',
      evidence text not null,
      path_actions text not null default '[]',
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
    create index if not exists proposals_status_idx on proposals(status);
    create index if not exists proposals_bundle_idx on proposals(bundle_id);
    create index if not exists proposal_authorizations_proposal_idx on proposal_authorizations(proposal_id);
  `);
  ensureColumn(db, "proposals", "placement_debt", "text not null default 'null'");
  ensureColumn(db, "proposals", "path_actions", "text not null default '[]'");
}

function ensureColumn(db: Database.Database, tableName: string, columnName: string, columnType: string): void {
  const rows = db.prepare(`pragma table_info(${tableName})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === columnName)) {
    return;
  }
  db.exec(`alter table ${tableName} add column ${columnName} ${columnType}`);
}
