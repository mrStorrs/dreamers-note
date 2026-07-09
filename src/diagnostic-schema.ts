import type Database from "better-sqlite3";

export function ensureDiagnosticStorage(db: Database.Database): void {
  db.exec(`
    create table if not exists diagnostic_reports (
      id integer primary key autoincrement,
      report_type text not null,
      subject_path text,
      query_text text,
      summary_json text not null,
      recorded_at text not null
    );
    create table if not exists diagnostic_feedback (
      id integer primary key autoincrement,
      report_type text not null,
      item_key text not null,
      evidence_hash text not null,
      action text not null,
      reason text not null,
      expires_at text,
      recorded_at text not null
    );
    create index if not exists diagnostic_reports_type_idx on diagnostic_reports(report_type);
    create index if not exists diagnostic_feedback_lookup_idx on diagnostic_feedback(report_type, item_key);
  `);
}
