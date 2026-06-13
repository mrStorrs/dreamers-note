import { openIndexDatabase, withStructuredErrors } from "./index-db";
import type { StructuredError } from "./types";

export interface RetrievalFeedbackRecord {
  id: number;
  query: string;
  selectedPaths: string[];
  rejectedPaths: string[];
  reasonCodes: string[];
  proposalId?: string;
  recordedAt: string;
}

export interface RetrievalFeedbackInput {
  databasePath: string;
  query: string;
  selectedPaths?: string[];
  rejectedPaths?: string[];
  reasonCodes?: string[];
  proposalId?: string;
}

export interface HybridRetrievalCase {
  name: string;
  query: string;
  expectedPaths?: string[];
  expectNoSourceGap?: boolean;
  topK?: number;
}

export function recordRetrievalFeedback(options: RetrievalFeedbackInput) {
  return withStructuredErrors("retrieval-feedback-write-failed", () => {
    if (!options.query.trim()) {
      throw invalidFeedback("query is required");
    }
    const db = openIndexDatabase(options.databasePath);
    try {
      const selectedPaths = normalizeStringArray(options.selectedPaths);
      const rejectedPaths = normalizeStringArray(options.rejectedPaths);
      const reasonCodes = normalizeStringArray(options.reasonCodes);
      const recordedAt = new Date(0).toISOString();
      const result = db
        .prepare(
          [
            "insert into retrieval_feedback",
            "(query, selected_paths, rejected_paths, reason_codes, proposal_id, recorded_at)",
            "values (?, ?, ?, ?, ?, ?)",
          ].join(" "),
        )
        .run(
          options.query.trim(),
          JSON.stringify(selectedPaths),
          JSON.stringify(rejectedPaths),
          JSON.stringify(reasonCodes),
          options.proposalId?.trim() || null,
          recordedAt,
        );
      const record: RetrievalFeedbackRecord = {
        id: Number(result.lastInsertRowid),
        query: options.query.trim(),
        selectedPaths,
        rejectedPaths,
        reasonCodes,
        proposalId: options.proposalId?.trim() || undefined,
        recordedAt,
      };
      return record;
    } finally {
      db.close();
    }
  });
}

export function listRetrievalFeedback(options: { databasePath: string }) {
  return withStructuredErrors("retrieval-feedback-read-failed", () => {
    const db = openIndexDatabase(options.databasePath);
    try {
      const rows = db
        .prepare(
          [
            "select id, query, selected_paths, rejected_paths, reason_codes, proposal_id, recorded_at",
            "from retrieval_feedback order by id asc",
          ].join(" "),
        )
        .all() as Array<{
        id: number;
        query: string;
        selected_paths: string;
        rejected_paths: string;
        reason_codes: string;
        proposal_id: string | null;
        recorded_at: string;
      }>;
      return {
        records: rows.map((row) => ({
          id: row.id,
          query: row.query,
          selectedPaths: parseStringArray(row.selected_paths),
          rejectedPaths: parseStringArray(row.rejected_paths),
          reasonCodes: parseStringArray(row.reason_codes),
          proposalId: row.proposal_id ?? undefined,
          recordedAt: row.recorded_at,
        })),
      };
    } finally {
      db.close();
    }
  });
}

export function updateHybridGoldenCases(options: {
  cases: HybridRetrievalCase[];
  feedback: RetrievalFeedbackRecord[];
}): HybridRetrievalCase[] {
  const byQuery = new Map(options.cases.map((item) => [item.query, { ...item }]));
  for (const feedback of options.feedback) {
    if (feedback.selectedPaths.length === 0) {
      continue;
    }
    const existing = byQuery.get(feedback.query);
    if (existing) {
      existing.expectedPaths = [...feedback.selectedPaths];
      existing.expectNoSourceGap = false;
      existing.topK = Math.max(existing.topK ?? 1, feedback.selectedPaths.length);
      continue;
    }
    byQuery.set(feedback.query, {
      name: `feedback: ${feedback.query}`,
      query: feedback.query,
      expectedPaths: [...feedback.selectedPaths],
      topK: feedback.selectedPaths.length,
    });
  }
  return [...byQuery.values()];
}

function invalidFeedback(message: string): StructuredError {
  return {
    code: "invalid-retrieval-feedback",
    message,
  };
}

function normalizeStringArray(values?: string[]): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
