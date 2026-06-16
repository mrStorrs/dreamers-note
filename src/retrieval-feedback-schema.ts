import type Database from "better-sqlite3";

export function ensureRetrievalFeedbackStorage(db: Database.Database): void {
  db.exec(`
    create table if not exists retrieval_feedback (
      id integer primary key autoincrement,
      query text not null,
      selected_paths text not null,
      rejected_paths text not null,
      reason_codes text not null,
      proposal_id text,
      recorded_at text not null
    );
    create index if not exists retrieval_feedback_query_idx on retrieval_feedback(query);
  `);
}
