import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  buildFixtureIndex as buildSharedFixtureIndex,
  distDir,
  git,
  loadBuiltPackage,
  makeFrameworkRoot as makeSharedFrameworkRoot,
  readText,
  tmpdir,
  writeText,
} from "./helpers/project-fixtures.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const GRAPH_APPROVED_TAGS = ["ai", "search", "pkm", "health", "review", "notes"];

function loadPackage() {
  return loadBuiltPackage();
}

function setMtime(target, epochSeconds) {
  fs.utimesSync(target, epochSeconds, epochSeconds);
}

function makeGraphFrameworkRoot(vaultPath) {
  return makeSharedFrameworkRoot(vaultPath, {
    tempPrefix: "dreamers-note-graph-framework",
    approvedTags: GRAPH_APPROVED_TAGS,
    conventionsConfig: {
      classified_note_roots: ["00-inbox", "01-projects", "02-knowledge", "04-people"],
    },
  });
}

function makeGraphFixture() {
  const vault = tmpdir("dreamers-note-graph-vault");
  writeText(
    path.join(vault, "01-projects", "ai", "obsidian", "retrieval-core.md"),
    [
      "---",
      "tags: [ai, search]",
      "---",
      "# Retrieval Core",
      "",
      "This note owns the active retrieval project context and should stay linked.",
      "It cites [[Duplicate Topic]] and [[Weekly Review]].",
      "It also references [[Missing Context]] and ![[diagram one.png]].",
      "",
      "## Ranking",
      "Backlinks and tag evidence should explain why results matched.",
      "",
    ].join("\n"),
  );
  writeText(
    path.join(vault, "01-projects", "ai", "obsidian", "stale-project.md"),
    [
      "---",
      "tags: [ai, search]",
      "---",
      "# Stale Project",
      "",
      "Old retrieval cleanup tasks that still link to [[Duplicate Topic]].",
      "",
    ].join("\n"),
  );
  writeText(
    path.join(vault, "01-projects", "ai", "obsidian", "empty-note.md"),
    "# Empty Note\n",
  );
  writeText(
    path.join(vault, "01-projects", "ai", "obsidian", "overlong-note.md"),
    `# Overlong Note\n\n${"This is a long project review paragraph about retrieval quality and evidence ordering. ".repeat(120)}\n`,
  );
  writeText(
    path.join(vault, "02-knowledge", "ai", "search", "duplicate-topic.md"),
    [
      "---",
      "tags: [ai, search]",
      "---",
      "# Duplicate Topic",
      "",
      "Primary duplicate note with precise ranking language and a backlink to [[Retrieval Core]].",
      "",
    ].join("\n"),
  );
  writeText(
    path.join(vault, "02-knowledge", "ai", "search", "duplicate topic.md"),
    [
      "---",
      "tags: [ai, search]",
      "---",
      "# Duplicate Topic",
      "",
      "Secondary duplicate note that probably wants merge review with the primary copy.",
      "",
    ].join("\n"),
  );
  writeText(
    path.join(vault, "01-projects", "ops", "reviews", "weekly-review.md"),
    [
      "---",
      "tags: [review, notes]",
      "---",
      "# Weekly Review",
      "",
      "Project review checklist for active work.",
      "",
    ].join("\n"),
  );
  writeText(
    path.join(vault, "04-people", "health", "reviews", "weekly-review.md"),
    [
      "---",
      "tags: [health, review]",
      "---",
      "# Weekly Review",
      "",
      "Personal check-in note with intentionally different context from project reviews.",
      "",
    ].join("\n"),
  );
  writeText(
    path.join(vault, "02-knowledge", "ai", "search", "boilerplate-a.md"),
    [
      "---",
      "tags: [ai, notes]",
      "---",
      "# Link Checklist",
      "",
      "Template heading.",
      "",
      "Unique retrieval guidance for search calibration.",
      "",
    ].join("\n"),
  );
  writeText(
    path.join(vault, "02-knowledge", "ai", "search", "boilerplate-b.md"),
    [
      "---",
      "tags: [ai, notes]",
      "---",
      "# Link Checklist Copy",
      "",
      "Template heading.",
      "",
      "Unique archive guidance for personal knowledge cleanup.",
      "",
    ].join("\n"),
  );
  writeText(
    path.join(vault, "02-knowledge", "ai", "search", "retrieval-decision-log.md"),
    [
      "---",
      "tags: [ai, search]",
      "---",
      "# Retrieval Decision Log",
      "",
      "Decision log for ranking evidence, search calibration, duplicate review, and local retrieval tuning.",
      "",
    ].join("\n"),
  );
  writeText(
    path.join(vault, "02-knowledge", "ai", "search", "retrieval-decision-log-draft.md"),
    [
      "---",
      "tags: [ai, search]",
      "---",
      "# Retrieval Decision Log Draft",
      "",
      "Decision notes for ranking evidence, search calibration, duplicate review, and local retrieval tuning.",
      "",
    ].join("\n"),
  );
  writeText(
    path.join(vault, "02-knowledge", "pkm", "general", "local-memory-patterns.md"),
    [
      "---",
      "tags: [pkm, notes]",
      "---",
      "# Local Memory Patterns",
      "",
      "Durable local memory context uses linked review trails, resurfacing notes, and careful evidence summaries.",
      "",
    ].join("\n"),
  );
  writeText(
    path.join(vault, "02-knowledge", "pkm", "general", "durable-context-review.md"),
    [
      "---",
      "tags: [pkm, notes]",
      "---",
      "# Durable Context Review",
      "",
      "Durable local memory context uses linked review trails, resurfacing notes, and careful evidence summaries.",
      "",
    ].join("\n"),
  );
  writeText(
    path.join(vault, "02-knowledge", "pkm", "general", "orphan-note.md"),
    [
      "---",
      "tags: [pkm, notes]",
      "---",
      "# Orphan Note",
      "",
      "A forgotten but useful knowledge note about durable memory trails and local context.",
      "",
    ].join("\n"),
  );
  writeText(
    path.join(vault, "04-people", "health", "checkups", "health-context.md"),
    [
      "---",
      "tags: [ai, health]",
      "---",
      "# Health Context",
      "",
      "A people-health note carrying an AI tag that should look like a conflicting domain tag.",
      "",
    ].join("\n"),
  );
  writeText(
    path.join(vault, "00-inbox", "daily-notes", "2026-06-10.md"),
    [
      "# 2026-06-10",
      "",
      "- Capture: follow up on duplicate topic cleanup and broken retrieval links.",
      "",
    ].join("\n"),
  );
  writeText(path.join(vault, "03-assets", "assets", "diagram one.png"), "fake image bytes\n");
  writeText(
    path.join(vault, "07-system", "secrets", "token.md"),
    "PLAN08-SECRET-CANARY must never appear in diagnostics, review queues, or feedback state\n",
  );

  git(vault, ["init", "-q"]);
  git(vault, ["branch", "-M", "main"]);
  git(vault, ["add", "."]);
  git(vault, [
    "-c",
    "user.name=dreamers-test",
    "-c",
    "user.email=dreamers-test@example.invalid",
    "commit",
    "-qm",
    "baseline",
  ]);

  const staleEpoch = Date.UTC(2024, 0, 1) / 1000;
  setMtime(path.join(vault, "01-projects", "ai", "obsidian", "stale-project.md"), staleEpoch);
  setMtime(path.join(vault, "02-knowledge", "pkm", "general", "orphan-note.md"), staleEpoch);
  setMtime(path.join(vault, "01-projects", "ops", "reviews", "weekly-review.md"), staleEpoch);
  return vault;
}

function buildGraphIndex(frameworkRoot, vaultPath) {
  return buildSharedFixtureIndex(frameworkRoot, vaultPath, {
    approvedTags: GRAPH_APPROVED_TAGS,
  });
}

function readOne(databasePath, sql, ...params) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).get(...params);
  } finally {
    db.close();
  }
}

function readRows(databasePath, sql, ...params) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

function tableRowCount(databasePath, tableName) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const exists = db.prepare("select 1 from sqlite_schema where type = 'table' and name = ?").get(tableName);
    return exists ? db.prepare(`select count(*) as count from ${tableName}`).get().count : 0;
  } finally {
    db.close();
  }
}

function evidenceHashForTest(parts) {
  const digest = crypto.createHash("sha256");
  digest.update(parts.join("\u241f"));
  return digest.digest("hex");
}

function legacyDuplicateScoreForTest(signals) {
  const rawScore = Number((
    signals.titleSimilarity * 0.45
    + signals.pathSimilarity * 0.2
    + signals.contentFingerprint * 0.2
    + signals.tagOverlap * 0.1
    + signals.backlinkOverlap * 0.1
  ).toFixed(4));
  return signals.titleSimilarity >= 0.95 && signals.pathSimilarity < 0.5
    ? Math.min(rawScore, 0.55)
    : rawScore;
}

function callTool(rootDir, name, args, options = {}) {
  const { callMcpTool } = loadPackage();
  return callMcpTool(rootDir, name, args, options);
}

function unwrapToolResult(result) {
  assert.equal(result.isError, false, JSON.stringify(result));
  return result.structuredContent;
}

function unwrapToolError(result) {
  assert.equal(result.isError, true, JSON.stringify(result));
  return result.structuredContent.error;
}

function proposalArgsForPath(databasePath, targetPath, nextBody, overrides = {}) {
  const chunk = readOne(
    databasePath,
    "select chunk_id, heading_path, text from chunks where relative_path = ? order by ordinal limit 1",
    targetPath,
  );
  return {
    operation: "diagnostic-note-update",
    contextPackId: "graph-review",
    sourceChunkIds: chunk ? [chunk.chunk_id] : [],
    candidatePaths: [targetPath],
    approvedTags: ["ai", "search"],
    rationale: "Diagnostic follow-up should stay proposal-first.",
    evidence: chunk
      ? [
          {
            path: targetPath,
            chunkId: chunk.chunk_id,
            headingPath: chunk.heading_path,
            excerpt: chunk.text.slice(0, 120),
          },
        ]
      : [],
    targets: [
      {
        path: targetPath,
        mode: "replace",
        body: nextBody,
      },
    ],
    ...overrides,
  };
}

function seedPendingReviewState(frameworkRoot, databasePath, vaultPath) {
  const retrievalPath = "01-projects/ai/obsidian/retrieval-core.md";
  const retrievalAbsolute = path.join(vaultPath, retrievalPath);
  const retrievalBody = readText(retrievalAbsolute);
  const noteUpdate = unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_create",
      proposalArgsForPath(
        databasePath,
        retrievalPath,
        `${retrievalBody}\n## Review Follow-up\nTrack duplicate cleanup through the proposal queue.\n`,
      ),
      { writeEnabled: true },
    ),
  );

  const dailyPath = "00-inbox/daily-notes/2026-06-10.md";
  const dailyAbsolute = path.join(vaultPath, dailyPath);
  const dailyBody = readText(dailyAbsolute);
  const placementDebt = unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_create",
      {
        operation: "capture-placement-review",
        sourceChunkIds: [],
        candidatePaths: [
          "01-projects/ai/obsidian/retrieval-core.md",
          "02-knowledge/ai/search/duplicate-topic.md",
        ],
        approvedTags: ["ai", "search"],
        rationale: "Placement remained ambiguous during review, so the daily note holds it temporarily.",
        placementDebt: {
          originalText: "Need to decide whether duplicate cleanup belongs in project or knowledge notes.",
          ambiguityReason: "Both the project note and the knowledge duplicate are plausible owners.",
          reviewDueAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          candidateDestinations: [
            {
              path: "01-projects/ai/obsidian/retrieval-core.md",
              title: "Retrieval Core",
              reason: "Active project owner.",
            },
            {
              path: "02-knowledge/ai/search/duplicate-topic.md",
              title: "Duplicate Topic",
              reason: "Duplicate cleanup may belong with the durable knowledge note.",
            },
          ],
        },
        targets: [
          {
            path: dailyPath,
            mode: "replace",
            body: `${dailyBody}\n- Placement debt: duplicate cleanup still needs a durable owner.\n`,
          },
        ],
      },
      { writeEnabled: true },
    ),
  );
  return { noteUpdate, placementDebt };
}

function categories(items) {
  return new Set(items.map((item) => item.category));
}

function findCategory(items, category) {
  return items.find((item) => item.category === category);
}

test("pure essential graph reviews return findings without persisting reports or feedback", () => {
  const vault = makeGraphFixture();
  const frameworkRoot = makeGraphFrameworkRoot(vault);
  const { runtime } = buildGraphIndex(frameworkRoot, vault);
  const { loadVaultEnvironment } = loadPackage();
  const environment = loadVaultEnvironment({ rootDir: frameworkRoot });
  assert.equal(environment.ok, true, JSON.stringify(environment.error));
  const essential = require(path.join(distDir, "graph-review.js"));
  const beforeReports = tableRowCount(runtime.databasePath, "diagnostic_reports");
  const beforeFeedback = tableRowCount(runtime.databasePath, "diagnostic_feedback");

  for (const build of [
    essential.buildEphemeralGraphDiagnostics,
    essential.buildEphemeralHealthReport,
    essential.buildEphemeralDuplicateCandidates,
  ]) {
    const result = build(environment.value, { limit: 4 });
    assert.equal(result.ok, true, JSON.stringify(result.error));
  }

  assert.equal(tableRowCount(runtime.databasePath, "diagnostic_reports"), beforeReports);
  assert.equal(tableRowCount(runtime.databasePath, "diagnostic_feedback"), beforeFeedback);
});

test("graph_diagnostics reports graph structure, weak spots, bounded evidence, and redacted secret counts", () => {
  const vault = makeGraphFixture();
  const frameworkRoot = makeGraphFrameworkRoot(vault);
  const { runtime } = buildGraphIndex(frameworkRoot, vault);

  const diagnostics = unwrapToolResult(callTool(frameworkRoot, "graph_diagnostics", { limit: 3 }));

  assert.equal(diagnostics.summary.unresolvedLinks >= 1, true);
  assert.equal(diagnostics.sections.links.items.length > 0, true);
  assert.equal(diagnostics.sections.backlinks.items.length > 0, true);
  assert.equal(diagnostics.sections.embeds.items.length > 0, true);
  assert.equal(diagnostics.sections.tagCooccurrence.items.length > 0, true);
  assert.equal(diagnostics.sections.unresolvedLinks.items.length > 0, true);
  assert.equal(diagnostics.sections.orphanNotes.items.some((item) => item.paths.includes("02-knowledge/pkm/general/orphan-note.md")), true);
  assert.equal(diagnostics.sections.duplicateTitles.items.some((item) => item.paths.includes("02-knowledge/ai/search/duplicate-topic.md")), true);
  assert.equal(diagnostics.sections.overbroadTags.items.some((item) => item.tag === "ai"), true);
  assert.equal(diagnostics.sections.unresolvedLinks.items[0].evidence[0].excerpt.length <= 240, true);
  assert.equal(diagnostics.excluded.secretPathCount, 1);
  assert.equal(JSON.stringify(diagnostics).includes("PLAN08-SECRET-CANARY"), false);
  assert.equal(JSON.stringify(diagnostics).includes("07-system/secrets/token.md"), false);

  const reports = readRows(
    runtime.databasePath,
    "select report_type, summary_json, recorded_at from diagnostic_reports order by id asc",
  );
  const graphReport = reports.find((row) => row.report_type === "graph_diagnostics");
  assert.ok(graphReport);
  const graphSummary = JSON.parse(graphReport.summary_json);
  assert.deepEqual(
    Object.keys(graphSummary.counts).sort(),
    ["duplicateTitleGroups", "notes", "orphanNotes", "overbroadTags", "recentReports", "unresolvedLinks"],
  );
  assert.equal(graphSummary.counts.notes, diagnostics.summary.notes);
});

test("graph_context_pack groups a bounded neighborhood by edge type, confidence, and suggested use", () => {
  const vault = makeGraphFixture();
  const frameworkRoot = makeGraphFrameworkRoot(vault);
  buildGraphIndex(frameworkRoot, vault);

  const byPath = unwrapToolResult(
    callTool(frameworkRoot, "graph_context_pack", {
      path: "01-projects/ai/obsidian/retrieval-core.md",
      limit: 8,
    }),
  );
  assert.equal(byPath.subject.path, "01-projects/ai/obsidian/retrieval-core.md");
  assert.equal(byPath.groups.outgoingLinks.items.length > 0, true);
  assert.equal(byPath.groups.backlinks.items.length > 0, true);
  assert.equal(byPath.groups.embeds.items.length > 0, true);
  assert.equal(typeof byPath.groups.outgoingLinks.items[0].confidence, "number");
  assert.equal(typeof byPath.groups.outgoingLinks.items[0].suggestedUse, "string");

  const byQuery = unwrapToolResult(
    callTool(frameworkRoot, "graph_context_pack", {
      query: "duplicate topic ranking",
      limit: 6,
    }),
  );
  assert.equal(typeof byQuery.subject.path, "string");
  assert.equal(byQuery.groups.duplicateCandidates.items.length > 0, true);
  assert.equal(byQuery.groups.sharedTags.items.length > 0, true);

  const byShortTag = unwrapToolResult(
    callTool(frameworkRoot, "graph_context_pack", {
      query: "ai",
      limit: 6,
    }),
  );
  assert.match(byShortTag.subject.path, /\/ai\//);

  const byTagOnly = unwrapToolResult(
    callTool(frameworkRoot, "graph_context_pack", {
      query: "pkm",
      limit: 6,
    }),
  );
  assert.match(byTagOnly.subject.path, /^02-knowledge\/pkm\//);
});

test("health_report returns severity-ranked bounded items for weak notes, pending review state, and conflicting tags", () => {
  const vault = makeGraphFixture();
  const frameworkRoot = makeGraphFrameworkRoot(vault);
  const { runtime } = buildGraphIndex(frameworkRoot, vault);
  seedPendingReviewState(frameworkRoot, runtime.databasePath, vault);

  const report = unwrapToolResult(callTool(frameworkRoot, "health_report", { limit: 20 }));
  const itemCategories = categories(report.items);

  for (const category of [
    "broken-link",
    "orphan-note",
    "empty-note",
    "duplicate-title",
    "overlong-note",
    "stale-project",
    "unresolved-proposal",
    "unprocessed-daily-capture",
    "placement-debt",
    "conflicting-tags",
  ]) {
    assert.equal(itemCategories.has(category), true, category);
  }

  assert.deepEqual(
    report.items.map((item) => item.severity),
    [...report.items.map((item) => item.severity)].sort((left, right) => {
      const order = { high: 0, medium: 1, low: 2, info: 3 };
      return order[left] - order[right];
    }),
  );
  assert.equal(report.items[0].evidence[0].excerpt.length <= 240, true);
  assert.equal(Array.isArray(findCategory(report.items, "broken-link").recommendedProposalTypes), true);
  assert.equal(JSON.stringify(report).includes("07-system/secrets/token.md"), false);
});

test("duplicate_candidates distinguishes merge-review duplicates from keep-both anti-examples and ignores boilerplate lookalikes", () => {
  const vault = makeGraphFixture();
  const frameworkRoot = makeGraphFrameworkRoot(vault);
  buildGraphIndex(frameworkRoot, vault);

  const duplicates = unwrapToolResult(callTool(frameworkRoot, "duplicate_candidates", { limit: 20 }));
  const positive = duplicates.items.find(
    (item) =>
      item.paths.includes("02-knowledge/ai/search/duplicate-topic.md")
      && item.paths.includes("02-knowledge/ai/search/duplicate topic.md"),
  );
  assert.equal(positive.suggestedUse, "merge-review");
  assert.equal(positive.confidence >= 0.75, true);
  assert.equal(positive.signals.titleSimilarity > 0, true);
  assert.equal(positive.signals.contentFingerprint > 0, true);
  const legacyScore = legacyDuplicateScoreForTest(positive.signals);
  const legacyHashCandidates = [
    evidenceHashForTest([positive.paths[0], positive.paths[1], String(legacyScore)]),
    evidenceHashForTest([positive.paths[1], positive.paths[0], String(legacyScore)]),
  ];
  assert.equal(legacyHashCandidates.includes(positive.evidenceHash), true);

  unwrapToolResult(
    callTool(frameworkRoot, "diagnostic_feedback", {
      reportType: "duplicate_candidates",
      itemKey: positive.itemKey,
      evidenceHash: positive.evidenceHash,
      action: "dismiss",
      reason: "Legacy duplicate-candidate suppression must survive rule refactors.",
    }),
  );
  const suppressed = unwrapToolResult(callTool(frameworkRoot, "duplicate_candidates", { limit: 20 }));
  assert.equal(suppressed.items.some((item) => item.itemKey === positive.itemKey), false);
  assert.equal(suppressed.suppressedCount >= 1, true);

  const keepBoth = duplicates.items.find(
    (item) =>
      item.paths.includes("01-projects/ops/reviews/weekly-review.md")
      && item.paths.includes("04-people/health/reviews/weekly-review.md"),
  );
  assert.equal(keepBoth.suggestedUse, "keep-both");
  assert.equal(keepBoth.confidence <= 0.55, true);

  const sharedTitle = duplicates.items.find(
    (item) =>
      item.paths.includes("02-knowledge/ai/search/retrieval-decision-log.md")
      && item.paths.includes("02-knowledge/ai/search/retrieval-decision-log-draft.md"),
  );
  assert.equal(sharedTitle.signal, "shared-title-tokens");
  assert.equal(sharedTitle.suggestedUse, "link");
  assert.equal(sharedTitle.confidence, 0.72);
  assert.equal(sharedTitle.signals.titleSimilarity >= 0.5, true);

  const sharedTags = duplicates.items.find(
    (item) =>
      item.paths.includes("02-knowledge/pkm/general/local-memory-patterns.md")
      && item.paths.includes("02-knowledge/pkm/general/durable-context-review.md"),
  );
  assert.equal(sharedTags.signal, "shared-tags");
  assert.equal(sharedTags.suggestedUse, "link");
  assert.equal(sharedTags.confidence, 0.66);
  assert.equal(sharedTags.signals.tagOverlap >= 0.7, true);

  assert.equal(
    duplicates.items.some(
      (item) =>
        item.paths.includes("02-knowledge/ai/search/boilerplate-a.md")
        && item.paths.includes("02-knowledge/ai/search/boilerplate-b.md"),
    ),
    false,
  );
});

test("resurfacing_report returns stale context, high-value orphans, placement debt, and related older notes without mutating the vault", () => {
  const vault = makeGraphFixture();
  const frameworkRoot = makeGraphFrameworkRoot(vault);
  const { runtime } = buildGraphIndex(frameworkRoot, vault);
  seedPendingReviewState(frameworkRoot, runtime.databasePath, vault);
  const beforeStatus = git(vault, ["status", "--short"]);

  const resurfacing = unwrapToolResult(callTool(frameworkRoot, "resurfacing_report", { limit: 12 }));
  const itemCategories = categories(resurfacing.items);

  assert.equal(itemCategories.has("stale-project"), true);
  assert.equal(itemCategories.has("high-value-orphan"), true);
  assert.equal(itemCategories.has("placement-debt"), true);
  assert.equal(itemCategories.has("related-older-note"), true);
  assert.equal(resurfacing.items.every((item) => item.evidence[0].excerpt.length <= 240), true);
  assert.equal(git(vault, ["status", "--short"]), beforeStatus);
});

test("diagnostic_feedback records suppressions until evidence changes and keeps runtime-only state", () => {
  const vault = makeGraphFixture();
  const frameworkRoot = makeGraphFrameworkRoot(vault);
  const { runtime } = buildGraphIndex(frameworkRoot, vault);

  const first = unwrapToolResult(callTool(frameworkRoot, "health_report", { limit: 20 }));
  const brokenLink = findCategory(first.items, "broken-link");
  assert.ok(brokenLink);

  const recorded = unwrapToolResult(
    callTool(frameworkRoot, "diagnostic_feedback", {
      reportType: "health_report",
      itemKey: brokenLink.itemKey,
      evidenceHash: brokenLink.evidenceHash,
      action: "dismiss",
      reason: "Known issue until the next cleanup pass.",
    }),
  );
  assert.equal(recorded.recorded, true);
  assert.equal(recorded.action, "dismiss");

  const suppressed = unwrapToolResult(callTool(frameworkRoot, "health_report", { limit: 20 }));
  assert.equal(suppressed.items.some((item) => item.itemKey === brokenLink.itemKey), false);

  const targetPath = path.join(vault, "01-projects", "ai", "obsidian", "retrieval-core.md");
  writeText(
    targetPath,
    readText(targetPath).replace("[[Missing Context]]", "[[Missing Context Updated]]"),
  );
  unwrapToolResult(callTool(frameworkRoot, "index_refresh", {}));

  const resurfaced = unwrapToolResult(callTool(frameworkRoot, "health_report", { limit: 20 }));
  assert.equal(resurfaced.items.some((item) => item.category === "broken-link"), true);

  const feedbackRows = readRows(
    runtime.databasePath,
    "select action, reason from diagnostic_feedback order by id asc",
  );
  assert.equal(feedbackRows.some((row) => row.action === "dismiss"), true);
});

test("review_queue surfaces compact daily or weekly actions and proposal-first remediation stays in the queue", () => {
  const vault = makeGraphFixture();
  const frameworkRoot = makeGraphFrameworkRoot(vault);
  const { runtime } = buildGraphIndex(frameworkRoot, vault);
  seedPendingReviewState(frameworkRoot, runtime.databasePath, vault);

  const reviewQueue = unwrapToolResult(callTool(frameworkRoot, "review_queue", { mode: "weekly", limit: 12 }));
  const groupNames = reviewQueue.groups.map((group) => group.name);

  for (const name of [
    "placement-debt",
    "new-captures",
    "unresolved-proposals",
    "weak-notes",
    "duplicate-candidates",
    "stale-projects",
    "resurfacing",
  ]) {
    assert.equal(groupNames.includes(name), true, name);
  }
  assert.equal(reviewQueue.groups.every((group) => group.items.length > 0), true);

  const brokenLink = findCategory(
    unwrapToolResult(callTool(frameworkRoot, "health_report", { limit: 20 })).items,
    "broken-link",
  );
  const retrievalPath = path.join(vault, "01-projects", "ai", "obsidian", "retrieval-core.md");
  const proposal = unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_create",
      proposalArgsForPath(
        runtime.databasePath,
        "01-projects/ai/obsidian/retrieval-core.md",
        readText(retrievalPath).replace("[[Missing Context]]", "[[Duplicate Topic]]"),
        {
          operation: "diagnostic-link-fix",
          rationale: brokenLink.summary,
          unresolvedQuestions: ["Should Duplicate Topic be the canonical replacement target?"],
        },
      ),
      { writeEnabled: true },
    ),
  );
  const proposalRead = unwrapToolResult(
    callTool(frameworkRoot, "proposal_read", { proposalId: proposal.proposalId }),
  );
  assert.equal(proposalRead.proposal.operation, "diagnostic-link-fix");
  assert.equal(proposalRead.proposal.targetPaths.includes("01-projects/ai/obsidian/retrieval-core.md"), true);
  assert.equal(Array.isArray(proposalRead.diffPreview), true);
  assert.equal(Object.keys(proposalRead.proposal.lineage.beforeHashes).length > 0, true);
  assert.equal(git(vault, ["status", "--short"]), "");
});

test("review_queue records one report without nested review report side effects and keeps runtime files private", () => {
  const vault = makeGraphFixture();
  const frameworkRoot = makeGraphFrameworkRoot(vault);
  const { runtime } = buildGraphIndex(frameworkRoot, vault);
  seedPendingReviewState(frameworkRoot, runtime.databasePath, vault);

  const reviewQueue = unwrapToolResult(callTool(frameworkRoot, "review_queue", { mode: "weekly", limit: 12 }));
  assert.equal(reviewQueue.counts.totalItems > 0, true);

  const afterReports = readRows(
    runtime.databasePath,
    "select report_type, summary_json from diagnostic_reports order by id asc",
  );
  assert.deepEqual(afterReports.map((row) => row.report_type), ["review_queue"]);
  const summary = JSON.parse(afterReports[0].summary_json);
  assert.equal(summary.mode, "weekly");
  assert.equal(Object.hasOwn(summary.groupCounts, "duplicate-candidates"), true);
  assert.equal((fs.statSync(runtime.databasePath).mode & 0o077), 0);
});

test("manual directory homepage drift is read-only, feedback-compatible, private, and queued for repair", () => {
  const vault = tmpdir("dreamers-note-directory-health-vault");
  const notePath = "02-knowledge/ai/search/topic.md";
  const indexPath = "02-knowledge/ai/search/_search.md";
  const missingNotePath = "02-knowledge/ai/missing/topic.md";
  const missingIndexPath = "02-knowledge/ai/missing/_missing.md";
  const canonicalIndexPath = "02-knowledge/ai/canonical/_canonical.md";
  writeText(
    path.join(vault, notePath),
    "# Topic\n\nTopic now describes reviewed directory synchronization.\n",
  );
  writeText(
    path.join(vault, indexPath),
    [
      "Stale generated lead.",
      "",
      "## Notes",
      "",
      "Human context remains private and stable.",
      "",
      "## Pages",
      "",
      "- stale",
      "",
    ].join("\n"),
  );
  writeText(
    path.join(vault, missingNotePath),
    "# Missing Topic\n\nMissing topic requires a homepage.\n",
  );
  writeText(
    path.join(vault, "02-knowledge/ai/canonical/stable.md"),
    "# Stable\n\nStable canonical page.\n",
  );
  writeText(
    path.join(vault, canonicalIndexPath),
    [
      "Canonical collects notes on Stable.",
      "",
      "## Notes",
      "",
      "## Pages",
      "",
      "- [[02-knowledge/ai/canonical/stable|Stable]] - Stable canonical page.",
      "",
    ].join("\n"),
  );
  writeText(
    path.join(vault, "07-system", "secrets", "directory-canary.md"),
    "DIRECTORY-HEALTH-SECRET-CANARY",
  );
  git(vault, ["init", "-q"]);
  git(vault, ["branch", "-M", "main"]);
  git(vault, ["add", "."]);
  git(vault, [
    "-c",
    "user.name=dreamers-test",
    "-c",
    "user.email=dreamers-test@example.invalid",
    "commit",
    "-qm",
    "baseline",
  ]);
  const frameworkRoot = makeGraphFrameworkRoot(vault);
  buildGraphIndex(frameworkRoot, vault);
  const beforeStatus = git(vault, ["status", "--short"]);

  const healthStarted = performance.now();
  const report = unwrapToolResult(callTool(frameworkRoot, "health_report", { limit: 20 }));
  assert.equal(performance.now() - healthStarted < 3_000, true);
  const drift = report.items.find(
    (item) => item.category === "directory-index-drift" && item.paths[0] === indexPath,
  );
  assert.ok(drift);
  const missing = report.items.find(
    (item) => item.category === "directory-index-drift" && item.paths[0] === missingIndexPath,
  );
  assert.ok(missing);
  assert.equal(missing.signal, "directory-index-missing");
  assert.equal(
    report.items.some(
      (item) => item.category === "directory-index-drift" && item.paths[0] === canonicalIndexPath,
    ),
    false,
  );
  assert.equal(drift.recommendedProposalTypes.includes("directory-index-refresh"), true);
  assert.equal(drift.evidence[0].excerpt.length <= 240, true);
  assert.doesNotMatch(JSON.stringify(report), /DIRECTORY-HEALTH-SECRET-CANARY/);
  assert.doesNotMatch(JSON.stringify(report), /07-system\/secrets/);
  assert.equal(git(vault, ["status", "--short"]), beforeStatus);

  const queueStarted = performance.now();
  const queue = unwrapToolResult(
    callTool(frameworkRoot, "review_queue", { mode: "weekly", limit: 20 }),
  );
  assert.equal(performance.now() - queueStarted < 3_000, true);
  const homepageGroup = queue.groups.find((group) => group.name === "directory-homepages");
  assert.ok(homepageGroup);
  assert.equal(homepageGroup.items.some((item) => item.itemKey === drift.itemKey), true);
  assert.equal(homepageGroup.items.some((item) => item.itemKey === missing.itemKey), true);
  assert.equal(git(vault, ["status", "--short"]), beforeStatus);

  unwrapToolResult(
    callTool(frameworkRoot, "diagnostic_feedback", {
      reportType: "health_report",
      itemKey: drift.itemKey,
      evidenceHash: drift.evidenceHash,
      action: "dismiss",
      reason: "Defer this homepage repair until the next vault branch.",
    }),
  );
  const suppressed = unwrapToolResult(callTool(frameworkRoot, "health_report", { limit: 20 }));
  assert.equal(suppressed.items.some((item) => item.itemKey === drift.itemKey), false);

  writeText(
    path.join(vault, indexPath),
    `${readText(path.join(vault, indexPath))}\nNew material drift after dismissal.\n`,
  );
  const changedAgain = unwrapToolResult(callTool(frameworkRoot, "health_report", { limit: 20 }));
  const refreshedDrift = changedAgain.items.find((item) => item.itemKey === drift.itemKey);
  assert.ok(refreshedDrift);
  assert.notEqual(refreshedDrift.evidenceHash, drift.evidenceHash);
});
