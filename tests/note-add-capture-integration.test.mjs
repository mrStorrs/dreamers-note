import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  buildFixtureIndex as buildSharedFixtureIndex,
  git,
  loadBuiltPackage,
  makeFrameworkRoot as makeSharedFrameworkRoot,
  projectRoot,
  readText,
  tmpdir,
  writeText,
} from "./helpers/project-fixtures.mjs";

const root = projectRoot;
const WORKFLOW_APPROVED_TAGS = ["ai", "obsidian", "search", "pkm", "notes"];

function loadPackage() {
  return loadBuiltPackage();
}

function makeWorkflowFrameworkRoot(vaultPath) {
  return makeSharedFrameworkRoot(vaultPath, {
    tempPrefix: "dreamers-note-workflow-framework",
    approvedTags: WORKFLOW_APPROVED_TAGS,
  });
}

function makeWorkflowFixture() {
  const vault = tmpdir("dreamers-note-workflow-vault");
  writeText(
    path.join(vault, "01-projects", "ai", "obsidian", "retrieval-core.md"),
    [
      "---",
      "tags: [ai, obsidian]",
      "---",
      "# Retrieval Core",
      "",
      "This note owns the active project work for retrieval behavior.",
      "",
      "## Follow Ups",
      "Lexical ranking and placement reviews should land here when they are clearly project work.",
      "",
    ].join("\n"),
  );
  writeText(
    path.join(vault, "02-knowledge", "ai", "search", "ranking-notes.md"),
    [
      "---",
      "tags: [ai, search]",
      "---",
      "# Ranking Notes",
      "",
      "Reusable search guidance and durable notes about ranking belong here.",
      "",
    ].join("\n"),
  );
  writeText(
    path.join(vault, "00-inbox", "daily-notes", "2026-06-13.md"),
    [
      "# 2026-06-13",
      "",
      "## notes",
      "",
      "- Existing capture.",
      "",
    ].join("\n"),
  );
  writeText(
    path.join(vault, "07-system", "secrets", "token.md"),
    "PLAN06-SECRET-CANARY must never appear in workflow proposals or placement debt\n",
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
  return vault;
}

function buildWorkflowIndex(frameworkRoot, vaultPath) {
  return buildSharedFixtureIndex(frameworkRoot, vaultPath, {
    approvedTags: WORKFLOW_APPROVED_TAGS,
  });
}

function callTool(rootDir, name, args, options = {}) {
  const { callMcpTool } = loadPackage();
  return callMcpTool(rootDir, name, args, options);
}

function unwrapToolResult(result) {
  assert.equal(result.isError, false, JSON.stringify(result));
  return result.structuredContent;
}

function proposalRead(frameworkRoot, proposalId) {
  return unwrapToolResult(
    callTool(frameworkRoot, "proposal_read", { proposalId }),
  );
}

test("context_pack place returns note-level destination candidates for add workflows", () => {
  const vault = makeWorkflowFixture();
  const frameworkRoot = makeWorkflowFrameworkRoot(vault);
  buildWorkflowIndex(frameworkRoot, vault);

  const pack = unwrapToolResult(
    callTool(frameworkRoot, "context_pack", {
      query: "retrieval core lexical ranking follow-up",
      profile: "place",
      limit: 4,
    }),
  );

  assert.equal(pack.profile, "place");
  assert.equal(pack.retrievalSignal.state, "strong");
  assert.equal(pack.candidateDestinations[0].path, "01-projects/ai/obsidian/retrieval-core.md");
  assert.equal(pack.candidateDestinations[0].containerPath, "01-projects/ai/obsidian");
  assert.equal(Array.isArray(pack.candidateDestinations[0].whyMatched), true);
  assert.equal(typeof pack.candidateDestinations[0].score, "number");
});

test("context_pack place suppresses weak-only candidates and returns fallback suggestions", () => {
  const vault = makeWorkflowFixture();
  const frameworkRoot = makeWorkflowFrameworkRoot(vault);
  buildWorkflowIndex(frameworkRoot, vault);

  const pack = unwrapToolResult(
    callTool(frameworkRoot, "context_pack", {
      query: "latest ai",
      profile: "place",
      limit: 4,
    }),
  );

  assert.equal(pack.profile, "place");
  assert.equal(pack.retrievalSignal.state, "low-signal");
  assert.equal(pack.candidateDestinations.length, 0);
  assert.equal(pack.fallbackSuggestions.some((item) => item.kind === "project-note"), true);
  assert.equal(pack.fallbackSuggestions.some((item) => item.kind === "daily-fallback"), true);
  assert.equal(pack.actions.some((item) => /do not trust weak/i.test(item)), true);
});

test("proposal_create_note supports new durable note proposals without cited source chunks", () => {
  const vault = makeWorkflowFixture();
  const frameworkRoot = makeWorkflowFrameworkRoot(vault);
  buildWorkflowIndex(frameworkRoot, vault);
  const newPath = "02-knowledge/ai/search/semantic-ranking-followups.md";

  const created = unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_create_note",
      {
        operation: "note-add",
        path: newPath,
        mode: "create",
        body: "# Semantic Ranking Followups\n\nDurable follow-up material for search ranking.\n",
        rationale: "No existing durable note owns semantic ranking follow-ups yet.",
        sourceChunkIds: [],
        candidatePaths: [newPath],
        approvedTags: ["ai", "search"],
        proposedTagGaps: ["semantic-ranking"],
        placementScorecard: {
          subjectOwnership: "New durable subject",
          insertionAnchor: "New note",
          namingFit: "semantic-ranking-followups",
          tagFit: ["ai", "search"],
          linkFit: ["[[01-projects/ai/obsidian/retrieval-core]]"],
          ambiguity: "low",
          fallbackReason: null,
          confidence: 0.78,
          unresolvedQuestions: [],
        },
      },
      { writeEnabled: true },
    ),
  );

  const read = proposalRead(frameworkRoot, created.proposalId);
  assert.equal(read.proposal.evidence.length, 0);
  assert.equal(
    read.proposal.targets[0].body,
    "# Semantic Ranking Followups\n\nDurable follow-up material for search ranking.\n",
  );
  assert.equal(read.proposal.placementScorecard.subjectOwnership, "New durable subject");
  assert.equal(read.validation.state, "current");
});

test("ambiguous capture fallback stores placement debt without mutating the daily note before approval", () => {
  const vault = makeWorkflowFixture();
  const frameworkRoot = makeWorkflowFrameworkRoot(vault);
  buildWorkflowIndex(frameworkRoot, vault);
  const dailyPath = "00-inbox/daily-notes/2026-06-13.md";
  const beforeDaily = readText(path.join(vault, dailyPath));

  const created = unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_create_note",
      {
        operation: "capture-fallback",
        path: dailyPath,
        mode: "replace",
        body: `${beforeDaily}\n- Compare lexical and semantic ranking follow-ups.\n`,
        rationale: "Two plausible durable destinations remain, so the capture should land in today’s daily note pending review.",
        sourceChunkIds: [],
        candidatePaths: [
          "01-projects/ai/obsidian/retrieval-core.md",
          "02-knowledge/ai/search/ranking-notes.md",
        ],
        approvedTags: ["ai"],
        placementScorecard: {
          subjectOwnership: "Split between project and durable knowledge",
          insertionAnchor: "Daily note fallback",
          namingFit: "Capture remains ambiguous",
          tagFit: ["ai"],
          linkFit: [
            "[[01-projects/ai/obsidian/retrieval-core]]",
            "[[02-knowledge/ai/search/ranking-notes]]",
          ],
          ambiguity: "high",
          fallbackReason: "Two plausible durable destinations remain.",
          confidence: 0.34,
          unresolvedQuestions: ["Which note should own this after review?"],
        },
        placementDebt: {
          originalText: "Compare lexical and semantic ranking follow-ups.",
          ambiguityReason: "Both the project note and the durable ranking note are plausible owners.",
          candidateDestinations: [
            {
              path: "01-projects/ai/obsidian/retrieval-core.md",
              reason: "Project-specific implementation follow-up.",
            },
            {
              path: "02-knowledge/ai/search/ranking-notes.md",
              reason: "Reusable ranking guidance could also own this content.",
            },
          ],
        },
      },
      { writeEnabled: true },
    ),
  );

  const read = proposalRead(frameworkRoot, created.proposalId);
  assert.equal(read.proposal.targetPaths[0], dailyPath);
  assert.equal(read.proposal.placementDebt.originalText, "Compare lexical and semantic ranking follow-ups.");
  assert.equal(read.proposal.placementDebt.candidateDestinations.length, 2);
  assert.match(read.proposal.placementDebt.reviewDueAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(readText(path.join(vault, dailyPath)), beforeDaily);

  const listed = unwrapToolResult(callTool(frameworkRoot, "proposal_list", {}));
  const item = listed.items.find((entry) => entry.proposalId === created.proposalId);
  assert.equal(Boolean(item), true);
  assert.equal(item.placementDebt.originalText, undefined);
  assert.equal(typeof item.placementDebt.reviewDueAt, "string");
});

test("explicit daily append proposals do not require placement debt", () => {
  const vault = makeWorkflowFixture();
  const frameworkRoot = makeWorkflowFrameworkRoot(vault);
  buildWorkflowIndex(frameworkRoot, vault);
  const dailyPath = "00-inbox/daily-notes/2026-06-13.md";
  const beforeDaily = readText(path.join(vault, dailyPath));

  const created = unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_create_note",
      {
        operation: "capture-daily-append",
        path: dailyPath,
        mode: "replace",
        body: `${beforeDaily}\n- Explicit daily append.\n`,
        rationale: "The user explicitly asked to append this note to today’s daily note.",
        sourceChunkIds: [],
        candidatePaths: [dailyPath],
        approvedTags: [],
        placementScorecard: {
          subjectOwnership: "Explicit daily capture request",
          insertionAnchor: "Today’s daily note",
          namingFit: "Daily note append",
          tagFit: [],
          linkFit: [],
          ambiguity: "none",
          fallbackReason: "Explicit daily note request",
          confidence: 0.99,
          unresolvedQuestions: [],
        },
      },
      { writeEnabled: true },
    ),
  );

  const read = proposalRead(frameworkRoot, created.proposalId);
  assert.equal(read.proposal.placementDebt, undefined);
  assert.equal(read.validation.state, "current");
});

test("prompts and skill contracts describe MCP-backed place-first add and capture workflows", () => {
  const vault = makeWorkflowFixture();
  const frameworkRoot = makeWorkflowFrameworkRoot(vault);
  buildWorkflowIndex(frameworkRoot, vault);
  const { getMcpPrompt } = loadPackage();

  const addPrompt = getMcpPrompt(frameworkRoot, "add");
  assert.equal(addPrompt.ok, true);
  assert.match(addPrompt.value.messages[0].content.text, /workflow_ready/i);
  assert.match(addPrompt.value.messages[0].content.text, /context_pack/i);
  assert.match(addPrompt.value.messages[0].content.text, /workflow_policy/i);
  assert.match(addPrompt.value.messages[0].content.text, /proposal_create_note/i);
  assert.match(addPrompt.value.messages[0].content.text, /proposal_read/i);
  assert.match(addPrompt.value.messages[0].content.text, /fallbackSuggestions/i);
  assert.match(addPrompt.value.messages[0].content.text, /dreamers-note:\/\/workflow-policy\/add/i);
  assert.match(addPrompt.value.messages[0].content.text, /not as proposal evidence/i);

  const capturePrompt = getMcpPrompt(frameworkRoot, "capture");
  assert.equal(capturePrompt.ok, true);
  assert.match(capturePrompt.value.messages[0].content.text, /workflow_ready/i);
  assert.match(capturePrompt.value.messages[0].content.text, /place-first/i);
  assert.match(capturePrompt.value.messages[0].content.text, /daily note/i);
  assert.match(capturePrompt.value.messages[0].content.text, /placement debt/i);
  assert.match(capturePrompt.value.messages[0].content.text, /workflow_policy/i);
  assert.match(capturePrompt.value.messages[0].content.text, /proposal_create_note/i);
  assert.match(capturePrompt.value.messages[0].content.text, /low-signal/i);
  assert.match(capturePrompt.value.messages[0].content.text, /dreamers-note:\/\/workflow-policy\/capture/i);
  assert.match(capturePrompt.value.messages[0].content.text, /not as proposal evidence/i);

  const noteAddSkill = readText(path.join(root, ".codex", "skills", "note-add", "SKILL.md"));
  assert.match(noteAddSkill, /workflow_ready/i);
  assert.match(noteAddSkill, /context_pack/i);
  assert.match(noteAddSkill, /workflow_policy/i);
  assert.match(noteAddSkill, /proposal_create_note/i);
  assert.match(noteAddSkill, /fallbackSuggestions/i);
  assert.match(noteAddSkill, /dreamers-note:\/\/workflow-policy\/add/i);
  assert.match(noteAddSkill, /not evidence inputs/i);
  assert.match(noteAddSkill, /MCP server is unavailable/i);
  assert.match(noteAddSkill, /manual or script workflow/i);
  assert.doesNotMatch(noteAddSkill, /docs\/conventions\.md/i);

  const dailyCaptureSkill = readText(path.join(root, ".codex", "skills", "daily-capture", "SKILL.md"));
  assert.match(dailyCaptureSkill, /workflow_ready/i);
  assert.match(dailyCaptureSkill, /place-first/i);
  assert.match(dailyCaptureSkill, /explicit daily-note append/i);
  assert.match(dailyCaptureSkill, /placement debt/i);
  assert.match(dailyCaptureSkill, /workflow_policy/i);
  assert.match(dailyCaptureSkill, /MCP server is unavailable/i);
  assert.match(dailyCaptureSkill, /proposal_create_note/i);
  assert.match(dailyCaptureSkill, /low-signal/i);
  assert.match(dailyCaptureSkill, /dreamers-note:\/\/workflow-policy\/capture/i);
  assert.match(dailyCaptureSkill, /not evidence inputs/i);

  const noteLauncher = readText(path.join(root, "global-skills", "dreamers-note", "SKILL.md"));
  assert.match(noteLauncher, /workflow_ready/i);
  assert.match(noteLauncher, /context_pack` profile `place`/i);
  assert.match(noteLauncher, /workflow_policy/i);
  assert.match(noteLauncher, /fallbackSuggestions/i);
  assert.match(noteLauncher, /dreamers-note:\/\/workflow-policy\/add/i);
  assert.match(noteLauncher, /not as proposal evidence/i);

  const captureLauncher = readText(path.join(root, "global-skills", "dreamers-note-capture", "SKILL.md"));
  assert.match(captureLauncher, /workflow_ready/i);
  assert.match(captureLauncher, /place-first/i);
  assert.match(captureLauncher, /explicit daily-note append/i);
  assert.match(captureLauncher, /context_pack` profile `place`/i);
  assert.match(captureLauncher, /workflow_policy/i);
  assert.match(captureLauncher, /fallbackSuggestions/i);
  assert.match(captureLauncher, /dreamers-note:\/\/workflow-policy\/capture/i);
});
