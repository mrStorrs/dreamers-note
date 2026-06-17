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
