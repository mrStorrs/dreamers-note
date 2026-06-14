import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

function loadPackage() {
  return require(path.join(dist, "index.js"));
}

function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function mkdirp(target) {
  fs.mkdirSync(target, { recursive: true });
}

function writeText(target, text) {
  mkdirp(path.dirname(target));
  fs.writeFileSync(target, text, "utf8");
}

function readText(target) {
  return fs.readFileSync(target, "utf8");
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function makeFrameworkRoot(vaultPath) {
  const frameworkRoot = tmpdir("dreamers-note-workflow-framework");
  writeText(
    path.join(frameworkRoot, "config", "vault.json"),
    `${JSON.stringify({ vault_path: vaultPath }, null, 2)}\n`,
  );
  writeText(
    path.join(frameworkRoot, "config", "runtime.json"),
    `${JSON.stringify(
      {
        data_dir: ".dreamers-note-runtime",
        private_globs: ["07-system/secrets/**"],
      },
      null,
      2,
    )}\n`,
  );
  writeText(
    path.join(frameworkRoot, "config", "conventions.json"),
    `${JSON.stringify(
      {
        classified_note_roots: ["01-projects", "02-knowledge", "04-people"],
        disallowed_roots: ["02-areas", "03-knowledge"],
        classified_note_pattern: "<root>/<main>/<sub>/<note-name>.md",
      },
      null,
      2,
    )}\n`,
  );
  writeText(
    path.join(frameworkRoot, "taxonomy", "approved-tags.md"),
    "# approved tags\n\n- ai\n- obsidian\n- search\n- pkm\n- notes\n",
  );
  writeText(
    path.join(frameworkRoot, "docs", "conventions.md"),
    [
      "# conventions",
      "",
      "Project, knowledge, and people notes use exactly two classification directories below the root.",
      "Daily notes live under 00-inbox/daily-notes.",
      "Only approved topical tags may be applied.",
      "",
    ].join("\n"),
  );
  writeText(path.join(frameworkRoot, ".gitignore"), ".dreamers-note-runtime/\n");
  return frameworkRoot;
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

function buildFixtureIndex(frameworkRoot, vaultPath) {
  const {
    initializeRuntimeState,
    rebuildVaultIndex,
    loadRuntimeConfig,
  } = loadPackage();
  const runtimeConfig = loadRuntimeConfig({ rootDir: frameworkRoot });
  const runtime = initializeRuntimeState({ rootDir: frameworkRoot, config: runtimeConfig });
  const rebuild = rebuildVaultIndex({
    vaultPath,
    databasePath: runtime.databasePath,
    privateGlobs: runtimeConfig.privateGlobs,
    approvedTags: ["ai", "obsidian", "search", "pkm", "notes"],
    embeddingConfig: runtimeConfig.embeddings,
  });
  assert.equal(rebuild.ok, true, JSON.stringify(rebuild.error));
  return { runtime, runtimeConfig };
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
  const frameworkRoot = makeFrameworkRoot(vault);
  buildFixtureIndex(frameworkRoot, vault);

  const pack = unwrapToolResult(
    callTool(frameworkRoot, "context_pack", {
      query: "retrieval core lexical ranking follow-up",
      profile: "place",
      limit: 4,
    }),
  );

  assert.equal(pack.profile, "place");
  assert.equal(pack.candidateDestinations[0].path, "01-projects/ai/obsidian/retrieval-core.md");
  assert.equal(pack.candidateDestinations[0].containerPath, "01-projects/ai/obsidian");
  assert.equal(Array.isArray(pack.candidateDestinations[0].whyMatched), true);
  assert.equal(typeof pack.candidateDestinations[0].score, "number");
});

test("proposal_create_note supports new durable note proposals without cited source chunks", () => {
  const vault = makeWorkflowFixture();
  const frameworkRoot = makeFrameworkRoot(vault);
  buildFixtureIndex(frameworkRoot, vault);
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
  const frameworkRoot = makeFrameworkRoot(vault);
  buildFixtureIndex(frameworkRoot, vault);
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
  const frameworkRoot = makeFrameworkRoot(vault);
  buildFixtureIndex(frameworkRoot, vault);
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
  const frameworkRoot = makeFrameworkRoot(vault);
  buildFixtureIndex(frameworkRoot, vault);
  const { getMcpPrompt } = loadPackage();

  const addPrompt = getMcpPrompt(frameworkRoot, "add");
  assert.equal(addPrompt.ok, true);
  assert.match(addPrompt.value.messages[0].content.text, /context_pack/i);
  assert.match(addPrompt.value.messages[0].content.text, /proposal_create_note/i);
  assert.match(addPrompt.value.messages[0].content.text, /proposal_read/i);

  const capturePrompt = getMcpPrompt(frameworkRoot, "capture");
  assert.equal(capturePrompt.ok, true);
  assert.match(capturePrompt.value.messages[0].content.text, /place-first/i);
  assert.match(capturePrompt.value.messages[0].content.text, /daily note/i);
  assert.match(capturePrompt.value.messages[0].content.text, /placement debt/i);
  assert.match(capturePrompt.value.messages[0].content.text, /proposal_create_note/i);

  const noteAddSkill = readText(path.join(root, ".codex", "skills", "note-add", "SKILL.md"));
  assert.match(noteAddSkill, /context_pack/i);
  assert.match(noteAddSkill, /proposal_create_note/i);
  assert.match(noteAddSkill, /MCP server is unavailable/i);
  assert.match(noteAddSkill, /manual or script workflow/i);

  const dailyCaptureSkill = readText(path.join(root, ".codex", "skills", "daily-capture", "SKILL.md"));
  assert.match(dailyCaptureSkill, /place-first/i);
  assert.match(dailyCaptureSkill, /explicit daily-note append/i);
  assert.match(dailyCaptureSkill, /placement debt/i);
  assert.match(dailyCaptureSkill, /MCP server is unavailable/i);
  assert.match(dailyCaptureSkill, /proposal_create_note/i);

  const captureLauncher = readText(path.join(root, "global-skills", "dreamers-note-capture", "SKILL.md"));
  assert.match(captureLauncher, /place-first/i);
  assert.match(captureLauncher, /explicit daily-note append/i);
});
