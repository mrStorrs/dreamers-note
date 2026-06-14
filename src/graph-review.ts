import crypto from "crypto";
import path from "path";
import Database from "better-sqlite3";
import type { EmbeddingConfig } from "./embeddings";
import { compareVaultPaths } from "./files";
import { openIndexDatabase, secureRuntimeFiles, withStructuredErrors } from "./index-db";
import { searchVaultIndex } from "./index-search";
import { classifyVaultPath } from "./path-safety";
import type { Result, StructuredError } from "./types";

const EXCERPT_LIMIT = 240;
const OVERLONG_NOTE_CHARS = 4_500;
const EMPTY_NOTE_CHARS = 24;
const STALE_PROJECT_MS = 45 * 24 * 60 * 60 * 1_000;
const REPORT_RECENT_LIMIT = 10;
const CONTENT_TOKEN_RE = /[\p{L}\p{N}]{4,}/gu;
const CONTENT_STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "been",
  "before",
  "between",
  "checklist",
  "context",
  "current",
  "daily",
  "does",
  "from",
  "have",
  "into",
  "keep",
  "local",
  "must",
  "note",
  "notes",
  "review",
  "should",
  "that",
  "their",
  "them",
  "then",
  "this",
  "through",
  "with",
]);

export interface DiagnosticsEnvironment {
  databasePath: string;
  vaultPath: string;
  privateGlobs: string[];
  embeddingConfig?: EmbeddingConfig;
}

export type DiagnosticSeverity = "high" | "medium" | "low" | "info";
export type DiagnosticAction = "dismiss" | "snooze" | "pin" | "intentional";

export interface DiagnosticEvidence {
  path: string;
  detail: string;
  excerpt: string;
}

export interface DiagnosticItem {
  itemKey: string;
  evidenceHash: string;
  category: string;
  severity: DiagnosticSeverity;
  confidence: number;
  summary: string;
  signal: string;
  paths: string[];
  evidence: DiagnosticEvidence[];
  suggestedUse: string;
  recommendedProposalTypes: string[];
  tag?: string;
  title?: string;
  signals?: Record<string, number>;
  feedback?: {
    action: DiagnosticAction;
    reason: string;
    expiresAt?: string;
  };
}

interface NoteRow {
  relative_path: string;
  title: string;
  approved_tags: string;
  unapproved_tags: string;
  mtime_ms: number;
  size: number;
}

interface ChunkRow {
  relative_path: string;
  ordinal: number;
  text: string;
}

interface EdgeRow {
  relative_path: string;
  kind: string;
  raw_target: string;
  target_path: string | null;
  target_heading: string | null;
  alias: string | null;
  resolved: number;
  is_embed: number;
}

interface AssetReferenceRow {
  relative_path: string;
  target: string;
  resolved_target_path: string | null;
  is_embed: number;
}

interface ProposalRow {
  proposal_id: string;
  operation: string;
  status: string;
  target_paths: string;
  placement_debt: string;
  created_at: string;
  updated_at: string;
}

interface DiagnosticFeedbackRow {
  id: number;
  report_type: string;
  item_key: string;
  evidence_hash: string;
  action: DiagnosticAction;
  reason: string;
  expires_at: string | null;
  recorded_at: string;
}

interface NoteRecord {
  path: string;
  title: string;
  root: string;
  approvedTags: string[];
  unapprovedTags: string[];
  mtimeMs: number;
  size: number;
  excerpt: string;
  body: string;
  totalChars: number;
  outgoingResolved: EdgeRow[];
  outgoingUnresolved: EdgeRow[];
  incomingPaths: Set<string>;
  assetEmbeds: AssetReferenceRow[];
}

interface ProposalRecord {
  proposalId: string;
  operation: string;
  status: string;
  targetPaths: string[];
  createdAt: string;
  updatedAt: string;
  placementDebt?: {
    ambiguityReason: string;
    reviewDueAt: string;
    candidateDestinations: Array<{
      path: string;
      title?: string;
      reason?: string;
      anchorHeading?: string;
    }>;
  };
}

interface FeedbackRecord {
  action: DiagnosticAction;
  reason: string;
  evidenceHash: string;
  expiresAt?: string;
  recordedAt: string;
}

interface GraphState {
  notes: Map<string, NoteRecord>;
  proposals: ProposalRecord[];
  feedbackByReport: Map<string, Map<string, FeedbackRecord>>;
  edgeRows: EdgeRow[];
  assetRows: AssetReferenceRow[];
}

export function buildGraphDiagnostics(
  environment: DiagnosticsEnvironment,
  options: { limit?: number; persistReport?: boolean } = {},
) {
  return withStructuredErrors("graph-diagnostics-failed", () => {
    const db = openIndexDatabase(environment.databasePath);
    try {
      const state = loadGraphState(db);
      const tagStats = buildTagStats(state.notes);
      const duplicates = collectDuplicateTitleItems(state.notes);
      const unresolved = applyFeedback(
        "graph_diagnostics",
        collectBrokenLinkItems(state.notes).slice(0, options.limit ?? 5),
        state.feedbackByReport,
      );
      const orphanNotes = applyFeedback(
        "graph_diagnostics",
        collectOrphanNoteItems(state.notes).slice(0, options.limit ?? 5),
        state.feedbackByReport,
      );
      const duplicateTitles = applyFeedback(
        "graph_diagnostics",
        duplicates.slice(0, options.limit ?? 5),
        state.feedbackByReport,
      );
      const overbroadTags = applyFeedback(
        "graph_diagnostics",
        collectOverbroadTagItems(tagStats).slice(0, options.limit ?? 5),
        state.feedbackByReport,
      );

      const result = {
        summary: {
          notes: state.notes.size,
          unresolvedLinks: unresolved.items.length,
          orphanNotes: orphanNotes.items.length,
          duplicateTitleGroups: duplicateTitles.items.length,
          overbroadTags: overbroadTags.items.length,
          recentReports: recentDiagnosticReportCount(db),
        },
        sections: {
          links: applyFeedback(
            "graph_diagnostics",
            collectResolvedLinkItems(state.notes).slice(0, options.limit ?? 5),
            state.feedbackByReport,
          ),
          backlinks: applyFeedback(
            "graph_diagnostics",
            collectBacklinkItems(state.notes).slice(0, options.limit ?? 5),
            state.feedbackByReport,
          ),
          embeds: applyFeedback(
            "graph_diagnostics",
            collectEmbedItems(state.notes).slice(0, options.limit ?? 5),
            state.feedbackByReport,
          ),
          tagCooccurrence: applyFeedback(
            "graph_diagnostics",
            collectTagCooccurrenceItems(tagStats).slice(0, options.limit ?? 5),
            state.feedbackByReport,
          ),
          unresolvedLinks: unresolved,
          orphanNotes,
          duplicateTitles,
          overbroadTags,
        },
        excluded: {
          secretPathCount: countExcludedSecrets(db),
        },
      };

      if (options.persistReport !== false) {
        recordDiagnosticReport(db, "graph_diagnostics", {
          counts: result.summary,
        });
      }
      return result;
    } finally {
      db.close();
      secureRuntimeFiles(environment.databasePath);
    }
  });
}

export function buildGraphContextPack(
  environment: DiagnosticsEnvironment,
  options: { path?: string; query?: string; limit?: number; persistReport?: boolean },
) {
  return withStructuredErrors("graph-context-pack-failed", () => {
    const db = openIndexDatabase(environment.databasePath);
    try {
      const state = loadGraphState(db);
      const subjectPath = resolveContextSubject(environment, options, state.notes);
      const subject = state.notes.get(subjectPath);
      if (!subject) {
        throw structured("note-not-found", `note not indexed: ${subjectPath}`, subjectPath);
      }
      const duplicateCandidates = collectDuplicateCandidateItems(state.notes)
        .filter((item) => item.paths.includes(subjectPath))
        .slice(0, options.limit ?? 8);
      const groups = {
        outgoingLinks: {
          items: subject.outgoingResolved
            .map((edge): DiagnosticItem => ({
              itemKey: diagnosticKey("graph-context:outgoing", [subject.path, edge.target_path ?? edge.raw_target]),
              evidenceHash: evidenceHash([subject.path, edge.target_path ?? edge.raw_target, edge.target_heading ?? ""]),
              category: "outgoing-link",
              severity: "info" as const,
              confidence: 0.95,
              summary: `Outbound link from ${subject.title} to ${edge.target_path ?? edge.raw_target}.`,
              signal: "resolved-link",
              paths: [subject.path, edge.target_path ?? edge.raw_target],
              evidence: [evidenceForNote(subject, `Links to ${edge.target_path ?? edge.raw_target}.`)],
              suggestedUse: "cite",
              recommendedProposalTypes: ["link-review"],
            }))
            .slice(0, options.limit ?? 8),
        },
        backlinks: {
          items: [...subject.incomingPaths]
            .sort(compareVaultPaths)
            .slice(0, options.limit ?? 8)
            .map((incomingPath) => {
              const source = state.notes.get(incomingPath);
              return {
                itemKey: diagnosticKey("graph-context:backlink", [incomingPath, subject.path]),
                evidenceHash: evidenceHash([incomingPath, subject.path]),
                category: "backlink",
                severity: "info" as const,
                confidence: 0.9,
                summary: `${incomingPath} links back to ${subject.title}.`,
                signal: "backlink",
                paths: [incomingPath, subject.path],
                evidence: [evidenceForNote(source ?? subject, `Backlink to ${subject.path}.`)],
                suggestedUse: "link",
                recommendedProposalTypes: ["link-review"],
              };
            }),
        },
        embeds: {
          items: subject.assetEmbeds
            .map((asset): DiagnosticItem => ({
              itemKey: diagnosticKey("graph-context:embed", [subject.path, asset.resolved_target_path ?? asset.target]),
              evidenceHash: evidenceHash([subject.path, asset.resolved_target_path ?? asset.target]),
              category: "asset-embed",
              severity: "info" as const,
              confidence: 0.9,
              summary: `${subject.title} embeds ${asset.resolved_target_path ?? asset.target}.`,
              signal: "asset-embed",
              paths: [subject.path, asset.resolved_target_path ?? asset.target],
              evidence: [evidenceForNote(subject, `Embeds ${asset.resolved_target_path ?? asset.target}.`)],
              suggestedUse: "cite",
              recommendedProposalTypes: ["asset-review"],
            }))
            .slice(0, options.limit ?? 8),
        },
        duplicateCandidates: {
          items: duplicateCandidates,
        },
        sharedTags: {
          items: sharedTagNeighbors(subject, state.notes, options.limit ?? 8),
        },
      };
      const result = {
        subject: {
          path: subject.path,
          title: subject.title,
        },
        groups,
      };
      if (options.persistReport !== false) {
        recordDiagnosticReport(db, "graph_context_pack", {
          subjectPath: subject.path,
          counts: Object.fromEntries(
            Object.entries(groups).map(([key, value]) => [key, value.items.length]),
          ),
        });
      }
      return result;
    } finally {
      db.close();
      secureRuntimeFiles(environment.databasePath);
    }
  });
}

export function buildHealthReport(
  environment: DiagnosticsEnvironment,
  options: { limit?: number; persistReport?: boolean } = {},
) {
  return withStructuredErrors("health-report-failed", () => {
    const db = openIndexDatabase(environment.databasePath);
    try {
      const state = loadGraphState(db);
      const tagStats = buildTagStats(state.notes);
      const items = [
        ...collectBrokenLinkItems(state.notes),
        ...collectOrphanNoteItems(state.notes),
        ...collectEmptyNoteItems(state.notes),
        ...collectDuplicateTitleItems(state.notes),
        ...collectOverlongNoteItems(state.notes),
        ...collectStaleProjectItems(state.notes),
        ...collectPendingProposalItems(state.proposals),
        ...collectUnprocessedDailyCaptureItems(state.notes),
        ...collectPlacementDebtItems(state.proposals),
        ...collectConflictingTagItems(state.notes, tagStats),
      ];
      const filtered = applyFeedback("health_report", sortDiagnosticItems(items).slice(0, options.limit ?? 20), state.feedbackByReport);
      const result = {
        items: filtered.items,
        suppressedCount: filtered.suppressedCount,
        counts: countBySeverity(filtered.items),
      };
      if (options.persistReport !== false) {
        recordDiagnosticReport(db, "health_report", {
          counts: result.counts,
          itemCount: result.items.length,
          suppressedCount: result.suppressedCount,
        });
      }
      return result;
    } finally {
      db.close();
      secureRuntimeFiles(environment.databasePath);
    }
  });
}

export function buildDuplicateCandidates(
  environment: DiagnosticsEnvironment,
  options: { limit?: number; persistReport?: boolean } = {},
) {
  return withStructuredErrors("duplicate-candidates-failed", () => {
    const db = openIndexDatabase(environment.databasePath);
    try {
      const state = loadGraphState(db);
      const filtered = applyFeedback(
        "duplicate_candidates",
        collectDuplicateCandidateItems(state.notes).slice(0, options.limit ?? 10),
        state.feedbackByReport,
      );
      const result = {
        items: filtered.items,
        suppressedCount: filtered.suppressedCount,
      };
      if (options.persistReport !== false) {
        recordDiagnosticReport(db, "duplicate_candidates", {
          itemCount: result.items.length,
          suppressedCount: result.suppressedCount,
        });
      }
      return result;
    } finally {
      db.close();
      secureRuntimeFiles(environment.databasePath);
    }
  });
}

export function buildResurfacingReport(
  environment: DiagnosticsEnvironment,
  options: { limit?: number; persistReport?: boolean } = {},
) {
  return withStructuredErrors("resurfacing-report-failed", () => {
    const db = openIndexDatabase(environment.databasePath);
    try {
      const state = loadGraphState(db);
      const items = [
        ...collectStaleProjectItems(state.notes),
        ...collectHighValueOrphanItems(state.notes),
        ...collectPlacementDebtItems(state.proposals),
        ...collectRelatedOlderNoteItems(state.notes),
      ];
      const filtered = applyFeedback(
        "resurfacing_report",
        sortDiagnosticItems(items).slice(0, options.limit ?? 12),
        state.feedbackByReport,
      );
      const result = {
        items: filtered.items,
        suppressedCount: filtered.suppressedCount,
      };
      if (options.persistReport !== false) {
        recordDiagnosticReport(db, "resurfacing_report", {
          itemCount: result.items.length,
          suppressedCount: result.suppressedCount,
        });
      }
      return result;
    } finally {
      db.close();
      secureRuntimeFiles(environment.databasePath);
    }
  });
}

export function buildReviewQueue(
  environment: DiagnosticsEnvironment,
  options: { mode?: "daily" | "weekly"; limit?: number } = {},
) {
  return withStructuredErrors("review-queue-failed", () => {
    const db = openIndexDatabase(environment.databasePath);
    try {
      const state = loadGraphState(db);
      const health = buildHealthReport(environment, { limit: Math.max(options.limit ?? 12, 50), persistReport: false });
      const duplicates = buildDuplicateCandidates(environment, { limit: options.limit ?? 12, persistReport: false });
      const resurfacing = buildResurfacingReport(environment, { limit: options.limit ?? 12, persistReport: false });
      if (!health.ok) {
        throw new Error(health.error.message);
      }
      if (!duplicates.ok) {
        throw new Error(duplicates.error.message);
      }
      if (!resurfacing.ok) {
        throw new Error(resurfacing.error.message);
      }

      const groups = [
        {
          name: "placement-debt",
          items: health.value.items.filter((item) => item.category === "placement-debt").slice(0, 3),
        },
        {
          name: "new-captures",
          items: health.value.items.filter((item) => item.category === "unprocessed-daily-capture").slice(0, 3),
        },
        {
          name: "unresolved-proposals",
          items: health.value.items.filter((item) => item.category === "unresolved-proposal").slice(0, 3),
        },
        {
          name: "weak-notes",
          items: health.value.items.filter((item) => ["broken-link", "orphan-note", "empty-note", "conflicting-tags", "overlong-note"].includes(item.category)).slice(0, 4),
        },
        {
          name: "duplicate-candidates",
          items: duplicates.value.items.slice(0, 3),
        },
        {
          name: "stale-projects",
          items: resurfacing.value.items.filter((item) => item.category === "stale-project").slice(0, 3),
        },
        {
          name: "resurfacing",
          items: resurfacing.value.items.filter((item) => item.category !== "stale-project").slice(0, 4),
        },
      ].filter((group) => group.items.length > 0);

      const result = {
        mode: options.mode ?? "weekly",
        groups,
        counts: {
          pendingProposals: state.proposals.filter((proposal) => proposal.status === "pending").length,
          totalItems: groups.reduce((sum, group) => sum + group.items.length, 0),
        },
      };
      recordDiagnosticReport(db, "review_queue", {
        mode: result.mode,
        groupCounts: Object.fromEntries(groups.map((group) => [group.name, group.items.length])),
      });
      return result;
    } finally {
      db.close();
      secureRuntimeFiles(environment.databasePath);
    }
  });
}

export function recordDiagnosticFeedback(options: {
  databasePath: string;
  reportType: string;
  itemKey: string;
  evidenceHash: string;
  action: DiagnosticAction;
  reason: string;
  expiresAt?: string;
}) {
  return withStructuredErrors("diagnostic-feedback-write-failed", () => {
    const reportType = options.reportType.trim();
    const itemKey = options.itemKey.trim();
    const evidenceHash = options.evidenceHash.trim();
    const reason = options.reason.trim();
    if (!reportType || !itemKey || !evidenceHash || !reason) {
      throw structured("invalid-diagnostic-feedback", "reportType, itemKey, evidenceHash, and reason are required");
    }
    const recordedAt = new Date().toISOString();
    const db = openIndexDatabase(options.databasePath);
    try {
      db.prepare(
        [
          "insert into diagnostic_feedback",
          "(report_type, item_key, evidence_hash, action, reason, expires_at, recorded_at)",
          "values (?, ?, ?, ?, ?, ?, ?)",
        ].join(" "),
      ).run(
        reportType,
        itemKey,
        evidenceHash,
        options.action,
        reason,
        options.expiresAt?.trim() || null,
        recordedAt,
      );
      recordDiagnosticReport(db, "diagnostic_feedback", {
        reportType,
        itemKey,
        action: options.action,
      });
      return {
        recorded: true,
        reportType,
        itemKey,
        evidenceHash,
        action: options.action,
        reason,
        expiresAt: options.expiresAt?.trim() || undefined,
        recordedAt,
      };
    } finally {
      db.close();
      secureRuntimeFiles(options.databasePath);
    }
  });
}

export function listRecentDiagnosticReports(options: { databasePath: string; limit?: number }) {
  return withStructuredErrors("diagnostic-report-read-failed", () => {
    const db = openIndexDatabase(options.databasePath);
    try {
      const rows = db
        .prepare(
          [
            "select report_type, subject_path, query_text, summary_json, recorded_at",
            "from diagnostic_reports order by id desc limit ?",
          ].join(" "),
        )
        .all(options.limit ?? REPORT_RECENT_LIMIT) as Array<{
        report_type: string;
        subject_path: string | null;
        query_text: string | null;
        summary_json: string;
        recorded_at: string;
      }>;
      return {
        reports: rows.map((row) => ({
          reportType: row.report_type,
          subjectPath: row.subject_path ?? undefined,
          queryText: row.query_text ?? undefined,
          summary: parseJson<Record<string, unknown>>(row.summary_json, {}),
          recordedAt: row.recorded_at,
        })),
      };
    } finally {
      db.close();
      secureRuntimeFiles(options.databasePath);
    }
  });
}

function loadGraphState(db: Database.Database): GraphState {
  const noteRows = db
    .prepare(
      [
        "select n.relative_path, n.title, n.approved_tags, n.unapproved_tags, f.mtime_ms, f.size",
        "from notes n join files f on f.relative_path = n.relative_path",
        "order by n.relative_path",
      ].join(" "),
    )
    .all() as NoteRow[];
  const chunkRows = db
    .prepare("select relative_path, ordinal, text from chunks order by relative_path, ordinal")
    .all() as ChunkRow[];
  const edgeRows = db
    .prepare(
      [
        "select relative_path, kind, raw_target, target_path, target_heading, alias, resolved, is_embed",
        "from graph_edges order by relative_path, id",
      ].join(" "),
    )
    .all() as EdgeRow[];
  const assetRows = db
    .prepare("select relative_path, target, resolved_target_path, is_embed from asset_references order by relative_path, id")
    .all() as AssetReferenceRow[];
  const proposalRows = tableExists(db, "proposals")
    ? (db
      .prepare(
        [
          "select proposal_id, operation, status, target_paths, placement_debt, created_at, updated_at",
          "from proposals order by created_at asc",
        ].join(" "),
      )
      .all() as ProposalRow[])
    : [];
  const feedbackRows = tableExists(db, "diagnostic_feedback")
    ? (db
      .prepare(
        [
          "select id, report_type, item_key, evidence_hash, action, reason, expires_at, recorded_at",
          "from diagnostic_feedback order by id desc",
        ].join(" "),
      )
      .all() as DiagnosticFeedbackRow[])
    : [];

  const chunksByPath = new Map<string, ChunkRow[]>();
  for (const row of chunkRows) {
    const existing = chunksByPath.get(row.relative_path) ?? [];
    existing.push(row);
    chunksByPath.set(row.relative_path, existing);
  }

  const notes = new Map<string, NoteRecord>();
  for (const row of noteRows) {
    const chunks = chunksByPath.get(row.relative_path) ?? [];
    const body = chunks.map((chunk) => chunk.text).join("\n\n");
    notes.set(row.relative_path, {
      path: row.relative_path,
      title: row.title,
      root: topRoot(row.relative_path),
      approvedTags: parseJson<string[]>(row.approved_tags, []),
      unapprovedTags: parseJson<string[]>(row.unapproved_tags, []),
      mtimeMs: row.mtime_ms,
      size: row.size,
      excerpt: boundExcerpt(body),
      body,
      totalChars: body.trim().length,
      outgoingResolved: [],
      outgoingUnresolved: [],
      incomingPaths: new Set<string>(),
      assetEmbeds: [],
    });
  }

  for (const row of edgeRows) {
    const note = notes.get(row.relative_path);
    if (!note) {
      continue;
    }
    if (row.resolved && row.target_path) {
      note.outgoingResolved.push(row);
      const target = notes.get(row.target_path);
      if (target) {
        target.incomingPaths.add(row.relative_path);
      }
    } else {
      note.outgoingUnresolved.push(row);
    }
  }

  for (const row of assetRows) {
    const note = notes.get(row.relative_path);
    if (!note || !row.is_embed) {
      continue;
    }
    note.assetEmbeds.push(row);
  }

  const proposals = proposalRows.map((row) => ({
    proposalId: row.proposal_id,
    operation: row.operation,
    status: row.status,
    targetPaths: parseJson<string[]>(row.target_paths, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    placementDebt: parseJson<ProposalRecord["placementDebt"] | null>(row.placement_debt, null) ?? undefined,
  }));

  const feedbackByReport = new Map<string, Map<string, FeedbackRecord>>();
  for (const row of feedbackRows) {
    const byItem = feedbackByReport.get(row.report_type) ?? new Map<string, FeedbackRecord>();
    if (byItem.has(row.item_key)) {
      continue;
    }
    byItem.set(row.item_key, {
      action: row.action,
      reason: row.reason,
      evidenceHash: row.evidence_hash,
      expiresAt: row.expires_at ?? undefined,
      recordedAt: row.recorded_at,
    });
    feedbackByReport.set(row.report_type, byItem);
  }

  return {
    notes,
    proposals,
    feedbackByReport,
    edgeRows,
    assetRows,
  };
}

function collectResolvedLinkItems(notes: Map<string, NoteRecord>): DiagnosticItem[] {
  return [...notes.values()]
    .filter((note) => note.outgoingResolved.length > 0)
    .sort((left, right) => right.outgoingResolved.length - left.outgoingResolved.length || compareVaultPaths(left.path, right.path))
    .map((note): DiagnosticItem => ({
      itemKey: diagnosticKey("graph-links", [note.path]),
      evidenceHash: evidenceHash([note.path, ...note.outgoingResolved.map((edge) => edge.target_path ?? edge.raw_target)]),
      category: "link-coverage",
      severity: "info",
      confidence: 0.95,
      summary: `${note.title} has ${note.outgoingResolved.length} resolved note links.`,
      signal: "resolved-links",
      paths: [note.path, ...note.outgoingResolved.slice(0, 2).map((edge) => edge.target_path ?? edge.raw_target)],
      evidence: [evidenceForNote(note, `Resolved links: ${note.outgoingResolved.slice(0, 2).map((edge) => edge.target_path ?? edge.raw_target).join(", ")}`)],
      suggestedUse: "cite",
      recommendedProposalTypes: ["link-review"],
    }));
}

function collectBacklinkItems(notes: Map<string, NoteRecord>): DiagnosticItem[] {
  return [...notes.values()]
    .filter((note) => note.incomingPaths.size > 0)
    .sort((left, right) => right.incomingPaths.size - left.incomingPaths.size || compareVaultPaths(left.path, right.path))
    .map((note): DiagnosticItem => ({
      itemKey: diagnosticKey("graph-backlinks", [note.path]),
      evidenceHash: evidenceHash([note.path, ...[...note.incomingPaths]]),
      category: "backlink-coverage",
      severity: "info",
      confidence: 0.92,
      summary: `${note.title} has ${note.incomingPaths.size} backlinks.`,
      signal: "backlinks",
      paths: [note.path, ...[...note.incomingPaths].slice(0, 2)],
      evidence: [evidenceForNote(note, `Backlinked from ${[...note.incomingPaths].slice(0, 2).join(", ")}`)],
      suggestedUse: "link",
      recommendedProposalTypes: ["link-review"],
    }));
}

function collectEmbedItems(notes: Map<string, NoteRecord>): DiagnosticItem[] {
  return [...notes.values()]
    .filter((note) => note.assetEmbeds.length > 0)
    .sort((left, right) => right.assetEmbeds.length - left.assetEmbeds.length || compareVaultPaths(left.path, right.path))
    .map((note): DiagnosticItem => ({
      itemKey: diagnosticKey("graph-embeds", [note.path]),
      evidenceHash: evidenceHash([note.path, ...note.assetEmbeds.map((asset) => asset.resolved_target_path ?? asset.target)]),
      category: "asset-embed",
      severity: "info",
      confidence: 0.9,
      summary: `${note.title} embeds ${note.assetEmbeds.length} asset${note.assetEmbeds.length === 1 ? "" : "s"}.`,
      signal: "asset-embed",
      paths: [note.path, ...note.assetEmbeds.slice(0, 2).map((asset) => asset.resolved_target_path ?? asset.target)],
      evidence: [evidenceForNote(note, `Embedded assets: ${note.assetEmbeds.slice(0, 2).map((asset) => asset.resolved_target_path ?? asset.target).join(", ")}`)],
      suggestedUse: "cite",
      recommendedProposalTypes: ["asset-review"],
    }));
}

function collectBrokenLinkItems(notes: Map<string, NoteRecord>): DiagnosticItem[] {
  const items: DiagnosticItem[] = [];
  for (const note of notes.values()) {
    for (const edge of note.outgoingUnresolved) {
      items.push({
        itemKey: diagnosticKey("broken-link", [note.path, edge.raw_target]),
        evidenceHash: evidenceHash([note.path, edge.raw_target, note.excerpt]),
        category: "broken-link",
        severity: "high",
        confidence: 0.98,
        summary: `${note.title} points at unresolved target ${edge.raw_target}.`,
        signal: "unresolved-link",
        paths: [note.path],
        evidence: [evidenceForNote(note, `Missing target: ${edge.raw_target}`)],
        suggestedUse: "link",
        recommendedProposalTypes: ["link-fix", "proposal_create"],
      });
    }
  }
  return items.sort(compareDiagnosticItems);
}

function collectOrphanNoteItems(notes: Map<string, NoteRecord>): DiagnosticItem[] {
  return [...notes.values()]
    .filter((note) => !isDailyNote(note.path))
    .filter((note) => note.outgoingResolved.length === 0 && note.incomingPaths.size === 0 && note.assetEmbeds.length === 0)
    .map((note): DiagnosticItem => {
      const olderThanThreshold = note.mtimeMs <= Date.now() - STALE_PROJECT_MS;
      const confidence = note.totalChars > 80
        ? Number((0.74 + (olderThanThreshold ? 0.12 : 0) + Math.min(0.1, note.totalChars / 4_000)).toFixed(4))
        : 0.6;
      return {
        itemKey: diagnosticKey("orphan-note", [note.path]),
        evidenceHash: evidenceHash([note.path, note.excerpt]),
        category: "orphan-note",
        severity: note.totalChars > 80 ? "medium" : "low",
        confidence,
        summary: `${note.title} has no indexed links or backlinks.`,
        signal: "orphan-note",
        paths: [note.path],
        evidence: [evidenceForNote(note, "No resolved links, backlinks, or embeds.")],
        suggestedUse: note.totalChars > 80 ? "resurface" : "ignore",
        recommendedProposalTypes: ["link-review", "resurface-review"],
      };
    })
    .sort(compareDiagnosticItems);
}

function collectEmptyNoteItems(notes: Map<string, NoteRecord>): DiagnosticItem[] {
  return [...notes.values()]
    .filter((note) => note.totalChars > 0 && note.totalChars <= EMPTY_NOTE_CHARS)
    .map((note): DiagnosticItem => ({
      itemKey: diagnosticKey("empty-note", [note.path]),
      evidenceHash: evidenceHash([note.path, note.excerpt]),
      category: "empty-note",
      severity: "medium",
      confidence: 0.95,
      summary: `${note.title} has almost no indexed content.`,
      signal: "empty-note",
      paths: [note.path],
      evidence: [evidenceForNote(note, "Very short note content.")],
      suggestedUse: "split-review",
      recommendedProposalTypes: ["expand-note", "delete-review"],
    }))
    .sort(compareDiagnosticItems);
}

function collectDuplicateTitleItems(notes: Map<string, NoteRecord>): DiagnosticItem[] {
  const groups = new Map<string, NoteRecord[]>();
  for (const note of notes.values()) {
    const key = normalizedTitle(note.title);
    const existing = groups.get(key) ?? [];
    existing.push(note);
    groups.set(key, existing);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group): DiagnosticItem => ({
      itemKey: diagnosticKey("duplicate-title", group.map((note) => note.path)),
      evidenceHash: evidenceHash(group.map((note) => `${note.path}:${note.excerpt}`)),
      category: "duplicate-title",
      severity: "medium",
      confidence: 0.85,
      summary: `${group[0].title} appears ${group.length} times across the vault.`,
      signal: "duplicate-title",
      paths: group.map((note) => note.path).sort(compareVaultPaths),
      evidence: group.slice(0, 2).map((note) => evidenceForNote(note, `Duplicate title: ${note.title}`)),
      suggestedUse: "merge-review",
      recommendedProposalTypes: ["merge-review", "link-review"],
      title: group[0].title,
    }))
    .sort(compareDiagnosticItems);
}

function collectOverlongNoteItems(notes: Map<string, NoteRecord>): DiagnosticItem[] {
  return [...notes.values()]
    .filter((note) => note.totalChars >= OVERLONG_NOTE_CHARS)
    .map((note): DiagnosticItem => ({
      itemKey: diagnosticKey("overlong-note", [note.path]),
      evidenceHash: evidenceHash([note.path, String(note.totalChars)]),
      category: "overlong-note",
      severity: "medium",
      confidence: 0.93,
      summary: `${note.title} is overlong for efficient review (${note.totalChars} characters).`,
      signal: "overlong-note",
      paths: [note.path],
      evidence: [evidenceForNote(note, `Indexed length ${note.totalChars} characters.`)],
      suggestedUse: "split-review",
      recommendedProposalTypes: ["split-review"],
    }))
    .sort(compareDiagnosticItems);
}

function collectStaleProjectItems(notes: Map<string, NoteRecord>): DiagnosticItem[] {
  const cutoff = Date.now() - STALE_PROJECT_MS;
  return [...notes.values()]
    .filter((note) => note.path.startsWith("01-projects/") && note.mtimeMs <= cutoff)
    .map((note): DiagnosticItem => ({
      itemKey: diagnosticKey("stale-project", [note.path]),
      evidenceHash: evidenceHash([note.path, String(Math.floor(note.mtimeMs))]),
      category: "stale-project",
      severity: "medium",
      confidence: 0.87,
      summary: `${note.title} looks stale for an active project note.`,
      signal: "stale-project",
      paths: [note.path],
      evidence: [evidenceForNote(note, `Last modified ${new Date(note.mtimeMs).toISOString()}.`)],
      suggestedUse: "resurface",
      recommendedProposalTypes: ["project-refresh", "review-queue"],
    }))
    .sort(compareDiagnosticItems);
}

function collectPendingProposalItems(proposals: ProposalRecord[]): DiagnosticItem[] {
  return proposals
    .filter((proposal) => proposal.status === "pending")
    .map((proposal): DiagnosticItem => ({
      itemKey: diagnosticKey("unresolved-proposal", [proposal.proposalId]),
      evidenceHash: evidenceHash([proposal.proposalId, proposal.updatedAt, proposal.operation]),
      category: "unresolved-proposal",
      severity: "medium",
      confidence: 0.95,
      summary: `Proposal ${proposal.proposalId} is still pending review.`,
      signal: "pending-proposal",
      paths: proposal.targetPaths,
      evidence: [
        {
          path: proposal.targetPaths[0] ?? proposal.proposalId,
          detail: `Pending proposal operation: ${proposal.operation}`,
          excerpt: boundExcerpt(`Pending proposal for ${proposal.targetPaths.join(", ") || proposal.proposalId}`),
        },
      ],
      suggestedUse: "resurface",
      recommendedProposalTypes: ["proposal-review"],
    }))
    .sort(compareDiagnosticItems);
}

function collectUnprocessedDailyCaptureItems(notes: Map<string, NoteRecord>): DiagnosticItem[] {
  return [...notes.values()]
    .filter((note) => isDailyNote(note.path))
    .filter((note) => note.totalChars > 0)
    .map((note): DiagnosticItem => ({
      itemKey: diagnosticKey("unprocessed-daily-capture", [note.path]),
      evidenceHash: evidenceHash([note.path, note.excerpt]),
      category: "unprocessed-daily-capture",
      severity: "medium",
      confidence: 0.82,
      summary: `${note.title} still looks like inbox capture material.`,
      signal: "daily-capture",
      paths: [note.path],
      evidence: [evidenceForNote(note, "Daily note remains unarchived and non-empty.")],
      suggestedUse: "resurface",
      recommendedProposalTypes: ["triage-review"],
    }))
    .sort(compareDiagnosticItems);
}

function collectPlacementDebtItems(proposals: ProposalRecord[]): DiagnosticItem[] {
  return proposals
    .filter((proposal) => proposal.status === "pending" && proposal.placementDebt)
    .map((proposal): DiagnosticItem => ({
      itemKey: diagnosticKey("placement-debt", [proposal.proposalId]),
      evidenceHash: evidenceHash([
        proposal.proposalId,
        proposal.placementDebt?.ambiguityReason ?? "",
        ...(proposal.placementDebt?.candidateDestinations.map((item) => item.path) ?? []),
      ]),
      category: "placement-debt",
      severity: "high",
      confidence: 0.9,
      summary: `Placement debt remains unresolved for proposal ${proposal.proposalId}.`,
      signal: "placement-debt",
      paths: proposal.targetPaths,
      evidence: [
        {
          path: proposal.targetPaths[0] ?? proposal.proposalId,
          detail: proposal.placementDebt?.ambiguityReason ?? "Ambiguous destination",
          excerpt: boundExcerpt(
            [
              proposal.placementDebt?.ambiguityReason ?? "",
              ...(proposal.placementDebt?.candidateDestinations.map((item) => item.path) ?? []),
            ].join(" | "),
          ),
        },
      ],
      suggestedUse: "resurface",
      recommendedProposalTypes: ["placement-review"],
    }))
    .sort(compareDiagnosticItems);
}

function collectHighValueOrphanItems(notes: Map<string, NoteRecord>): DiagnosticItem[] {
  return collectOrphanNoteItems(notes)
    .filter((item) => item.confidence >= 0.85)
    .map((item): DiagnosticItem => ({
      ...item,
      category: "high-value-orphan",
      severity: "medium" as const,
      summary: item.summary.replace("has no indexed links or backlinks.", "looks valuable despite having no indexed links."),
      suggestedUse: "resurface",
    }));
}

function collectRelatedOlderNoteItems(notes: Map<string, NoteRecord>): DiagnosticItem[] {
  const sorted = [...notes.values()].sort((left, right) => left.mtimeMs - right.mtimeMs);
  const items: DiagnosticItem[] = [];
  for (const note of sorted) {
    if (isDailyNote(note.path) || note.root === "04-people") {
      continue;
    }
    const neighbors = sharedTagNeighbors(note, notes, 2);
    if (neighbors.length === 0) {
      continue;
    }
    items.push({
      itemKey: diagnosticKey("related-older-note", [note.path, ...neighbors.map((item) => item.paths[1])]),
      evidenceHash: evidenceHash([note.path, String(Math.floor(note.mtimeMs)), ...neighbors.map((item) => item.paths[1])]),
      category: "related-older-note",
      severity: "low",
      confidence: 0.74,
      summary: `${note.title} is older context that still relates to active tagged notes.`,
      signal: "shared-tag-recency",
      paths: [note.path, ...neighbors.map((item) => item.paths[1])],
      evidence: [evidenceForNote(note, `Shares tags with ${neighbors.map((item) => item.paths[1]).join(", ")}`)],
      suggestedUse: "resurface",
      recommendedProposalTypes: ["review-queue"],
    });
    if (items.length >= 6) {
      break;
    }
  }
  return items.sort(compareDiagnosticItems);
}

function collectConflictingTagItems(notes: Map<string, NoteRecord>, tagStats: ReturnType<typeof buildTagStats>): DiagnosticItem[] {
  return [...notes.values()]
    .filter((note) => note.approvedTags.length >= 2)
    .map((note): DiagnosticItem | null => {
      const localTags = note.approvedTags.filter((tag) => dominantRoot(tagStats, tag)?.root === note.root && dominantRoot(tagStats, tag)?.strong);
      const foreignTags = note.approvedTags.filter((tag) => dominantRoot(tagStats, tag)?.root !== note.root && dominantRoot(tagStats, tag)?.strong);
      if (localTags.length === 0 || foreignTags.length === 0) {
        return null;
      }
      return {
        itemKey: diagnosticKey("conflicting-tags", [note.path, ...note.approvedTags]),
        evidenceHash: evidenceHash([note.path, ...note.approvedTags]),
        category: "conflicting-tags",
        severity: "medium" as const,
        confidence: 0.82,
        summary: `${note.title} mixes local tags (${localTags.join(", ")}) with foreign-domain tags (${foreignTags.join(", ")}).`,
        signal: "dominant-root-tag-mismatch",
        paths: [note.path],
        evidence: [evidenceForNote(note, `Approved tags: ${note.approvedTags.join(", ")}`)],
        suggestedUse: "split-review",
        recommendedProposalTypes: ["retag-review"],
      };
    })
    .filter((item): item is DiagnosticItem => Boolean(item))
    .sort(compareDiagnosticItems);
}

function collectOverbroadTagItems(tagStats: ReturnType<typeof buildTagStats>): DiagnosticItem[] {
  return [...tagStats.entries()]
    .filter(([, stats]) => stats.count >= 4 && stats.roots.size >= 3)
    .map(([tag, stats]): DiagnosticItem => ({
      itemKey: diagnosticKey("overbroad-tag", [tag]),
      evidenceHash: evidenceHash([tag, String(stats.count), ...stats.paths]),
      category: "overbroad-tag",
      severity: "low" as const,
      confidence: 0.78,
      summary: `Approved tag ${tag} spans ${stats.count} notes across ${stats.roots.size} top-level roots.`,
      signal: "broad-tag-spread",
      paths: stats.paths.slice(0, 3),
      evidence: stats.paths.slice(0, 2).map((notePath) => ({
        path: notePath,
        detail: `Tag ${tag} appears here.`,
        excerpt: boundExcerpt(notePath),
      })),
      suggestedUse: "ignore",
      recommendedProposalTypes: ["retag-review"],
      tag,
    }))
    .sort(compareDiagnosticItems);
}

function collectTagCooccurrenceItems(tagStats: ReturnType<typeof buildTagStats>): DiagnosticItem[] {
  return [...tagStats.pairs.entries()]
    .filter(([, stats]) => stats.count >= 2)
    .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([pair, stats]): DiagnosticItem => ({
      itemKey: diagnosticKey("tag-cooccurrence", [pair]),
      evidenceHash: evidenceHash([pair, String(stats.count), ...stats.paths]),
      category: "tag-cooccurrence",
      severity: "info" as const,
      confidence: 0.8,
      summary: `Tags ${pair.replace("::", " + ")} co-occur in ${stats.count} notes.`,
      signal: "tag-cooccurrence",
      paths: stats.paths.slice(0, 3),
      evidence: stats.paths.slice(0, 2).map((notePath) => ({
        path: notePath,
        detail: `Tag pair ${pair.replace("::", " + ")} appears here.`,
        excerpt: boundExcerpt(notePath),
      })),
      suggestedUse: "cite",
      recommendedProposalTypes: ["tag-review"],
    }));
}

function collectDuplicateCandidateItems(notes: Map<string, NoteRecord>): DiagnosticItem[] {
  const noteList = [...notes.values()].filter((note) => !isDailyNote(note.path));
  const items: DiagnosticItem[] = [];
  for (let index = 0; index < noteList.length; index += 1) {
    for (let inner = index + 1; inner < noteList.length; inner += 1) {
      const left = noteList[index];
      const right = noteList[inner];
      const titleSimilarity = left.title === right.title ? 1 : tokenJaccard(significantTokens(left.title), significantTokens(right.title));
      const pathSimilarityValue = pathSimilarity(left.path, right.path);
      const contentSimilarity = tokenJaccard(significantTokens(left.body), significantTokens(right.body));
      const tagOverlap = tokenJaccard(new Set(left.approvedTags), new Set(right.approvedTags));
      const backlinkSimilarity = tokenJaccard(
        new Set([...left.incomingPaths, ...left.outgoingResolved.map((edge) => edge.target_path ?? "")]),
        new Set([...right.incomingPaths, ...right.outgoingResolved.map((edge) => edge.target_path ?? "")]),
      );
      const rawScore = Number((
        titleSimilarity * 0.45
        + pathSimilarityValue * 0.2
        + contentSimilarity * 0.2
        + tagOverlap * 0.1
        + backlinkSimilarity * 0.1
      ).toFixed(4));
      const score = titleSimilarity >= 0.95 && pathSimilarityValue < 0.5
        ? Math.min(rawScore, 0.55)
        : rawScore;
      if (titleSimilarity < 0.95 && score < 0.62) {
        continue;
      }
      const suggestedUse = titleSimilarity >= 0.95 && (score >= 0.65 || (pathSimilarityValue >= 0.7 && contentSimilarity >= 0.15))
        ? "merge-review"
        : titleSimilarity >= 0.95
          ? "keep-both"
          : score >= 0.7
            ? "link"
            : "ignore";
      items.push({
        itemKey: diagnosticKey("duplicate-candidate", [left.path, right.path]),
        evidenceHash: evidenceHash([left.path, right.path, String(score)]),
        category: "duplicate-candidate",
        severity: suggestedUse === "merge-review" ? "medium" : "low",
        confidence: score,
        summary: `${left.title} and ${right.title} look related enough for ${suggestedUse}.`,
        signal: "duplicate-similarity",
        paths: [left.path, right.path].sort(compareVaultPaths),
        evidence: [
          evidenceForNote(left, `Compared with ${right.path}`),
          evidenceForNote(right, `Compared with ${left.path}`),
        ],
        suggestedUse,
        recommendedProposalTypes: suggestedUse === "merge-review" ? ["merge-review", "link-review"] : ["link-review"],
        signals: {
          titleSimilarity,
          pathSimilarity: pathSimilarityValue,
          contentFingerprint: contentSimilarity,
          tagOverlap,
          backlinkOverlap: backlinkSimilarity,
        },
        title: left.title === right.title ? left.title : `${left.title} / ${right.title}`,
      });
    }
  }
  return sortDiagnosticItems(items);
}

function sharedTagNeighbors(subject: NoteRecord, notes: Map<string, NoteRecord>, limit: number): DiagnosticItem[] {
  const items: DiagnosticItem[] = [];
  const tagSet = new Set(subject.approvedTags);
  for (const note of notes.values()) {
    if (note.path === subject.path) {
      continue;
    }
    const shared = note.approvedTags.filter((tag) => tagSet.has(tag));
    if (shared.length === 0) {
      continue;
    }
    const score = Number((shared.length / Math.max(subject.approvedTags.length, note.approvedTags.length, 1)).toFixed(4));
    items.push({
      itemKey: diagnosticKey("shared-tag-neighbor", [subject.path, note.path]),
      evidenceHash: evidenceHash([subject.path, note.path, shared.join(",")]),
      category: "shared-tag-neighbor",
      severity: "info",
      confidence: score,
      summary: `${note.title} shares ${shared.join(", ")} with ${subject.title}.`,
      signal: "shared-approved-tags",
      paths: [subject.path, note.path],
      evidence: [evidenceForNote(note, `Shared tags: ${shared.join(", ")}`)],
      suggestedUse: score >= 0.5 ? "resurface" : "cite",
      recommendedProposalTypes: ["link-review"],
    });
  }
  return items.sort(compareDiagnosticItems).slice(0, limit);
}

function buildTagStats(notes: Map<string, NoteRecord>) {
  const stats = new Map<string, {
    count: number;
    roots: Set<string>;
    paths: string[];
    rootCounts: Map<string, number>;
  }>();
  const pairs = new Map<string, { count: number; paths: string[] }>();
  for (const note of notes.values()) {
    for (const tag of note.approvedTags) {
      const entry = stats.get(tag) ?? { count: 0, roots: new Set<string>(), paths: [], rootCounts: new Map<string, number>() };
      entry.count += 1;
      entry.roots.add(note.root);
      entry.paths.push(note.path);
      entry.rootCounts.set(note.root, (entry.rootCounts.get(note.root) ?? 0) + 1);
      stats.set(tag, entry);
    }
    const sortedTags = [...note.approvedTags].sort();
    for (let index = 0; index < sortedTags.length; index += 1) {
      for (let inner = index + 1; inner < sortedTags.length; inner += 1) {
        const key = `${sortedTags[index]}::${sortedTags[inner]}`;
        const entry = pairs.get(key) ?? { count: 0, paths: [] };
        entry.count += 1;
        entry.paths.push(note.path);
        pairs.set(key, entry);
      }
    }
  }
  return Object.assign(stats, { pairs });
}

function dominantRoot(
  tagStats: ReturnType<typeof buildTagStats>,
  tag: string,
): { root: string; strong: boolean } | undefined {
  const stats = tagStats.get(tag);
  if (!stats) {
    return undefined;
  }
  const sorted = [...stats.rootCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const [root, count] = sorted[0] ?? [];
  const second = sorted[1]?.[1] ?? 0;
  if (!root) {
    return undefined;
  }
  return {
    root,
    strong: count >= 2 && count >= second + 1,
  };
}

function resolveContextSubject(
  environment: DiagnosticsEnvironment,
  options: { path?: string; query?: string; limit?: number },
  notes: Map<string, NoteRecord>,
): string {
  if (options.path?.trim()) {
    const classified = classifyVaultPath({
      vaultPath: environment.vaultPath,
      input: options.path.trim(),
      privateGlobs: environment.privateGlobs,
    });
    if (!classified.ok) {
      throw new Error(classified.error.message);
    }
    return classified.value.normalizedRelativePath;
  }
  if (options.query?.trim()) {
    const search = searchVaultIndex({
      databasePath: environment.databasePath,
      query: options.query.trim(),
      limit: Math.max(1, options.limit ?? 5),
      embeddingConfig: environment.embeddingConfig,
    });
    if (!search.ok || search.value.results.length === 0) {
      throw new Error(`no indexed sources matched "${options.query.trim()}"`);
    }
    return search.value.results[0].path;
  }
  const first = [...notes.keys()].sort(compareVaultPaths)[0];
  if (!first) {
    throw new Error("no indexed notes are available");
  }
  return first;
}

function applyFeedback(
  reportType: string,
  items: DiagnosticItem[],
  feedbackByReport: Map<string, Map<string, FeedbackRecord>>,
): { items: DiagnosticItem[]; suppressedCount: number } {
  const byItem = feedbackByReport.get(reportType) ?? new Map<string, FeedbackRecord>();
  const kept: DiagnosticItem[] = [];
  let suppressedCount = 0;
  for (const item of items) {
    const feedback = byItem.get(item.itemKey);
    if (!feedback || feedback.evidenceHash !== item.evidenceHash || isExpired(feedback.expiresAt)) {
      kept.push(item);
      continue;
    }
    if (feedback.action === "pin") {
      kept.push({
        ...item,
        feedback: {
          action: feedback.action,
          reason: feedback.reason,
          expiresAt: feedback.expiresAt,
        },
      });
      continue;
    }
    suppressedCount += 1;
  }
  return {
    items: kept,
    suppressedCount,
  };
}

function recordDiagnosticReport(
  db: Database.Database,
  reportType: string,
  summary: Record<string, unknown>,
): void {
  if (!tableExists(db, "diagnostic_reports")) {
    return;
  }
  db.prepare(
    [
      "insert into diagnostic_reports",
      "(report_type, subject_path, query_text, summary_json, recorded_at)",
      "values (?, ?, ?, ?, ?)",
    ].join(" "),
  ).run(
    reportType,
    typeof summary.subjectPath === "string" ? summary.subjectPath : null,
    typeof summary.queryText === "string" ? summary.queryText : null,
    JSON.stringify(summary),
    new Date().toISOString(),
  );
}

function recentDiagnosticReportCount(db: Database.Database): number {
  if (!tableExists(db, "diagnostic_reports")) {
    return 0;
  }
  const row = db.prepare("select count(*) as count from diagnostic_reports").get() as { count: number };
  return row.count;
}

function countExcludedSecrets(db: Database.Database): number {
  if (!tableExists(db, "exclusions")) {
    return 0;
  }
  const row = db
    .prepare("select count(*) as count from exclusions where reason = 'private-path'")
    .get() as { count: number };
  return row.count;
}

function evidenceForNote(note: NoteRecord, detail: string): DiagnosticEvidence {
  return {
    path: note.path,
    detail,
    excerpt: boundExcerpt(note.body || note.title),
  };
}

function boundExcerpt(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= EXCERPT_LIMIT) {
    return trimmed;
  }
  return `${trimmed.slice(0, EXCERPT_LIMIT - 1).trimEnd()}…`;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function diagnosticKey(prefix: string, parts: string[]): string {
  return `${prefix}:${parts.map((part) => part.trim()).sort().join("|")}`;
}

function evidenceHash(parts: string[]): string {
  const digest = crypto.createHash("sha256");
  digest.update(parts.join("\u241f"));
  return digest.digest("hex");
}

function topRoot(relativePath: string): string {
  return relativePath.split("/")[0] ?? relativePath;
}

function isDailyNote(relativePath: string): boolean {
  return relativePath.startsWith("00-inbox/daily-notes/");
}

function normalizedTitle(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function significantTokens(text: string): Set<string> {
  const matches = text.toLocaleLowerCase().match(CONTENT_TOKEN_RE) ?? [];
  return new Set(matches.filter((token) => !CONTENT_STOP_WORDS.has(token)));
}

function tokenJaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) {
      overlap += 1;
    }
  }
  const union = new Set([...left, ...right]).size;
  return Number((overlap / Math.max(union, 1)).toFixed(4));
}

function pathSimilarity(left: string, right: string): number {
  const leftTokens = new Set(left.replace(/\.md$/i, "").split(/[\/\-_ ]+/).filter(Boolean));
  const rightTokens = new Set(right.replace(/\.md$/i, "").split(/[\/\-_ ]+/).filter(Boolean));
  return tokenJaccard(leftTokens, rightTokens);
}

function countBySeverity(items: DiagnosticItem[]): Record<DiagnosticSeverity, number> {
  return items.reduce<Record<DiagnosticSeverity, number>>(
    (counts, item) => {
      counts[item.severity] += 1;
      return counts;
    },
    {
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    },
  );
}

function sortDiagnosticItems(items: DiagnosticItem[]): DiagnosticItem[] {
  return [...items].sort(compareDiagnosticItems);
}

function compareDiagnosticItems(left: DiagnosticItem, right: DiagnosticItem): number {
  const severityDiff = severityWeight(left.severity) - severityWeight(right.severity);
  if (severityDiff !== 0) {
    return severityDiff;
  }
  const confidenceDiff = right.confidence - left.confidence;
  if (confidenceDiff !== 0) {
    return confidenceDiff;
  }
  return compareVaultPaths(left.paths[0] ?? left.itemKey, right.paths[0] ?? right.itemKey);
}

function severityWeight(severity: DiagnosticSeverity): number {
  switch (severity) {
    case "high":
      return 0;
    case "medium":
      return 1;
    case "low":
      return 2;
    case "info":
      return 3;
  }
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("select 1 as present from sqlite_schema where type = 'table' and name = ?")
    .get(tableName) as { present: number } | undefined;
  return Boolean(row?.present);
}

function isExpired(expiresAt?: string): boolean {
  if (!expiresAt) {
    return false;
  }
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) && parsed <= Date.now();
}

function structured(code: string, message: string, pathValue?: string): StructuredError {
  return {
    code,
    message,
    path: pathValue,
  };
}
