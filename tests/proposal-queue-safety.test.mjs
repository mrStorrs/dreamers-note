import assert from "node:assert/strict";
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
  runtimePaths,
  tmpdir,
  writeRuntimeConfig,
  writeText,
} from "./helpers/project-fixtures.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const PROPOSAL_APPROVED_TAGS = ["ai", "obsidian", "local-first", "search", "pkm", "health"];
const DIRECTORY_INDEX_POLICY = {
  classifiedNoteRoots: ["01-projects", "02-knowledge", "04-people"],
  disallowedRoots: ["02-areas", "03-knowledge"],
  classifiedNotePattern: "<root>/<main>/<sub>/<note-name>.md",
  directoryIndex: {
    filenamePattern: "_<folder-name>.md",
    protectedSection: "Notes",
  },
};

function loadPackage() {
  return loadBuiltPackage();
}

function loadProposalQueueModule() {
  return require(path.join(distDir, "proposal-queue.js"));
}

function seedCanonicalDirectoryIndexes(vault) {
  const { planDirectoryIndexRepairs } = require(path.join(distDir, "directory-index.js"));
  const planned = planDirectoryIndexRepairs(
    {
      vaultPath: vault,
      privateGlobs: ["07-system/secrets/**"],
      conventionPolicy: DIRECTORY_INDEX_POLICY,
    },
    {
      paths: [
        "01-projects/ai/_ai.md",
        "01-projects/ai/obsidian/_obsidian.md",
        "02-knowledge/ai/_ai.md",
        "02-knowledge/ai/pkm/_pkm.md",
        "02-knowledge/ai/search/_search.md",
        "04-people/health/_health.md",
        "04-people/health/checkups/_checkups.md",
      ],
    },
  );
  assert.equal(planned.ok, true, JSON.stringify(planned.error));
  for (const target of planned.value.targets) {
    writeText(path.join(vault, target.path), target.body);
  }
}

function rewriteRuntimeConfig(frameworkRoot, overrides = {}) {
  writeRuntimeConfig(frameworkRoot, {
    data_dir: ".dreamers-note-runtime",
    private_globs: ["07-system/secrets/**"],
    ...overrides,
  });
}

function makeProposalFrameworkRoot(vaultPath) {
  return makeSharedFrameworkRoot(vaultPath, {
    tempPrefix: "dreamers-note-proposal-framework",
    approvedTags: PROPOSAL_APPROVED_TAGS,
  });
}

function makeProposalFixture(options = {}) {
  const vault = tmpdir("dreamers-note-proposal-vault");
  writeText(
    path.join(vault, "01-projects", "ai", "obsidian", "retrieval-core.md"),
    [
      "---",
      "tags: [ai, obsidian]",
      "---",
      "# Retrieval Core",
      "",
      "This note currently holds the durable project retrieval guidance.",
      "",
      "## Queue",
      "Pending MCP proposal queue work lands here once approved.",
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
      "Use cited excerpts, preserve proposal-first edits, and keep the queue safe.",
      "",
      "## Evidence",
      "Durable MCP proposal queue details belong in the project note after approval.",
      "",
    ].join("\n"),
  );
  writeText(
    path.join(vault, "02-knowledge", "ai", "pkm", "second-brain-setup.md"),
    "# Second Brain Setup\n\nA durable note about personal knowledge systems.\n",
  );
  writeText(
    path.join(vault, "04-people", "health", "checkups", "health-context.md"),
    "# Health Context\n\nHealth notes stay searchable in this local system.\n",
  );
  writeText(
    path.join(vault, "07-system", "secrets", "token.md"),
    "PLAN05-SECRET-CANARY must never appear in proposals, diffs, or logs\n",
  );
  if (options.seedDirectoryIndexes !== false) {
    seedCanonicalDirectoryIndexes(vault);
  }
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

function buildProposalIndex(frameworkRoot, vaultPath) {
  return buildSharedFixtureIndex(frameworkRoot, vaultPath, {
    approvedTags: PROPOSAL_APPROVED_TAGS,
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

function writeDatabase(databasePath, callback) {
  const db = new Database(databasePath);
  try {
    return callback(db);
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

function proposalArgs(overrides = {}) {
  return {
    operation: "note-update",
    bundleId: "bundle-alpha",
    contextPackId: "ctx-01",
    sourceChunkIds: [],
    candidatePaths: [],
    approvedTags: ["ai", "obsidian"],
    proposedTagGaps: ["mcp"],
    unresolvedQuestions: [],
    validationBlockers: [],
    dependencies: [],
    rationale: "Merge cited proposal queue guidance into the durable project note.",
    placementScorecard: {
      destinationFit: 0.94,
      duplicateRisk: 0.08,
      confidence: 0.9,
    },
    evidence: [],
    targets: [],
    ...overrides,
  };
}

function createProposal(frameworkRoot, args) {
  return unwrapToolResult(callTool(frameworkRoot, "proposal_create", args, { writeEnabled: true }));
}

function authorizeProposal(frameworkRoot, proposalId) {
  return unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_authorize",
      {
        proposalId,
      },
      { writeEnabled: true },
    ),
  );
}

function applyProposal(frameworkRoot, proposalId, authorizationId) {
  return callTool(
    frameworkRoot,
    "proposal_apply",
    {
      proposalId,
      authorizationId,
    },
    { writeEnabled: true },
  );
}

test("proposal_create stores safe queue records, preserves bundle lineage, and does not mutate vault bytes", () => {
  const vault = makeProposalFixture();
  const frameworkRoot = makeProposalFrameworkRoot(vault);
  const { runtime } = buildProposalIndex(frameworkRoot, vault);
  const sourcePath = "02-knowledge/ai/search/retrieval-notes.md";
  const targetPath = "01-projects/ai/obsidian/retrieval-core.md";
  const newPath = "02-knowledge/ai/search/proposal-queue-safety.md";
  const sourceChunk = chunkRowFor(runtime.databasePath, sourcePath);
  const beforeTarget = readText(path.join(vault, targetPath));

  const first = createProposal(
    frameworkRoot,
    proposalArgs({
      sourceChunkIds: [sourceChunk.chunk_id],
      candidatePaths: [targetPath, sourcePath],
      evidence: [
        {
          path: sourcePath,
          chunkId: sourceChunk.chunk_id,
          headingPath: sourceChunk.heading_path,
          excerpt: sourceChunk.text,
        },
      ],
      targets: [
        {
          path: targetPath,
          mode: "replace",
          body: `${beforeTarget}\nApproved queue changes will cite ${sourcePath}.\n`,
        },
      ],
    }),
  );

  const second = createProposal(
    frameworkRoot,
    proposalArgs({
      operation: "note-create",
      sourceChunkIds: [sourceChunk.chunk_id],
      candidatePaths: [newPath, sourcePath],
      dependencies: [first.proposalId],
      evidence: [
        {
          path: sourcePath,
          chunkId: sourceChunk.chunk_id,
          headingPath: sourceChunk.heading_path,
          excerpt: sourceChunk.text,
        },
      ],
      targets: [
        {
          path: newPath,
          mode: "create",
          body: "# Proposal Queue Safety\n\nDurable MCP proposal queue guidance.\n",
        },
      ],
    }),
  );

  assert.equal(readText(path.join(vault, targetPath)), beforeTarget);
  assert.equal(fs.existsSync(path.join(vault, newPath)), false);

  const list = unwrapToolResult(callTool(frameworkRoot, "proposal_list", {}));
  assert.equal(list.items.length, 2);
  assert.equal(list.items.every((item) => item.bundleId === "bundle-alpha"), true);
  assert.equal(list.items.every((item) => !Object.hasOwn(item, "targets")), true);
  assert.equal(list.items.every((item) => !Object.hasOwn(item, "evidence")), true);

  const firstRead = unwrapToolResult(
    callTool(frameworkRoot, "proposal_read", {
      proposalId: first.proposalId,
    }),
  );
  assert.equal(firstRead.proposal.targets[0].body.includes("Approved queue changes"), true);
  assert.equal(Object.hasOwn(firstRead.proposal.targets[0], "editSpec"), false);
  assert.equal(firstRead.validation.diffHash, firstRead.proposal.diffHash);
  assert.match(firstRead.diffPreview[0].preview, /Approved queue changes/);
  const firstAuth = authorizeProposal(frameworkRoot, first.proposalId);
  assert.equal(firstAuth.diffHash, firstRead.proposal.diffHash);
  assert.equal(firstAuth.revision, firstRead.proposal.revision);

  const read = unwrapToolResult(
    callTool(frameworkRoot, "proposal_read", {
      proposalId: second.proposalId,
    }),
  );
  assert.equal(read.proposal.bundleId, "bundle-alpha");
  assert.deepEqual(read.proposal.dependencies, [first.proposalId]);
  assert.deepEqual(read.proposal.targetPaths, [
    "02-knowledge/ai/search/_search.md",
    newPath,
  ]);
  assert.equal(read.proposal.evidence[0].excerpt.length <= 240, true);
  assert.equal(read.proposal.lineage.sourceChunkIds.includes(sourceChunk.chunk_id), true);
  assert.equal(typeof read.proposal.lineage.indexGeneration, "string");
  assert.equal(read.proposal.targets.find((target) => target.path === newPath).body.includes("Proposal Queue Safety"), true);
});

test("proposal_read preserves diff hash and suppresses target previews after drift", () => {
  const vault = makeProposalFixture();
  const frameworkRoot = makeProposalFrameworkRoot(vault);
  const { runtime } = buildProposalIndex(frameworkRoot, vault);
  const sourcePath = "02-knowledge/ai/search/retrieval-notes.md";
  const targetPath = "01-projects/ai/obsidian/retrieval-core.md";
  const sourceChunk = chunkRowFor(runtime.databasePath, sourcePath);
  const beforeTarget = readText(path.join(vault, targetPath));

  const created = createProposal(
    frameworkRoot,
    proposalArgs({
      sourceChunkIds: [sourceChunk.chunk_id],
      candidatePaths: [targetPath],
      evidence: [
        {
          path: sourcePath,
          chunkId: sourceChunk.chunk_id,
          headingPath: sourceChunk.heading_path,
          excerpt: sourceChunk.text,
        },
      ],
      targets: [
        {
          path: targetPath,
          mode: "replace",
          body: `${beforeTarget}\nDirect body preview should be stable until drift.\n`,
        },
      ],
    }),
  );
  const initialRead = unwrapToolResult(
    callTool(frameworkRoot, "proposal_read", {
      proposalId: created.proposalId,
    }),
  );
  assert.equal(initialRead.validation.diffHash, initialRead.proposal.diffHash);
  assert.match(initialRead.diffPreview[0].preview, /Direct body preview/);

  writeText(path.join(vault, targetPath), `${beforeTarget}\nLocal change after proposal creation.\n`);

  const driftedRead = unwrapToolResult(
    callTool(frameworkRoot, "proposal_read", {
      proposalId: created.proposalId,
    }),
  );
  assert.equal(driftedRead.validation.diffHash, initialRead.proposal.diffHash);
  assert.match(driftedRead.diffPreview[0].preview, /target changed after proposal creation/);
  assert.equal(
    driftedRead.validation.blockers.some((item) => item.code === "proposal-target-changed"),
    true,
  );
});

test("proposal_create refuses when write-disabled and refreshes stale source lineage before storing", () => {
  const vault = makeProposalFixture();
  const frameworkRoot = makeProposalFrameworkRoot(vault);
  const { runtime } = buildProposalIndex(frameworkRoot, vault);
  const sourcePath = "02-knowledge/ai/search/retrieval-notes.md";
  const targetPath = "01-projects/ai/obsidian/retrieval-core.md";
  const sourceChunk = chunkRowFor(runtime.databasePath, sourcePath);

  writeText(
    path.join(vault, sourcePath),
    [
      "# Retrieval Notes",
      "",
      "The source note changed after the index build and should force a refresh before proposal storage.",
      "",
    ].join("\n"),
  );

  const args = proposalArgs({
    sourceChunkIds: [sourceChunk.chunk_id],
    candidatePaths: [targetPath, sourcePath],
    evidence: [
      {
        path: sourcePath,
        chunkId: sourceChunk.chunk_id,
        headingPath: sourceChunk.heading_path,
        excerpt: sourceChunk.text,
      },
    ],
    targets: [
      {
        path: targetPath,
        mode: "replace",
        body: `${readText(path.join(vault, targetPath))}\nRefresh the source lineage before storing this proposal.\n`,
      },
    ],
  });

  const disabled = unwrapToolError(callTool(frameworkRoot, "proposal_create", args));
  assert.equal(disabled.code, "write-disabled");

  const created = createProposal(frameworkRoot, args);
  const read = unwrapToolResult(
    callTool(frameworkRoot, "proposal_read", {
      proposalId: created.proposalId,
    }),
  );
  const refreshedHash = loadPackage().fileHash(path.join(vault, sourcePath));
  assert.equal(read.proposal.lineage.sourceHashes[sourcePath], refreshedHash);
  assert.equal(read.validation.state, "current");
});

test("proposal_reject and refresh cleanup redact resolved or newly excluded proposal content", () => {
  const vault = makeProposalFixture();
  const frameworkRoot = makeProposalFrameworkRoot(vault);
  const { runtime } = buildProposalIndex(frameworkRoot, vault);
  const sourcePath = "02-knowledge/ai/search/retrieval-notes.md";
  const targetPath = "01-projects/ai/obsidian/retrieval-core.md";
  const sourceChunk = chunkRowFor(runtime.databasePath, sourcePath);

  const rejected = createProposal(
    frameworkRoot,
    proposalArgs({
      sourceChunkIds: [sourceChunk.chunk_id],
      candidatePaths: [targetPath],
      evidence: [
        {
          path: sourcePath,
          chunkId: sourceChunk.chunk_id,
          headingPath: sourceChunk.heading_path,
          excerpt: sourceChunk.text,
        },
      ],
      targets: [
        {
          path: targetPath,
          mode: "replace",
          body: `${readText(path.join(vault, targetPath))}\nPLAN05-REDACTION-CANARY rejected content should be redacted from runtime records.\n`,
        },
      ],
    }),
  );

  unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_reject",
      {
        proposalId: rejected.proposalId,
        reason: "duplicate destination after review",
      },
      { writeEnabled: true },
    ),
  );
  const rejectedRead = unwrapToolResult(
    callTool(frameworkRoot, "proposal_read", {
      proposalId: rejected.proposalId,
    }),
  );
  assert.equal(rejectedRead.proposal.targets[0].body, undefined);
  assert.equal(rejectedRead.proposal.evidence[0].excerpt, undefined);
  assert.match(rejectedRead.diffPreview[0].preview, /content has been redacted/);
  assert.doesNotMatch(JSON.stringify(rejectedRead.proposal), /PLAN05-REDACTION-CANARY/);

  const pending = createProposal(
    frameworkRoot,
    proposalArgs({
      bundleId: "bundle-beta",
      sourceChunkIds: [sourceChunk.chunk_id],
      candidatePaths: [targetPath, sourcePath],
      evidence: [
        {
          path: sourcePath,
          chunkId: sourceChunk.chunk_id,
          headingPath: sourceChunk.heading_path,
          excerpt: sourceChunk.text,
        },
      ],
      targets: [
        {
          path: targetPath,
          mode: "replace",
          body: `${readText(path.join(vault, targetPath))}\nPending evidence should be purged once the source becomes excluded.\n`,
        },
      ],
    }),
  );

  rewriteRuntimeConfig(frameworkRoot, {
    private_globs: ["07-system/secrets/**", "02-knowledge/ai/search/retrieval-notes.md"],
  });
  unwrapToolResult(callTool(frameworkRoot, "index_refresh", {}));

  const pendingRead = unwrapToolResult(
    callTool(frameworkRoot, "proposal_read", {
      proposalId: pending.proposalId,
    }),
  );
  assert.equal(pendingRead.proposal.evidence[0].excerpt, undefined);
  assert.equal(
    pendingRead.validation.blockers.some((item) => String(item.code || item).includes("source-excluded")),
    true,
  );
});

test("proposal_read expires pending proposals and redacts note-derived content", () => {
  const vault = makeProposalFixture();
  const frameworkRoot = makeProposalFrameworkRoot(vault);
  const { runtime } = buildProposalIndex(frameworkRoot, vault);
  const sourcePath = "02-knowledge/ai/search/retrieval-notes.md";
  const targetPath = "00-inbox/daily-notes/2026-06-16.md";
  const durablePath = "01-projects/ai/obsidian/retrieval-core.md";
  const sourceChunk = chunkRowFor(runtime.databasePath, sourcePath);
  const externalSource = path.join(tmpdir("dreamers-note-proposal-expiry-external"), "capture.md");
  const bodyCanary = "PLAN05-EXPIRED-BODY-CANARY";
  const excerptCanary = "PLAN05-EXPIRED-EXCERPT-CANARY";
  const placementCanary = "PLAN05-EXPIRED-PLACEMENT-CANARY";
  writeText(externalSource, "# Capture\n\nExternal source text for expiry cleanup.\n");

  const created = createProposal(
    frameworkRoot,
    proposalArgs({
      operation: "capture-fallback",
      bundleId: "bundle-expiry",
      sourceChunkIds: [sourceChunk.chunk_id],
      candidatePaths: [targetPath, durablePath],
      evidence: [
        {
          path: sourcePath,
          chunkId: sourceChunk.chunk_id,
          headingPath: sourceChunk.heading_path,
          excerpt: sourceChunk.text,
        },
        {
          path: externalSource,
          excerpt: excerptCanary,
          provenance: "external-file",
        },
      ],
      placementDebt: {
        originalText: placementCanary,
        ambiguityReason: "Multiple durable homes were plausible during capture.",
        reviewDueAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        candidateDestinations: [
          {
            path: durablePath,
            reason: "Durable project note candidate.",
          },
        ],
      },
      targets: [
        {
          path: targetPath,
          mode: "create",
          body: `# Daily Capture\n\n${bodyCanary}\n`,
        },
      ],
    }),
  );

  writeDatabase(runtime.databasePath, (db) => {
    db.prepare("update proposals set expires_at = ? where proposal_id = ?").run(
      "2000-01-01T00:00:00.000Z",
      created.proposalId,
    );
  });

  const read = unwrapToolResult(
    callTool(frameworkRoot, "proposal_read", {
      proposalId: created.proposalId,
    }),
  );
  const serialized = JSON.stringify(read);
  assert.equal(read.proposal.status, "expired");
  assert.equal(read.proposal.targets[0].body, undefined);
  assert.equal(read.proposal.evidence.every((item) => item.excerpt === undefined), true);
  assert.equal(read.proposal.placementDebt.originalText, undefined);
  assert.match(read.diffPreview[0].preview, /content has been redacted/);
  assert.doesNotMatch(serialized, new RegExp(bodyCanary));
  assert.doesNotMatch(serialized, new RegExp(excerptCanary));
  assert.doesNotMatch(serialized, new RegExp(placementCanary));
});

test("proposal_apply requires one-use authorization before any vault mutation", () => {
  const vault = makeProposalFixture();
  const frameworkRoot = makeProposalFrameworkRoot(vault);
  const { runtime } = buildProposalIndex(frameworkRoot, vault);
  const sourcePath = "02-knowledge/ai/search/retrieval-notes.md";
  const targetPath = "01-projects/ai/obsidian/retrieval-core.md";
  const sourceChunk = chunkRowFor(runtime.databasePath, sourcePath);
  const beforeTarget = readText(path.join(vault, targetPath));

  const created = createProposal(
    frameworkRoot,
    proposalArgs({
      sourceChunkIds: [sourceChunk.chunk_id],
      candidatePaths: [targetPath],
      evidence: [
        {
          path: sourcePath,
          chunkId: sourceChunk.chunk_id,
          headingPath: sourceChunk.heading_path,
          excerpt: sourceChunk.text,
        },
      ],
      targets: [
        {
          path: targetPath,
          mode: "replace",
          body: `${beforeTarget}\nAuthorization is required before this body can be written.\n`,
        },
      ],
    }),
  );

  const error = unwrapToolError(
    callTool(
      frameworkRoot,
      "proposal_apply",
      {
        proposalId: created.proposalId,
      },
      { writeEnabled: true },
    ),
  );
  assert.equal(error.code, "proposal-authorization-required");
  assert.equal(readText(path.join(vault, targetPath)), beforeTarget);
});

test("proposal_apply refuses target, taxonomy, branch, and source drift conflicts", () => {
  {
    const vault = makeProposalFixture();
    const frameworkRoot = makeProposalFrameworkRoot(vault);
    const { runtime } = buildProposalIndex(frameworkRoot, vault);
    const sourcePath = "02-knowledge/ai/search/retrieval-notes.md";
    const targetPath = "01-projects/ai/obsidian/retrieval-core.md";
    const sourceChunk = chunkRowFor(runtime.databasePath, sourcePath);
    const created = createProposal(
      frameworkRoot,
      proposalArgs({
        sourceChunkIds: [sourceChunk.chunk_id],
        candidatePaths: [targetPath],
        evidence: [
          {
            path: sourcePath,
            chunkId: sourceChunk.chunk_id,
            headingPath: sourceChunk.heading_path,
            excerpt: sourceChunk.text,
          },
        ],
        targets: [
          {
            path: targetPath,
            mode: "replace",
            body: `${readText(path.join(vault, targetPath))}\nTarget drift should block apply.\n`,
          },
        ],
      }),
    );
    const auth = authorizeProposal(frameworkRoot, created.proposalId);
    writeText(path.join(vault, targetPath), `${readText(path.join(vault, targetPath))}\nLocal drift.\n`);
    const error = unwrapToolError(applyProposal(frameworkRoot, created.proposalId, auth.authorizationId));
    assert.equal(error.code, "proposal-target-changed");
  }

  {
    const vault = makeProposalFixture();
    const frameworkRoot = makeProposalFrameworkRoot(vault);
    const { runtime } = buildProposalIndex(frameworkRoot, vault);
    const sourcePath = "02-knowledge/ai/search/retrieval-notes.md";
    const targetPath = "01-projects/ai/obsidian/retrieval-core.md";
    const sourceChunk = chunkRowFor(runtime.databasePath, sourcePath);
    const created = createProposal(
      frameworkRoot,
      proposalArgs({
        sourceChunkIds: [sourceChunk.chunk_id],
        candidatePaths: [targetPath],
        evidence: [
          {
            path: sourcePath,
            chunkId: sourceChunk.chunk_id,
            headingPath: sourceChunk.heading_path,
            excerpt: sourceChunk.text,
          },
        ],
        targets: [
          {
            path: targetPath,
            mode: "replace",
            body: `${readText(path.join(vault, targetPath))}\nTaxonomy drift should block apply.\n`,
          },
        ],
      }),
    );
    const auth = authorizeProposal(frameworkRoot, created.proposalId);
    writeText(
      path.join(frameworkRoot, "taxonomy", "approved-tags.md"),
      "# approved tags\n\n- ai\n- local-first\n- search\n- pkm\n- health\n",
    );
    const error = unwrapToolError(applyProposal(frameworkRoot, created.proposalId, auth.authorizationId));
    assert.equal(error.code, "proposal-taxonomy-changed");
  }

  {
    const vault = makeProposalFixture();
    const frameworkRoot = makeProposalFrameworkRoot(vault);
    const { runtime } = buildProposalIndex(frameworkRoot, vault);
    const sourcePath = "02-knowledge/ai/search/retrieval-notes.md";
    const targetPath = "01-projects/ai/obsidian/retrieval-core.md";
    const sourceChunk = chunkRowFor(runtime.databasePath, sourcePath);
    const created = createProposal(
      frameworkRoot,
      proposalArgs({
        sourceChunkIds: [sourceChunk.chunk_id],
        candidatePaths: [targetPath],
        evidence: [
          {
            path: sourcePath,
            chunkId: sourceChunk.chunk_id,
            headingPath: sourceChunk.heading_path,
            excerpt: sourceChunk.text,
          },
        ],
        targets: [
          {
            path: targetPath,
            mode: "replace",
            body: `${readText(path.join(vault, targetPath))}\nBranch drift should block apply.\n`,
          },
        ],
      }),
    );
    const auth = authorizeProposal(frameworkRoot, created.proposalId);
    git(vault, ["checkout", "-qb", "other-branch"]);
    const error = unwrapToolError(applyProposal(frameworkRoot, created.proposalId, auth.authorizationId));
    assert.equal(error.code, "proposal-branch-changed");
  }

  {
    const vault = makeProposalFixture();
    const frameworkRoot = makeProposalFrameworkRoot(vault);
    const { runtime } = buildProposalIndex(frameworkRoot, vault);
    const sourcePath = "02-knowledge/ai/search/retrieval-notes.md";
    const targetPath = "01-projects/ai/obsidian/retrieval-core.md";
    const sourceChunk = chunkRowFor(runtime.databasePath, sourcePath);
    const created = createProposal(
      frameworkRoot,
      proposalArgs({
        sourceChunkIds: [sourceChunk.chunk_id],
        candidatePaths: [targetPath],
        evidence: [
          {
            path: sourcePath,
            chunkId: sourceChunk.chunk_id,
            headingPath: sourceChunk.heading_path,
            excerpt: sourceChunk.text,
          },
        ],
        targets: [
          {
            path: targetPath,
            mode: "replace",
            body: `${readText(path.join(vault, targetPath))}\nSource drift should block apply.\n`,
          },
        ],
      }),
    );
    const auth = authorizeProposal(frameworkRoot, created.proposalId);
    writeText(
      path.join(vault, sourcePath),
      "# Retrieval Notes\n\nThe source evidence changed after authorization.\n",
    );
    const error = unwrapToolError(applyProposal(frameworkRoot, created.proposalId, auth.authorizationId));
    assert.equal(error.code, "proposal-source-changed");
  }
});

test("authorized proposal_apply mutates only approved paths, refreshes the index, and returns git review guidance", () => {
  const vault = makeProposalFixture();
  const frameworkRoot = makeProposalFrameworkRoot(vault);
  const { runtime } = buildProposalIndex(frameworkRoot, vault);
  const sourcePath = "02-knowledge/ai/search/retrieval-notes.md";
  const targetPath = "01-projects/ai/obsidian/retrieval-core.md";
  const createPath = "02-knowledge/ai/search/proposal-queue-safety.md";
  const untouchedPath = "04-people/health/checkups/health-context.md";
  const sourceChunk = chunkRowFor(runtime.databasePath, sourcePath);
  const untouchedBefore = readText(path.join(vault, untouchedPath));

  const created = createProposal(
    frameworkRoot,
    proposalArgs({
      operation: "multi-note-write",
      sourceChunkIds: [sourceChunk.chunk_id],
      candidatePaths: [targetPath, createPath],
      evidence: [
        {
          path: sourcePath,
          chunkId: sourceChunk.chunk_id,
          headingPath: sourceChunk.heading_path,
          excerpt: sourceChunk.text,
        },
      ],
      targets: [
        {
          path: targetPath,
          mode: "replace",
          body: `${readText(path.join(vault, targetPath))}\nApplied queue guidance is now durable.\n`,
        },
        {
          path: createPath,
          mode: "create",
          body: "# Proposal Queue Safety\n\nThis note was created through authorized MCP apply.\n",
        },
      ],
    }),
  );
  const auth = authorizeProposal(frameworkRoot, created.proposalId);
  const applied = unwrapToolResult(applyProposal(frameworkRoot, created.proposalId, auth.authorizationId));

  assert.deepEqual(
    applied.changedPaths.sort(),
    [createPath, targetPath, "02-knowledge/ai/search/_search.md"].sort(),
  );
  assert.equal(readText(path.join(vault, targetPath)).includes("Applied queue guidance"), true);
  assert.equal(readText(path.join(vault, createPath)).includes("authorized MCP apply"), true);
  assert.equal(readText(path.join(vault, untouchedPath)), untouchedBefore);
  assert.match(applied.git.status, /proposal-queue-safety\.md/);
  assert.match(applied.git.reviewCommands[0], /git -C .* status --short/);

  const refreshed = unwrapToolResult(
    callTool(frameworkRoot, "search_hybrid", {
      query: "Proposal Queue Safety",
      limit: 3,
    }),
  );
  assert.equal(refreshed.results.some((item) => item.path === createPath), true);

  const appliedRead = unwrapToolResult(
    callTool(frameworkRoot, "proposal_read", {
      proposalId: created.proposalId,
    }),
  );
  assert.equal(appliedRead.proposal.status, "applied");
  assert.equal(appliedRead.proposal.targets.every((target) => target.body === undefined), true);
  assert.match(appliedRead.diffPreview[0].preview, /content has been redacted/);
  assert.doesNotMatch(JSON.stringify(appliedRead), /Applied queue guidance/);
});

test("proposal_apply rolls back multi-file writes on failure and records failed state", () => {
  const vault = makeProposalFixture();
  const frameworkRoot = makeProposalFrameworkRoot(vault);
  const { runtime } = buildProposalIndex(frameworkRoot, vault);
  const sourcePath = "02-knowledge/ai/search/retrieval-notes.md";
  const targetPath = "01-projects/ai/obsidian/retrieval-core.md";
  const createPath = "02-knowledge/ai/search/rollback-target.md";
  const indexPath = "02-knowledge/ai/search/_search.md";
  const sourceChunk = chunkRowFor(runtime.databasePath, sourcePath);
  const beforeTarget = readText(path.join(vault, targetPath));
  const beforeIndex = readText(path.join(vault, indexPath));
  const hookEnv = "DREAMERS_NOTE_TEST_FAIL_AFTER_WRITE";

  const created = createProposal(
    frameworkRoot,
    proposalArgs({
      operation: "multi-note-write",
      sourceChunkIds: [sourceChunk.chunk_id],
      candidatePaths: [targetPath, createPath],
      evidence: [
        {
          path: sourcePath,
          chunkId: sourceChunk.chunk_id,
          headingPath: sourceChunk.heading_path,
          excerpt: sourceChunk.text,
        },
      ],
      targets: [
        {
          path: targetPath,
          mode: "replace",
          body: `${beforeTarget}\nThis write should be rolled back.\n`,
        },
        {
          path: createPath,
          mode: "create",
          body: "# Rollback Target\n\nThis file should never survive a failed apply.\n",
        },
      ],
    }),
  );
  const auth = authorizeProposal(frameworkRoot, created.proposalId);

  process.env[hookEnv] = "1";
  try {
    const error = unwrapToolError(applyProposal(frameworkRoot, created.proposalId, auth.authorizationId));
    assert.equal(error.code, "proposal-apply-failed");
  } finally {
    delete process.env[hookEnv];
  }

  assert.equal(readText(path.join(vault, targetPath)), beforeTarget);
  assert.equal(readText(path.join(vault, indexPath)), beforeIndex);
  assert.equal(fs.existsSync(path.join(vault, createPath)), false);
  const read = unwrapToolResult(
    callTool(frameworkRoot, "proposal_read", {
      proposalId: created.proposalId,
    }),
  );
  assert.equal(read.proposal.status, "failed");
  assert.equal(fs.existsSync(runtimePaths(frameworkRoot).lockPath), false);
});

test("proposal_apply rollback removes newly created note and homepage directories", () => {
  const vault = makeProposalFixture();
  const frameworkRoot = makeProposalFrameworkRoot(vault);
  buildProposalIndex(frameworkRoot, vault);
  const newDirectory = "02-knowledge/ai/new-directory";
  const newNote = `${newDirectory}/new-note.md`;
  const newHomepage = `${newDirectory}/_new-directory.md`;
  const parentHomepage = "02-knowledge/ai/_ai.md";
  const parentBefore = readText(path.join(vault, parentHomepage));
  const created = createProposal(
    frameworkRoot,
    proposalArgs({
      operation: "new-directory-rollback",
      rationale: "Exercise rollback of a newly derived homepage directory.",
      targets: [{
        path: newNote,
        mode: "create",
        body: "# New Note\n\nNew note creates a directory homepage.\n",
      }],
    }),
  );
  assert.deepEqual(created.targetPaths, [parentHomepage, newHomepage, newNote]);
  const auth = authorizeProposal(frameworkRoot, created.proposalId);

  process.env.DREAMERS_NOTE_TEST_FAIL_AFTER_WRITE = "1";
  try {
    const error = unwrapToolError(
      applyProposal(frameworkRoot, created.proposalId, auth.authorizationId),
    );
    assert.equal(error.code, "proposal-apply-failed");
  } finally {
    delete process.env.DREAMERS_NOTE_TEST_FAIL_AFTER_WRITE;
  }

  assert.equal(fs.existsSync(path.join(vault, newNote)), false);
  assert.equal(fs.existsSync(path.join(vault, newHomepage)), false);
  assert.equal(fs.existsSync(path.join(vault, newDirectory)), false);
  assert.equal(readText(path.join(vault, parentHomepage)), parentBefore);
});

test("proposal_apply rolls back path actions and restores index state after refresh failure", () => {
  const vault = makeProposalFixture();
  const frameworkRoot = makeProposalFrameworkRoot(vault);
  const { runtime } = buildProposalIndex(frameworkRoot, vault);
  const moveSource = "00-inbox/daily-notes/2026-06-16.md";
  const moveDestination = "99-archive/daily-notes/2026-06-16.md";
  const externalSource = path.join(tmpdir("dreamers-note-proposal-path-action-external"), "source.md");
  const sourceText = "# Daily\n\nPath action rollback sentinel should stay at the source path.\n";
  const externalText = "# External\n\nExternal rollback sentinel should be restored.\n";
  const hookEnv = "DREAMERS_NOTE_TEST_FAIL_AFTER_WRITE";
  writeText(path.join(vault, moveSource), sourceText);
  writeText(externalSource, externalText);

  const created = createProposal(
    frameworkRoot,
    proposalArgs({
      operation: "path-action-rollback",
      bundleId: "bundle-path-action",
      approvedTags: ["ai"],
      proposedTagGaps: [],
      candidatePaths: [moveSource, moveDestination],
      pathActions: [
        {
          type: "move",
          scope: "vault",
          path: moveSource,
          destinationPath: moveDestination,
        },
        {
          type: "delete-file",
          scope: "external",
          path: externalSource,
        },
      ],
      targets: [],
    }),
  );
  const auth = authorizeProposal(frameworkRoot, created.proposalId);

  process.env[hookEnv] = "after-refresh";
  try {
    const error = unwrapToolError(applyProposal(frameworkRoot, created.proposalId, auth.authorizationId));
    assert.equal(error.code, "proposal-apply-failed");
  } finally {
    delete process.env[hookEnv];
  }

  assert.equal(readText(path.join(vault, moveSource)), sourceText);
  assert.equal(fs.existsSync(path.join(vault, moveDestination)), false);
  assert.equal(readText(externalSource), externalText);
  assert.equal(fs.existsSync(runtimePaths(frameworkRoot).lockPath), false);

  const read = unwrapToolResult(
    callTool(frameworkRoot, "proposal_read", {
      proposalId: created.proposalId,
    }),
  );
  assert.equal(read.proposal.status, "failed");

  const search = unwrapToolResult(
    callTool(frameworkRoot, "search_hybrid", {
      query: "rollback sentinel",
      limit: 5,
    }),
  );
  assert.equal(search.results.some((item) => item.path === moveSource), true);
  assert.equal(search.results.some((item) => item.path === moveDestination), false);
});

test("proposal apply lock refuses live contention and stale lock recovery succeeds", () => {
  const vault = makeProposalFixture();
  const frameworkRoot = makeProposalFrameworkRoot(vault);
  const { runtime } = buildProposalIndex(frameworkRoot, vault);
  const sourcePath = "02-knowledge/ai/search/retrieval-notes.md";
  const targetPath = "01-projects/ai/obsidian/retrieval-core.md";
  const sourceChunk = chunkRowFor(runtime.databasePath, sourcePath);
  const created = createProposal(
    frameworkRoot,
    proposalArgs({
      sourceChunkIds: [sourceChunk.chunk_id],
      candidatePaths: [targetPath],
      evidence: [
        {
          path: sourcePath,
          chunkId: sourceChunk.chunk_id,
          headingPath: sourceChunk.heading_path,
          excerpt: sourceChunk.text,
        },
      ],
      targets: [
        {
          path: targetPath,
          mode: "replace",
          body: `${readText(path.join(vault, targetPath))}\nLock recovery should still allow a later apply.\n`,
        },
      ],
    }),
  );
  const auth = authorizeProposal(frameworkRoot, created.proposalId);
  const { lockPath } = runtimePaths(frameworkRoot);

  writeText(lockPath, JSON.stringify({ pid: 999999, createdAt: new Date().toISOString() }));
  let error = unwrapToolError(applyProposal(frameworkRoot, created.proposalId, auth.authorizationId));
  assert.equal(error.code, "proposal-apply-locked");

  const staleTime = new Date("2000-01-01T00:00:00Z");
  fs.utimesSync(lockPath, staleTime, staleTime);
  const applied = unwrapToolResult(applyProposal(frameworkRoot, created.proposalId, auth.authorizationId));
  assert.deepEqual(applied.changedPaths, [targetPath]);
  assert.equal(fs.existsSync(lockPath), false);
});

test("proposal logging keeps metadata only and never writes note bodies", () => {
  const { sanitizeProposalLogEntry } = loadProposalQueueModule();
  const sanitized = sanitizeProposalLogEntry({
    eventType: "proposal-create",
    proposalId: "proposal-42",
    path: "01-projects/ai/obsidian/retrieval-core.md",
    hash: "abc123",
    durationMs: 12,
    outcome: "success",
    body: "private note body text",
    excerpt: "sensitive excerpt",
    rationale: "verbose detail",
  });
  assert.deepEqual(Object.keys(sanitized).sort(), ["durationMs", "eventType", "hash", "outcome", "path", "proposalId"]);
  assert.equal(Object.hasOwn(sanitized, "body"), false);
  assert.equal(Object.hasOwn(sanitized, "excerpt"), false);

  const vault = makeProposalFixture();
  const frameworkRoot = makeProposalFrameworkRoot(vault);
  const { runtime } = buildProposalIndex(frameworkRoot, vault);
  const sourcePath = "02-knowledge/ai/search/retrieval-notes.md";
  const targetPath = "01-projects/ai/obsidian/retrieval-core.md";
  const sourceChunk = chunkRowFor(runtime.databasePath, sourcePath);
  const created = createProposal(
    frameworkRoot,
    proposalArgs({
      sourceChunkIds: [sourceChunk.chunk_id],
      candidatePaths: [targetPath],
      evidence: [
        {
          path: sourcePath,
          chunkId: sourceChunk.chunk_id,
          headingPath: sourceChunk.heading_path,
          excerpt: sourceChunk.text,
        },
      ],
      targets: [
        {
          path: targetPath,
          mode: "replace",
          body: `${readText(path.join(vault, targetPath))}\nLog verification apply.\n`,
        },
      ],
    }),
  );
  const auth = authorizeProposal(frameworkRoot, created.proposalId);
  unwrapToolResult(applyProposal(frameworkRoot, created.proposalId, auth.authorizationId));

  const logLines = readText(runtimePaths(frameworkRoot).logPath)
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(logLines.some((entry) => entry.eventType === "proposal-create"), true);
  assert.equal(
    logLines.every((entry) => {
      const keys = Object.keys(entry).sort();
      return keys.every((key) => ["durationMs", "eventType", "hash", "outcome", "path", "proposalId"].includes(key));
    }),
    true,
  );
  assert.equal(readText(runtimePaths(frameworkRoot).logPath).includes("PLAN05-SECRET-CANARY"), false);
  assert.equal(readText(runtimePaths(frameworkRoot).logPath).includes("private note body text"), false);
});

test("classified note proposals derive visible atomic homepages and manual drift produces a reviewed repair proposal", () => {
  const vault = makeProposalFixture({ seedDirectoryIndexes: false });
  const frameworkRoot = makeProposalFrameworkRoot(vault);
  buildProposalIndex(frameworkRoot, vault);
  const notePath = "02-knowledge/ai/search/directory-sync.md";
  const directIndexPath = "02-knowledge/ai/search/_search.md";
  const noteBody = "# Directory Sync\n\nDirectory sync keeps generated homepages current.\n";

  const beforeCreate = git(vault, ["status", "--short"]);
  const createStarted = performance.now();
  const created = unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_create_note",
      {
        operation: "note-add",
        path: notePath,
        mode: "create",
        body: noteBody,
        rationale: "Add durable directory synchronization guidance.",
      },
      { writeEnabled: true },
    ),
  );
  assert.equal(performance.now() - createStarted < 2_000, true);
  assert.deepEqual(created.targetPaths, [
    directIndexPath,
    notePath,
  ]);
  assert.equal(fs.existsSync(path.join(vault, notePath)), false);
  assert.equal(fs.existsSync(path.join(vault, directIndexPath)), false);
  assert.equal(git(vault, ["status", "--short"]), beforeCreate);

  const createdRead = unwrapToolResult(
    callTool(frameworkRoot, "proposal_read", { proposalId: created.proposalId }),
  );
  assert.deepEqual(createdRead.proposal.targetPaths, created.targetPaths);
  assert.equal(createdRead.diffPreview.length, 2);
  assert.equal(
    createdRead.diffPreview.some(
      (preview) => preview.path === directIndexPath && /Directory Sync/.test(preview.preview),
    ),
    true,
  );
  assert.deepEqual(
    Object.keys(createdRead.proposal.lineage.beforeHashes).sort(),
    created.targetPaths,
  );

  const createAuth = authorizeProposal(frameworkRoot, created.proposalId);
  const applied = unwrapToolResult(
    applyProposal(frameworkRoot, created.proposalId, createAuth.authorizationId),
  );
  assert.deepEqual(applied.changedPaths, created.targetPaths);
  assert.match(readText(path.join(vault, directIndexPath)), /## Notes/);
  assert.match(readText(path.join(vault, directIndexPath)), /\|Directory Sync\]\]/);

  const currentIndex = readText(path.join(vault, directIndexPath));
  const explicitNotesBody = currentIndex
    .replace(/^.*$/m, "Noncanonical generated lead that must not survive.")
    .replace("## Notes", "## Notes\n\nPreserve this explicit human homepage note.");
  const composed = createProposal(
    frameworkRoot,
    proposalArgs({
      operation: "composed-directory-update",
      rationale: "Compose note creation, homepage Notes, and a classified move.",
      targets: [
        {
          path: "02-knowledge/ai/search/second-directory-note.md",
          mode: "create",
          body: "# Second Directory Note\n\nSecond note changes the generated page list.\n",
        },
        {
          path: directIndexPath,
          mode: "replace",
          body: explicitNotesBody,
        },
      ],
      pathActions: [{
        type: "move",
        scope: "vault",
        path: "02-knowledge/ai/search/retrieval-notes.md",
        destinationPath: "02-knowledge/ai/pkm/retrieval-notes.md",
      }],
    }),
  );
  assert.deepEqual(composed.targetPaths, [
    "02-knowledge/ai/pkm/_pkm.md",
    directIndexPath,
    "02-knowledge/ai/search/second-directory-note.md",
  ]);
  assert.equal(new Set(composed.targetPaths).size, composed.targetPaths.length);
  const composedRead = unwrapToolResult(
    callTool(frameworkRoot, "proposal_read", { proposalId: composed.proposalId }),
  );
  const homepagePreview = composedRead.diffPreview.find((preview) => preview.path === directIndexPath);
  assert.match(homepagePreview.preview, /Preserve this explicit human homepage note/);
  assert.doesNotMatch(homepagePreview.preview, /Noncanonical generated lead that must not survive/);
  unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_reject",
      { proposalId: composed.proposalId, reason: "Integration-only composed proposal." },
      { writeEnabled: true },
    ),
  );

  const duplicateCollision = unwrapToolError(
    callTool(
      frameworkRoot,
      "proposal_create",
      proposalArgs({
        operation: "duplicate-target-collision",
        rationale: "Duplicate normalized paths must be rejected.",
        targets: [
          { path: notePath, mode: "replace", body: noteBody },
          { path: `./${notePath}`, mode: "replace", body: noteBody },
        ],
      }),
      { writeEnabled: true },
    ),
  );
  assert.equal(duplicateCollision.code, "proposal-target-collision");

  const pathActionCollision = unwrapToolError(
    callTool(
      frameworkRoot,
      "proposal_create",
      proposalArgs({
        operation: "path-action-collision",
        rationale: "Target and move source overlap must be rejected.",
        targets: [{ path: notePath, mode: "replace", body: noteBody }],
        pathActions: [{
          type: "move",
          scope: "vault",
          path: notePath,
          destinationPath: "02-knowledge/ai/pkm/directory-sync.md",
        }],
      }),
      { writeEnabled: true },
    ),
  );
  assert.equal(pathActionCollision.code, "proposal-path-collision");

  const moveSetCollision = unwrapToolError(
    callTool(
      frameworkRoot,
      "proposal_create",
      proposalArgs({
        operation: "move-set-collision",
        rationale: "Two moves cannot share a destination.",
        targets: [],
        pathActions: [
          {
            type: "move",
            scope: "vault",
            path: notePath,
            destinationPath: "02-knowledge/ai/pkm/shared-destination.md",
          },
          {
            type: "move",
            scope: "vault",
            path: "02-knowledge/ai/search/retrieval-notes.md",
            destinationPath: "02-knowledge/ai/pkm/shared-destination.md",
          },
        ],
      }),
      { writeEnabled: true },
    ),
  );
  assert.equal(moveSetCollision.code, "proposal-path-collision");

  const derivedActionCollision = unwrapToolError(
    callTool(
      frameworkRoot,
      "proposal_create",
      proposalArgs({
        operation: "derived-action-collision",
        rationale: "A homepage move cannot overlap its canonical derived target.",
        targets: [],
        pathActions: [{
          type: "move",
          scope: "vault",
          path: directIndexPath,
          destinationPath: "02-knowledge/ai/pkm/_pkm.md",
        }],
      }),
      { writeEnabled: true },
    ),
  );
  assert.equal(derivedActionCollision.code, "proposal-path-collision");

  const noOpBody = `${noteBody}\n## Detail\n\nThis does not change the indexed summary.\n`;
  const noOp = unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_create_note",
      {
        operation: "note-update",
        path: notePath,
        mode: "replace",
        body: noOpBody,
        rationale: "Add detail without changing directory summary fields.",
      },
      { writeEnabled: true },
    ),
  );
  assert.deepEqual(noOp.targetPaths, [notePath]);

  const changedSummaryBody = noOpBody.replace(
    "Directory sync keeps generated homepages current.",
    "Directory sync now keeps reviewed homepages current.",
  );
  const changed = unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_create_note",
      {
        operation: "note-update",
        path: notePath,
        mode: "replace",
        body: changedSummaryBody,
        rationale: "Change the summary shown by the directory homepage.",
      },
      { writeEnabled: true },
    ),
  );
  assert.deepEqual(changed.targetPaths, [directIndexPath, notePath]);
  const changedAuth = authorizeProposal(frameworkRoot, changed.proposalId);
  writeText(
    path.join(vault, directIndexPath),
    `${readText(path.join(vault, directIndexPath))}\nManual concurrent drift.\n`,
  );
  const stale = unwrapToolError(
    applyProposal(frameworkRoot, changed.proposalId, changedAuth.authorizationId),
  );
  assert.equal(stale.code, "proposal-target-changed");

  writeText(path.join(vault, notePath), changedSummaryBody);
  unwrapToolResult(callTool(frameworkRoot, "index_refresh", {}));
  const report = unwrapToolResult(callTool(frameworkRoot, "health_report", { limit: 20 }));
  const drift = report.items.find(
    (item) => item.category === "directory-index-drift" && item.paths.includes(directIndexPath),
  );
  assert.ok(drift);
  const indexBeforeRepair = readText(path.join(vault, directIndexPath));
  const repaired = unwrapToolResult(
    callTool(
      frameworkRoot,
      "proposal_create_directory_index_refresh",
      {
        paths: [directIndexPath],
        rationale: drift.summary,
      },
      { writeEnabled: true },
    ),
  );
  assert.deepEqual(repaired.targetPaths, [directIndexPath]);
  assert.equal(readText(path.join(vault, directIndexPath)), indexBeforeRepair);
  const repairRead = unwrapToolResult(
    callTool(frameworkRoot, "proposal_read", { proposalId: repaired.proposalId }),
  );
  assert.match(repairRead.diffPreview[0].preview, /reviewed homepages/);
  const repairAuth = authorizeProposal(frameworkRoot, repaired.proposalId);
  unwrapToolResult(applyProposal(frameworkRoot, repaired.proposalId, repairAuth.authorizationId));
  assert.match(readText(path.join(vault, directIndexPath)), /reviewed homepages/);
  assert.match(readText(path.join(vault, directIndexPath)), /## Notes/);

  const noDrift = unwrapToolError(
    callTool(
      frameworkRoot,
      "proposal_create_directory_index_refresh",
      {
        paths: [directIndexPath],
        rationale: "No remaining drift should create no proposal.",
      },
      { writeEnabled: true },
    ),
  );
  assert.equal(noDrift.code, "directory-index-no-drift");
});

test("directory index repair rejects private, symlinked, and non-homepage paths without mutation", () => {
  const vault = makeProposalFixture();
  const frameworkRoot = makeProposalFrameworkRoot(vault);
  buildProposalIndex(frameworkRoot, vault);
  const symlinkDirectory = path.join(vault, "02-knowledge", "ai", "linked");
  fs.mkdirSync(symlinkDirectory, { recursive: true });
  fs.symlinkSync(
    path.join(vault, "02-knowledge", "ai", "search", "_search.md"),
    path.join(symlinkDirectory, "_linked.md"),
  );
  const before = readText(path.join(vault, "02-knowledge/ai/search/_search.md"));

  const cases = [
    {
      path: "07-system/secrets/_secrets.md",
      code: "directory-index-path-rejected",
      redacted: true,
    },
    {
      path: "02-knowledge/ai/linked/_linked.md",
      code: "directory-index-path-rejected",
      redacted: false,
    },
    {
      path: "02-knowledge/ai/search/not-the-homepage.md",
      code: "directory-index-path-invalid",
      redacted: false,
    },
  ];
  for (const item of cases) {
    const error = unwrapToolError(
      callTool(
        frameworkRoot,
        "proposal_create_directory_index_refresh",
        {
          paths: [item.path],
          rationale: "Reject invalid repair selection.",
        },
        { writeEnabled: true },
      ),
    );
    assert.equal(error.code, item.code);
    assert.equal(JSON.stringify(error).length < 1_000, true);
    if (item.redacted) {
      assert.doesNotMatch(JSON.stringify(error), /07-system\/secrets|_secrets/);
    }
  }
  assert.equal(readText(path.join(vault, "02-knowledge/ai/search/_search.md")), before);
});
