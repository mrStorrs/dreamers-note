import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import {
  distDir,
  tmpdir,
  writeText,
} from "./helpers/project-fixtures.mjs";

const require = createRequire(import.meta.url);

function loadBuiltModule(moduleName) {
  return require(path.join(distDir, moduleName));
}

function makeEnvironment(vaultPath) {
  return {
    rootDir: tmpdir("dreamers-note-proposal-unit-root"),
    vaultPath,
    databasePath: path.join(tmpdir("dreamers-note-proposal-unit-runtime"), "index.sqlite"),
    runtimeLogPath: path.join(tmpdir("dreamers-note-proposal-unit-runtime"), "dreamers-note.log"),
    privateGlobs: ["07-system/secrets/**"],
    approvedTags: ["ai", "obsidian"],
  };
}

function proposalInput(overrides = {}) {
  return {
    operation: "note-update",
    sourceChunkIds: [],
    approvedTags: ["ai"],
    rationale: "Normalize proposal input with structured validation.",
    targets: [
      {
        path: "01-projects/ai/obsidian/new-note.md",
        mode: "create",
        body: "# New Note\n",
      },
    ],
    ...overrides,
  };
}

function normalizerDependencies(loadProposalById = () => ({ ok: false, error: { code: "proposal-not-found", message: "missing" } })) {
  const db = {
    prepare() {
      return {
        get() {
          return undefined;
        },
      };
    },
  };
  return {
    openDatabase() {
      return db;
    },
    loadProposalById,
    closeDatabase() {},
  };
}

function storedDependency(overrides = {}) {
  return {
    proposalId: "dep-01",
    operation: "note-update",
    status: "pending",
    revision: 1,
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    targetPaths: [],
    candidatePaths: [],
    sourcePaths: [],
    approvedTags: [],
    proposedTagGaps: [],
    unresolvedQuestions: [],
    validationBlockers: [],
    dependencies: [],
    rationale: "Dependency proposal.",
    evidence: [],
    pathActions: [],
    targets: [],
    lineage: {
      indexGeneration: "",
      sourceHashes: {},
      externalSourceHashes: {},
      candidateHashes: {},
      taxonomyHash: "",
      exclusionConfigHash: "",
      sourceChunkIds: [],
      collisionSearchInputs: [],
      beforeHashes: {},
    },
    diffHash: "hash",
    ...overrides,
  };
}

test("proposal target builder stores direct body content without edit specs", () => {
  const { buildProposalTarget, materializeTargetBody } = loadBuiltModule("proposal-targets.js");
  const { fileHash } = loadBuiltModule("files.js");
  const vault = tmpdir("dreamers-note-proposal-target-vault");
  const targetPath = "01-projects/ai/obsidian/retrieval-core.md";
  const beforeText = "# Retrieval Core\n\nExisting text.\n";
  const nextText = `${beforeText}\nDirect body content.\n`;
  writeText(path.join(vault, targetPath), beforeText);

  const built = buildProposalTarget(makeEnvironment(vault), {
    path: targetPath,
    mode: "replace",
    body: nextText,
  });

  assert.equal(built.ok, true);
  assert.equal(built.value.path, targetPath);
  assert.equal(built.value.beforeHash, fileHash(path.join(vault, targetPath)));
  assert.equal(built.value.body, nextText);
  assert.equal(Object.hasOwn(built.value, "editSpec"), false);
  assert.equal(materializeTargetBody(built.value, beforeText), nextText);
});

test("proposal target hydrator materializes legacy patch rows", () => {
  const { hydrateProposalTarget, materializeTargetBody } = loadBuiltModule("proposal-targets.js");

  const hydrated = hydrateProposalTarget({
    path: "01-projects/ai/obsidian/retrieval-core.md",
    mode: "replace",
    beforeHash: "before-hash",
    bodyHash: "after-hash",
    editSpec: {
      start: 2,
      end: 5,
      insertText: "XYZ",
    },
  });

  assert.equal(hydrated.body, undefined);
  assert.equal(materializeTargetBody(hydrated, "abcdef"), "abXYZf");
});

test("proposal diff previews reject unsafe hydrated target paths before reading disk", () => {
  const { buildDiffPreview } = loadBuiltModule("proposal-targets.js");
  const fsModule = require("node:fs");
  const vault = tmpdir("dreamers-note-proposal-preview-vault");
  const outside = path.join(tmpdir("dreamers-note-proposal-preview-outside"), "secret.md");
  const symlinkPath = path.join(vault, "01-projects/ai/obsidian/link.md");
  writeText(outside, "outside secret\n");
  writeText(path.join(vault, "01-projects/ai/obsidian/placeholder.md"), "# Placeholder\n");
  fsModule.symlinkSync(outside, symlinkPath);
  const originalReadFileSync = fsModule.readFileSync;
  const readAttempts = [];
  fsModule.readFileSync = function patchedReadFileSync(target, ...args) {
    readAttempts.push(String(target));
    return originalReadFileSync.call(this, target, ...args);
  };
  let preview;
  try {
    preview = buildDiffPreview(makeEnvironment(vault), [
      {
        path: "../outside.md",
        mode: "replace",
        body: "content",
        beforeHash: null,
        bodyHash: "hash",
      },
      {
        path: "07-system/secrets/token.md",
        mode: "replace",
        body: "content",
        beforeHash: null,
        bodyHash: "hash",
      },
      {
        path: "01-projects/ai/obsidian/link.md",
        mode: "replace",
        body: "content",
        beforeHash: null,
        bodyHash: "hash",
      },
    ]);
  } finally {
    fsModule.readFileSync = originalReadFileSync;
  }

  assert.match(preview[0].preview, /invalid, excluded, or unsafe to read/);
  assert.match(preview[1].preview, /invalid, excluded, or unsafe to read/);
  assert.match(preview[2].preview, /invalid, excluded, or unsafe to read/);
  assert.deepEqual(readAttempts, []);
  assert.equal(preview[0].path, "[invalid or excluded target path]");
  assert.equal(preview[1].path, "[invalid or excluded target path]");
  assert.equal(preview[2].path, "[invalid or excluded target path]");
  assert.doesNotMatch(JSON.stringify(preview), /\.\.\/outside|07-system\/secrets|link\.md/);
});

test("proposal metadata builder preserves structured validation errors", () => {
  const { normalizeProposalMetadata } = loadBuiltModule("proposal-create-normalizer.js");

  const invalidOperation = normalizeProposalMetadata(
    {
      operation: "",
      sourceChunkIds: [],
      targets: [],
      rationale: "valid rationale",
    },
    ["ai"],
  );
  assert.equal(invalidOperation.ok, false);
  assert.equal(invalidOperation.error.code, "invalid-arguments");
  assert.match(invalidOperation.error.message, /operation/);

  const invalidTag = normalizeProposalMetadata(
    {
      operation: "note-update",
      sourceChunkIds: [],
      targets: [],
      rationale: "valid rationale",
      approvedTags: ["unknown"],
    },
    ["ai"],
  );
  assert.equal(invalidTag.ok, false);
  assert.equal(invalidTag.error.code, "proposal-unapproved-tag");
});

test("proposal create normalizer preserves structured errors for dependency, evidence, candidate, and placement debt branches", () => {
  const { normalizeCreateInput } = loadBuiltModule("proposal-create-normalizer.js");
  const vault = tmpdir("dreamers-note-proposal-normalizer-vault");
  writeText(path.join(vault, "02-knowledge/ai/source.md"), "# Source\n");
  const environment = makeEnvironment(vault);

  const missingDependency = normalizeCreateInput(
    environment,
    proposalInput({ dependencies: ["missing-dep"] }),
    normalizerDependencies(),
  );
  assert.equal(missingDependency.ok, false);
  assert.equal(missingDependency.error.code, "proposal-dependency-missing");

  const bundleMismatch = normalizeCreateInput(
    environment,
    proposalInput({ bundleId: "bundle-a", dependencies: ["dep-01"] }),
    normalizerDependencies(() => ({ ok: true, value: storedDependency({ bundleId: "bundle-b" }) })),
  );
  assert.equal(bundleMismatch.ok, false);
  assert.equal(bundleMismatch.error.code, "proposal-dependency-bundle-mismatch");

  const uncitedVaultEvidence = normalizeCreateInput(
    environment,
    proposalInput({ evidence: [{ path: "02-knowledge/ai/source.md", excerpt: "source" }] }),
    normalizerDependencies(),
  );
  assert.equal(uncitedVaultEvidence.ok, false);
  assert.equal(uncitedVaultEvidence.error.code, "proposal-vault-evidence-requires-source-chunk");

  const invalidCandidatePath = normalizeCreateInput(
    environment,
    proposalInput({ candidatePaths: ["../outside.md"] }),
    normalizerDependencies(),
  );
  assert.equal(invalidCandidatePath.ok, false);
  assert.equal(invalidCandidatePath.error.code, "path-traversal");

  const invalidPlacementDebt = normalizeCreateInput(
    environment,
    proposalInput({
      placementDebt: {
        originalText: "capture text",
        ambiguityReason: "Ambiguous destination.",
        reviewDueAt: "2000-01-01T00:00:00.000Z",
        candidateDestinations: [{ path: "01-projects/ai/obsidian/new-note.md" }],
      },
    }),
    normalizerDependencies(),
  );
  assert.equal(invalidPlacementDebt.ok, false);
  assert.equal(invalidPlacementDebt.error.code, "invalid-arguments");
  assert.match(invalidPlacementDebt.error.message, /daily-note target/);
});

test("proposal path actions are normalized as discriminated move or external-delete actions", () => {
  const { normalizePathActions } = loadBuiltModule("proposal-path-actions.js");
  const { fileHash } = loadBuiltModule("files.js");
  const vault = tmpdir("dreamers-note-proposal-action-vault");
  const environment = makeEnvironment(vault);
  const moveSource = "00-inbox/daily-notes/2026-06-16.md";
  const moveDestination = "99-archive/daily-notes/2026-06-16.md";
  const externalSource = path.join(tmpdir("dreamers-note-proposal-external"), "import.md");
  writeText(path.join(vault, moveSource), "# Daily\n\nArchive me.\n");
  writeText(externalSource, "# Import\n\nDelete after approval.\n");

  const move = normalizePathActions(environment, [
    {
      type: "move",
      scope: "vault",
      path: moveSource,
      destinationPath: moveDestination,
    },
  ]);
  assert.equal(move.ok, true);
  assert.deepEqual(move.value[0], {
    type: "move",
    scope: "vault",
    path: moveSource,
    destinationPath: moveDestination,
    beforeHash: fileHash(path.join(vault, moveSource)),
    destinationBeforeHash: null,
  });

  const externalDelete = normalizePathActions(environment, [
    {
      type: "delete-file",
      scope: "external",
      path: externalSource,
    },
  ]);
  assert.equal(externalDelete.ok, true);
  assert.equal(externalDelete.value[0].type, "delete-file");
  assert.equal(externalDelete.value[0].scope, "external");
  assert.equal(externalDelete.value[0].path, externalSource);
  assert.equal(Object.hasOwn(externalDelete.value[0], "destinationPath"), false);

  const impossibleMove = normalizePathActions(environment, [
    {
      type: "move",
      scope: "external",
      path: moveSource,
      destinationPath: moveDestination,
    },
  ]);
  assert.equal(impossibleMove.ok, false);
  assert.equal(impossibleMove.error.code, "invalid-arguments");
  assert.match(impossibleMove.error.message, /move pathActions only support vault scope/);

  const impossibleDelete = normalizePathActions(environment, [
    {
      type: "delete-file",
      scope: "vault",
      path: externalSource,
    },
  ]);
  assert.equal(impossibleDelete.ok, false);
  assert.equal(impossibleDelete.error.code, "invalid-arguments");
  assert.match(impossibleDelete.error.message, /delete-file pathActions require external scope/);
});
