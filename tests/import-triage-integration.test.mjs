import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import {
  buildFixtureIndex as buildSharedFixtureIndex,
  git,
  loadBuiltPackage,
  makeFrameworkRoot as makeSharedFrameworkRoot,
  projectRoot,
  readText,
  tmpdir,
  writeBinary,
  writeText,
} from "./helpers/project-fixtures.mjs";

const require = createRequire(import.meta.url);
const root = projectRoot;
const Database = require("better-sqlite3");
const IMPORT_APPROVED_TAGS = ["ai", "search", "pkm", "notes", "review"];

function loadPackage() {
  return loadBuiltPackage();
}

function makeImportFrameworkRoot(vaultPath) {
  return makeSharedFrameworkRoot(vaultPath, {
    tempPrefix: "dreamers-note-import-triage-framework",
    approvedTags: IMPORT_APPROVED_TAGS,
  });
}

function makeWorkflowFixture() {
  const vault = tmpdir("dreamers-note-import-triage-vault");
  writeText(
    path.join(vault, "01-projects", "ai", "obsidian", "retrieval-core.md"),
    [
      "---",
      "tags: [ai, notes]",
      "---",
      "# Retrieval Core",
      "",
      "Project-specific retrieval implementation details live here.",
      "",
      "## Intake",
      "Imported workflow notes that are still implementation-specific belong here.",
      "",
    ].join("\n"),
  );
  writeText(
    path.join(vault, "02-knowledge", "ai", "search", "retrieval-notes.md"),
    [
      "---",
      "tags: [ai, search]",
      "---",
      "# Retrieval Notes",
      "",
      "Durable search knowledge and triage learnings live here.",
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
      "- Inbox capture for later triage.",
      "",
    ].join("\n"),
  );
  writeText(
    path.join(vault, "07-system", "secrets", "token.md"),
    "PLAN07-SECRET-CANARY must never appear in import or triage proposals.\n",
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

function buildImportIndex(frameworkRoot, vaultPath) {
  return buildSharedFixtureIndex(frameworkRoot, vaultPath, {
    approvedTags: IMPORT_APPROVED_TAGS,
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

function chunkRowFor(databasePath, relativePath) {
  return readOne(
    databasePath,
    "select chunk_id, heading_path, text from chunks where relative_path = ? order by ordinal limit 1",
    relativePath,
  );
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

function proposalRead(frameworkRoot, proposalId) {
  return unwrapToolResult(
    callTool(frameworkRoot, "proposal_read", { proposalId }),
  );
}

test("inspectImportSource requires an explicit safe text path and rejects private, binary, unreadable, and oversized files", () => {
  const vault = makeWorkflowFixture();
  const frameworkRoot = makeImportFrameworkRoot(vault);
  const externalRoot = tmpdir("dreamers-note-import-sources");
  const safePath = path.join(externalRoot, "research", "retrieval-import.md");
  const binaryPath = path.join(externalRoot, "research", "image.bin");
  const unreadablePath = path.join(externalRoot, "research", "locked.txt");
  const hugePath = path.join(externalRoot, "research", "huge.txt");
  const symlinkPath = path.join(externalRoot, "research", "safe-link.md");
  const externalPrivatePath = path.join(externalRoot, "07-system", "secrets", "token.md");
  writeText(safePath, "# Retrieval Import\n\nLocal-first retrieval imports should stay proposal-first.\n");
  writeBinary(binaryPath, [0x00, 0x01, 0x02, 0x03]);
  writeText(unreadablePath, "hidden");
  fs.chmodSync(unreadablePath, 0o000);
  writeText(hugePath, "A".repeat(4097));
  writeText(externalPrivatePath, "# External Secret\n\nThis private-looking external path must stay rejected.\n");
  fs.symlinkSync(safePath, symlinkPath);

  const { inspectImportSource } = loadPackage();
  const sourcePolicy = {
    vaultPath: vault,
    privateGlobs: ["07-system/secrets/**"],
  };

  const missing = inspectImportSource({
    rootDir: frameworkRoot,
    ...sourcePolicy,
    inputPath: "",
    explicitPathProvided: false,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "import-source-explicit-path-required");

  const safe = inspectImportSource({
    rootDir: frameworkRoot,
    ...sourcePolicy,
    inputPath: safePath,
    explicitPathProvided: true,
    maxBytes: 4096,
  });
  assert.equal(safe.ok, true, JSON.stringify(safe.error));
  assert.equal(safe.value.absolutePath, safePath);
  assert.equal(safe.value.hash.length, 64);
  assert.match(safe.value.preview, /proposal-first/i);

  const privateSource = inspectImportSource({
    rootDir: frameworkRoot,
    ...sourcePolicy,
    inputPath: path.join(vault, "07-system", "secrets", "token.md"),
    explicitPathProvided: true,
  });
  assert.equal(privateSource.ok, false);
  assert.equal(privateSource.error.code, "private-path");

  const externalPrivateSource = inspectImportSource({
    rootDir: frameworkRoot,
    ...sourcePolicy,
    inputPath: externalPrivatePath,
    explicitPathProvided: true,
  });
  assert.equal(externalPrivateSource.ok, false);
  assert.equal(externalPrivateSource.error.code, "private-path");

  const binary = inspectImportSource({
    rootDir: frameworkRoot,
    ...sourcePolicy,
    inputPath: binaryPath,
    explicitPathProvided: true,
  });
  assert.equal(binary.ok, false);
  assert.equal(binary.error.code, "import-source-binary");

  const unreadable = inspectImportSource({
    rootDir: frameworkRoot,
    ...sourcePolicy,
    inputPath: unreadablePath,
    explicitPathProvided: true,
  });
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.error.code, "import-source-unreadable");

  const tooLarge = inspectImportSource({
    rootDir: frameworkRoot,
    ...sourcePolicy,
    inputPath: hugePath,
    explicitPathProvided: true,
    maxBytes: 4096,
  });
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.error.code, "import-source-too-large");

  const symlink = inspectImportSource({
    rootDir: frameworkRoot,
    ...sourcePolicy,
    inputPath: symlinkPath,
    explicitPathProvided: true,
  });
  assert.equal(symlink.ok, false);
  assert.equal(symlink.error.code, "import-source-symlink");

  fs.chmodSync(unreadablePath, 0o600);
});

test("inspectImportSource accepts explicit vault policy instead of loading global config internally", () => {
  const { inspectImportSource } = loadPackage();
  const vault = tmpdir("dreamers-note-import-explicit-policy-vault");
  const configlessRoot = tmpdir("dreamers-note-import-no-config");
  const externalRoot = tmpdir("dreamers-note-import-explicit-policy-source");
  const sourcePath = path.join(externalRoot, "research", "standalone-import.md");
  const privateVaultSource = path.join(vault, "07-system", "secrets", "token.md");
  writeText(sourcePath, "# Standalone Import\n\nThis source is not under the configured project root.\n");
  writeText(privateVaultSource, "# Secret\n\nThis private path must stay rejected.\n");

  const safe = inspectImportSource({
    rootDir: configlessRoot,
    vaultPath: vault,
    privateGlobs: ["07-system/secrets/**"],
    inputPath: sourcePath,
    explicitPathProvided: true,
    maxBytes: 4096,
  });
  assert.equal(safe.ok, true, JSON.stringify(safe.error ?? safe));
  assert.equal(safe.value.absolutePath, sourcePath);

  const privateSource = inspectImportSource({
    rootDir: configlessRoot,
    vaultPath: vault,
    privateGlobs: ["07-system/secrets/**"],
    inputPath: privateVaultSource,
    explicitPathProvided: true,
    maxBytes: 4096,
  });
  assert.equal(privateSource.ok, false);
  assert.equal(privateSource.error.code, "private-path");
});

test("proposal_create_note preserves explicit external import evidence without mutating the original source file", () => {
  const vault = makeWorkflowFixture();
  const frameworkRoot = makeImportFrameworkRoot(vault);
  buildImportIndex(frameworkRoot, vault);
  const externalRoot = tmpdir("dreamers-note-import-source");
  const sourcePath = path.join(externalRoot, "retrieval-import.md");
  writeText(
    sourcePath,
    "# Retrieval Import\n\nThis external source should become durable retrieval knowledge.\n",
  );
  const destinationPath = "02-knowledge/ai/search/retrieval-import.md";

  const pack = unwrapToolResult(
    callTool(frameworkRoot, "context_pack", {
      query: "Retrieval Notes durable search knowledge",
      profile: "import",
      limit: 3,
    }),
  );
  assert.equal(pack.profile, "import");
  assert.equal(pack.retrievalSignal.state, "strong");
  assert.equal(pack.candidateDestinations.length > 0, true);

  const created = unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_create_note",
      {
        operation: "note-import",
        path: destinationPath,
        mode: "create",
        body: "# Retrieval Import\n\nThis external source should become durable retrieval knowledge.\n",
        bundleId: "import-bundle",
        contextPackId: "ctx-import-01",
        sourceChunkIds: [],
        candidatePaths: [destinationPath],
        approvedTags: ["ai", "search"],
        proposedTagGaps: ["local-first-import"],
        rationale: "Import the external retrieval note into durable search knowledge while preserving the source file.",
        evidence: [
          {
            path: sourcePath,
            excerpt: "This external source should become durable retrieval knowledge.",
          },
        ],
        placementScorecard: {
          subjectOwnership: "Durable search knowledge",
          insertionAnchor: "New note",
          namingFit: "retrieval-import",
          tagFit: ["ai", "search"],
          linkFit: ["[[02-knowledge/ai/search/retrieval-notes]]"],
          ambiguity: "low",
          confidence: 0.88,
          unresolvedQuestions: [],
        },
      },
      { writeEnabled: true },
    ),
  );

  const read = proposalRead(frameworkRoot, created.proposalId);
  assert.equal(read.proposal.sourcePaths.includes(sourcePath), true);
  assert.equal(read.proposal.evidence[0].path, sourcePath);
  assert.equal(read.proposal.evidence[0].provenance, "external-file");
  assert.match(read.proposal.evidence[0].excerpt, /durable retrieval knowledge/i);
  assert.equal(read.validation.state, "current");
  assert.equal(readText(sourcePath).includes("external source"), true);
});

test("context_pack import suppresses weak-only candidates and returns source-note fallbacks", () => {
  const vault = makeWorkflowFixture();
  const frameworkRoot = makeImportFrameworkRoot(vault);
  buildImportIndex(frameworkRoot, vault);

  const pack = unwrapToolResult(
    callTool(frameworkRoot, "context_pack", {
      query: "latest ai import",
      profile: "import",
      limit: 4,
    }),
  );

  assert.equal(pack.profile, "import");
  assert.equal(pack.retrievalSignal.state, "low-signal");
  assert.equal(pack.candidateDestinations.length, 0);
  assert.equal(pack.fallbackSuggestions.some((item) => item.kind === "source-note"), true);
  assert.equal(pack.fallbackSuggestions.some((item) => item.kind === "source-note" && item.defaultChoice === true), true);
  assert.equal(pack.fallbackSuggestions.some((item) => item.kind === "knowledge-note"), true);
  assert.equal(pack.fallbackSuggestions.some((item) => item.kind === "directory-index"), true);
  assert.equal(pack.actions.some((item) => /directory homepage.*Notes/i.test(item)), true);
  assert.equal(pack.actions.some((item) => /fallback suggestions/i.test(item)), true);
  assert.equal(pack.actions.some((item) => /default choice/i.test(item)), true);
});

test("separate external source delete proposals enforce hash validation and delete only after approval", () => {
  const vault = makeWorkflowFixture();
  const frameworkRoot = makeImportFrameworkRoot(vault);
  buildImportIndex(frameworkRoot, vault);
  const externalRoot = tmpdir("dreamers-note-import-delete");
  const sourcePath = path.join(externalRoot, "retrieval-import.txt");
  writeText(sourcePath, "delete me only after a separate approved proposal\n");

  const created = unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_create",
      {
        operation: "import-source-delete",
        bundleId: "import-bundle",
        rationale: "The user explicitly requested deletion of the imported source file after review.",
        sourceChunkIds: [],
        candidatePaths: [],
        approvedTags: [],
        proposedTagGaps: [],
        pathActions: [
          {
            type: "delete-file",
            scope: "external",
            path: sourcePath,
          },
        ],
      },
      { writeEnabled: true },
    ),
  );

  const read = proposalRead(frameworkRoot, created.proposalId);
  assert.equal(read.proposal.targetPaths.length, 0);
  assert.equal(read.proposal.pathActions[0].type, "delete-file");
  assert.equal(read.proposal.pathActions[0].scope, "external");
  assert.equal(fs.existsSync(sourcePath), true);

  const auth = unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_authorize",
      { proposalId: created.proposalId },
      { writeEnabled: true },
    ),
  );
  const applied = unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_apply",
      {
        proposalId: created.proposalId,
        authorizationId: auth.authorizationId,
      },
      { writeEnabled: true },
    ),
  );
  assert.equal(fs.existsSync(sourcePath), false);
  assert.deepEqual(applied.deletedExternalPaths, [sourcePath]);

  const driftSourcePath = path.join(externalRoot, "retrieval-import-drift.txt");
  writeText(driftSourcePath, "version one\n");
  const driftCreated = unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_create",
      {
        operation: "import-source-delete",
        rationale: "Separate delete proposal after import.",
        sourceChunkIds: [],
        candidatePaths: [],
        approvedTags: [],
        proposedTagGaps: [],
        pathActions: [
          {
            type: "delete-file",
            scope: "external",
            path: driftSourcePath,
          },
        ],
      },
      { writeEnabled: true },
    ),
  );
  const driftAuth = unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_authorize",
      { proposalId: driftCreated.proposalId },
      { writeEnabled: true },
    ),
  );
  writeText(driftSourcePath, "version two\n");
  const driftError = unwrapToolError(
    callTool(
      frameworkRoot,
      "proposal_apply",
      {
        proposalId: driftCreated.proposalId,
        authorizationId: driftAuth.authorizationId,
      },
      { writeEnabled: true },
    ),
  );
  assert.equal(driftError.code, "proposal-external-source-changed");
});

test("triage bundles keep per-proposal dependencies and block archive moves until extraction proposals apply", () => {
  const vault = makeWorkflowFixture();
  const frameworkRoot = makeImportFrameworkRoot(vault);
  const { runtime } = buildImportIndex(frameworkRoot, vault);
  const dailyPath = "00-inbox/daily-notes/2026-06-13.md";
  const archivePath = "99-archive/daily-notes/2026-06-13.md";
  const extractionPath = "02-knowledge/ai/search/daily-triage-retrieval.md";
  const dailyChunk = chunkRowFor(runtime.databasePath, dailyPath);

  const extract = unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_create",
      {
        operation: "daily-triage-extract",
        bundleId: "triage-bundle-01",
        contextPackId: "ctx-triage-01",
        sourceChunkIds: [dailyChunk.chunk_id],
        candidatePaths: [extractionPath],
        approvedTags: ["ai", "search"],
        proposedTagGaps: [],
        rationale: "Extract durable retrieval knowledge from the inbox daily note.",
        targets: [
          {
            path: extractionPath,
            mode: "create",
            body: "# Daily Triage Retrieval\n\nExtracted durable note from the daily inbox.\n\nBacklink: [[00-inbox/daily-notes/2026-06-13]]\n",
          },
        ],
      },
      { writeEnabled: true },
    ),
  );

  const archive = unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_create",
      {
        operation: "daily-triage-archive",
        bundleId: "triage-bundle-01",
        sourceChunkIds: [],
        candidatePaths: [dailyPath, archivePath],
        approvedTags: [],
        proposedTagGaps: [],
        dependencies: [extract.proposalId],
        rationale: "Archive the processed daily note only after extracted material is already durable and reviewable.",
        pathActions: [
          {
            type: "move",
            scope: "vault",
            path: dailyPath,
            destinationPath: archivePath,
          },
        ],
      },
      { writeEnabled: true },
    ),
  );

  const listed = unwrapToolResult(callTool(frameworkRoot, "proposal_list", {}));
  const bundled = listed.items.filter((item) => item.bundleId === "triage-bundle-01");
  assert.equal(bundled.length, 2);

  const archiveRead = proposalRead(frameworkRoot, archive.proposalId);
  assert.equal(archiveRead.proposal.dependencies[0], extract.proposalId);
  assert.equal(archiveRead.proposal.pathActions[0].destinationPath, archivePath);
  assert.equal(archiveRead.validation.state, "blocked");
  assert.equal(
    archiveRead.validation.blockers.some((blocker) => blocker.code === "proposal-dependency-pending"),
    true,
  );

  const archiveAuthError = unwrapToolError(
    callTool(
      frameworkRoot,
      "proposal_authorize",
      { proposalId: archive.proposalId },
      { writeEnabled: true },
    ),
  );
  assert.equal(archiveAuthError.code, "proposal-not-current");

  const extractAuth = unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_authorize",
      { proposalId: extract.proposalId },
      { writeEnabled: true },
    ),
  );
  unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_apply",
      {
        proposalId: extract.proposalId,
        authorizationId: extractAuth.authorizationId,
      },
      { writeEnabled: true },
    ),
  );

  const archiveAuth = unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_authorize",
      { proposalId: archive.proposalId },
      { writeEnabled: true },
    ),
  );
  unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_apply",
      {
        proposalId: archive.proposalId,
        authorizationId: archiveAuth.authorizationId,
      },
      { writeEnabled: true },
    ),
  );

  assert.equal(fs.existsSync(path.join(vault, dailyPath)), false);
  assert.equal(fs.existsSync(path.join(vault, archivePath)), true);
  assert.equal(fs.existsSync(path.join(vault, extractionPath)), true);
});

test("bundle validation stays blocked until every dependency proposal is applied", () => {
  const vault = makeWorkflowFixture();
  const frameworkRoot = makeImportFrameworkRoot(vault);
  const { runtime } = buildImportIndex(frameworkRoot, vault);
  const dailyPath = "00-inbox/daily-notes/2026-06-13.md";
  const archivePath = "99-archive/daily-notes/2026-06-13.md";
  const firstPath = "02-knowledge/ai/search/daily-triage-first.md";
  const secondPath = "02-knowledge/ai/search/daily-triage-second.md";
  const dailyChunk = chunkRowFor(runtime.databasePath, dailyPath);

  const first = unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_create",
      {
        operation: "daily-triage-extract",
        bundleId: "triage-bundle-02",
        sourceChunkIds: [dailyChunk.chunk_id],
        candidatePaths: [firstPath],
        approvedTags: ["ai", "search"],
        proposedTagGaps: [],
        rationale: "First durable extraction from the inbox daily note.",
        targets: [
          {
            path: firstPath,
            mode: "create",
            body: "# Daily Triage First\n\nFirst extracted durable note.\n",
          },
        ],
      },
      { writeEnabled: true },
    ),
  );
  const second = unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_create",
      {
        operation: "daily-triage-extract",
        bundleId: "triage-bundle-02",
        sourceChunkIds: [dailyChunk.chunk_id],
        candidatePaths: [secondPath],
        approvedTags: ["ai", "search"],
        proposedTagGaps: [],
        rationale: "Second durable extraction from the inbox daily note.",
        targets: [
          {
            path: secondPath,
            mode: "create",
            body: "# Daily Triage Second\n\nSecond extracted durable note.\n",
          },
        ],
      },
      { writeEnabled: true },
    ),
  );
  const archive = unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_create",
      {
        operation: "daily-triage-archive",
        bundleId: "triage-bundle-02",
        sourceChunkIds: [],
        candidatePaths: [dailyPath, archivePath],
        approvedTags: [],
        proposedTagGaps: [],
        dependencies: [first.proposalId, second.proposalId],
        rationale: "Archive only after every extraction in the bundle has been applied.",
        pathActions: [
          {
            type: "move",
            scope: "vault",
            path: dailyPath,
            destinationPath: archivePath,
          },
        ],
      },
      { writeEnabled: true },
    ),
  );

  const firstAuth = unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_authorize",
      { proposalId: first.proposalId },
      { writeEnabled: true },
    ),
  );
  unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_apply",
      {
        proposalId: first.proposalId,
        authorizationId: firstAuth.authorizationId,
      },
      { writeEnabled: true },
    ),
  );

  const archiveRead = proposalRead(frameworkRoot, archive.proposalId);
  assert.equal(archiveRead.validation.state, "blocked");
  assert.equal(
    archiveRead.validation.blockers.some(
      (blocker) => blocker.code === "proposal-dependency-pending" && blocker.message.includes(second.proposalId),
    ),
    true,
  );
});

test("import and triage prompts plus skill contracts describe MCP-backed proposal-first workflows and fallbacks", () => {
  const vault = makeWorkflowFixture();
  const frameworkRoot = makeImportFrameworkRoot(vault);
  buildImportIndex(frameworkRoot, vault);
  const { getMcpPrompt } = loadPackage();

  const importPrompt = getMcpPrompt(frameworkRoot, "import");
  assert.equal(importPrompt.ok, true);
  assert.match(importPrompt.value.messages[0].content.text, /workflow_ready/i);
  assert.match(importPrompt.value.messages[0].content.text, /context_pack/i);
  assert.match(importPrompt.value.messages[0].content.text, /workflow_policy/i);
  assert.match(importPrompt.value.messages[0].content.text, /proposal_create_note/i);
  assert.match(importPrompt.value.messages[0].content.text, /proposal_read/i);
  assert.match(importPrompt.value.messages[0].content.text, /delete proposal/i);
  assert.match(importPrompt.value.messages[0].content.text, /fallbackSuggestions/i);
  assert.match(importPrompt.value.messages[0].content.text, /default choice/i);
  assert.match(importPrompt.value.messages[0].content.text, /dreamers-note:\/\/workflow-policy\/import/i);
  assert.match(importPrompt.value.messages[0].content.text, /rationale/i);

  const triagePrompt = getMcpPrompt(frameworkRoot, "triage");
  assert.equal(triagePrompt.ok, true);
  assert.match(triagePrompt.value.messages[0].content.text, /workflow_ready/i);
  assert.match(triagePrompt.value.messages[0].content.text, /context_pack/i);
  assert.match(triagePrompt.value.messages[0].content.text, /workflow_policy/i);
  assert.match(triagePrompt.value.messages[0].content.text, /bundle/i);
  assert.match(triagePrompt.value.messages[0].content.text, /proposal_create_note/i);
  assert.match(triagePrompt.value.messages[0].content.text, /proposal_create/i);
  assert.match(triagePrompt.value.messages[0].content.text, /dreamers-note:\/\/workflow-policy\/triage/i);

  const noteImportSkill = readText(path.join(root, ".codex", "skills", "note-import", "SKILL.md"));
  assert.match(noteImportSkill, /workflow_ready/i);
  assert.match(noteImportSkill, /context_pack/i);
  assert.match(noteImportSkill, /workflow_policy/i);
  assert.match(noteImportSkill, /proposal_create_note/i);
  assert.match(noteImportSkill, /proposal_read/i);
  assert.match(noteImportSkill, /fallbackSuggestions/i);
  assert.match(noteImportSkill, /default choice/i);
  assert.match(noteImportSkill, /dreamers-note:\/\/workflow-policy\/import/i);
  assert.match(noteImportSkill, /not proposal evidence/i);
  assert.match(noteImportSkill, /separate proposal/i);
  assert.match(noteImportSkill, /MCP server is unavailable/i);
  assert.doesNotMatch(noteImportSkill, /docs\/conventions\.md/i);

  const importLauncher = readText(path.join(root, "global-skills", "dreamers-note-import", "SKILL.md"));
  assert.match(importLauncher, /target_skill: note-import/i);
  assert.match(importLauncher, /workflow_id: import/i);
  assert.match(importLauncher, /payload_mapping:/i);
  assert.match(importLauncher, /reporting_fields:/i);
  assert.doesNotMatch(importLauncher, /workflow_ready/i);
  assert.doesNotMatch(importLauncher, /context_pack/i);

  const dailyTriageSkill = readText(path.join(root, ".codex", "skills", "daily-triage", "SKILL.md"));
  assert.match(dailyTriageSkill, /workflow_ready/i);
  assert.match(dailyTriageSkill, /context_pack/i);
  assert.match(dailyTriageSkill, /workflow_policy/i);
  assert.match(dailyTriageSkill, /proposal_create_note/i);
  assert.match(dailyTriageSkill, /proposal_create/i);
  assert.match(dailyTriageSkill, /bundle/i);
  assert.match(dailyTriageSkill, /dreamers-note:\/\/workflow-policy\/triage/i);
  assert.match(dailyTriageSkill, /MCP server is unavailable/i);

  const readme = readText(path.join(root, "README.md"));
  assert.match(readme, /Workflow Guidance/i);
  assert.match(readme, /AGENTS\.md/i);
  assert.match(readme, /workflow_policy/i);
  assert.doesNotMatch(readme, /Import And Daily Triage/i);
});
