import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import {
  createProjectFixture,
  loadBuiltPackage,
  runtimeDatabasePath,
  snapshotVaultContent,
  tmpdir,
  writeText,
} from "./helpers/project-fixtures.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const retrievalPath = "01-projects/ai/obsidian/retrieval-core.md";
const dailyPath = "00-inbox/daily-notes/2026-09-05.md";
const archivePath = "99-archive/daily-notes/2026-09-05.md";

function makeFixture() {
  return createProjectFixture({
    git: true,
    vaultFiles: {
      [retrievalPath]: "# Retrieval Core\n\nOriginal retrieval guidance.\n",
      "02-knowledge/ai/search/source.md": "# Source\n\n## Notes\n\nDurable source material.\n",
      [dailyPath]: "# Daily\n\nCapture to archive atomically.\n",
      "07-system/secrets/token.md": "CHANGE-LIFECYCLE-SECRET-CANARY\n",
    },
  });
}

function environmentFor(frameworkRoot) {
  const { loadVaultEnvironment } = loadBuiltPackage();
  const environment = loadVaultEnvironment({ rootDir: frameworkRoot });
  assert.equal(environment.ok, true, JSON.stringify(environment.error));
  return environment.value;
}

function pendingChange(api, environment, fixture, overrides = {}) {
  const original = fixture.readVaultText(retrievalPath);
  const created = api.createChange(environment, {
    summary: "Update retrieval guidance and archive the related daily capture.",
    writes: [{
      path: retrievalPath,
      body: original.replace("Original retrieval guidance.", "Updated retrieval guidance for the change lifecycle."),
    }],
    moves: [{ from: dailyPath, to: archivePath }],
    ...overrides,
  });
  assert.equal(created.ok, true, JSON.stringify(created.error));
  return created.value;
}

function assertApplyRefused(api, environment, fixture, created, expectedCode) {
  const beforeApply = snapshotVaultContent(fixture.vaultPath);
  const applied = api.applyChange(environment, { id: created.id, revision: created.revision });
  assert.equal(applied.ok, false, JSON.stringify(applied));
  assert.equal(applied.error.code, expectedCode);
  assert.deepEqual(snapshotVaultContent(fixture.vaultPath), beforeApply);
  const shown = api.showChange(environment, created.id);
  assert.equal(shown.ok, true, JSON.stringify(shown.error));
  assert.equal(shown.value.change.status, "pending");
}

function rawChangeRow(databasePath, changeId) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("select status, writes, diff_text, last_error from changes where change_id = ?").get(changeId);
  } finally {
    db.close();
  }
}

test("create materializes one pending exact change with derived homepage writes and no vault mutation", () => {
  const fixture = makeFixture();
  const environment = environmentFor(fixture.frameworkRoot);
  const api = loadBuiltPackage();
  const before = snapshotVaultContent(fixture.vaultPath);
  const created = pendingChange(api, environment, fixture);

  assert.match(created.id, /^[0-9a-f-]{36}$/i);
  assert.match(created.revision, /^[a-f0-9]{64}$/);
  assert.equal(created.status, "pending");
  assert.equal(created.derivedPaths.length > 0, true);
  assert.equal(created.changedPaths.includes(retrievalPath), true);
  assert.equal(created.changedPaths.includes(dailyPath), true);
  assert.equal(created.changedPaths.includes(archivePath), true);
  assert.deepEqual(snapshotVaultContent(fixture.vaultPath), before);

  const shown = api.showChange(environment, created.id);
  assert.equal(shown.ok, true, JSON.stringify(shown.error));
  assert.equal(shown.value.validation.state, "current");
  assert.equal(shown.value.change.writes.some((item) => item.path === retrievalPath && item.beforeHash), true);
  assert.match(shown.value.diff.text, /Retrieval Core/);
});

test("create rejects malformed, conflicting, unsafe, private, symlink, and deletion-shaped inputs before persistence", () => {
  const fixture = makeFixture();
  const environment = environmentFor(fixture.frameworkRoot);
  const api = loadBuiltPackage();
  const outside = path.join(tmpdir("dreamers-note-change-outside"), "outside.md");
  const symlinkPath = "01-projects/ai/obsidian/symlink.md";
  writeText(outside, "outside\n");
  fs.symlinkSync(outside, path.join(fixture.vaultPath, symlinkPath));

  const invalidInputs = [
    [{ summary: "No operations." }, "change-empty"],
    [{
      summary: "Duplicate writes.",
      writes: [
        { path: retrievalPath, body: "# One\n" },
        { path: retrievalPath, body: "# Two\n" },
      ],
    }, "change-path-collision"],
    [{
      summary: "Write overlaps a move source.",
      writes: [{ path: dailyPath, body: "# Daily\n\nChanged.\n" }],
      moves: [{ from: dailyPath, to: archivePath }],
    }, "change-path-collision"],
    [{
      summary: "Write overlaps a move destination.",
      writes: [{ path: archivePath, body: "# Archive\n\nCreated.\n" }],
      moves: [{ from: dailyPath, to: archivePath }],
    }, "change-path-collision"],
    [{
      summary: "Ancestor write overlaps a child write.",
      writes: [
        { path: "00-inbox/daily-notes/draft", body: "# Draft\n" },
        { path: "00-inbox/daily-notes/draft/note.md", body: "# Child\n" },
      ],
    }, "change-path-collision"],
    [{
      summary: "Child write overlaps an ancestor write.",
      writes: [
        { path: "00-inbox/daily-notes/draft/note.md", body: "# Child\n" },
        { path: "00-inbox/daily-notes/draft", body: "# Draft\n" },
      ],
    }, "change-path-collision"],
    [{
      summary: "Write overlaps a move destination ancestor.",
      writes: [{ path: "99-archive/daily-notes", body: "# Archive directory collision\n" }],
      moves: [{ from: dailyPath, to: archivePath }],
    }, "change-path-collision"],
    [{
      summary: "Explicit homepage overlaps its derived homepage.",
      writes: [
        { path: "02-knowledge/ai/search/derived-note.md", body: "# Derived Note\n\nSearch detail.\n" },
        { path: "02-knowledge/ai/search/_search.md", body: "# Hand-authored homepage\n\n## Notes\n\nHuman context.\n" },
      ],
    }, "change-path-collision"],
    [{
      summary: "Move destination overlaps a derived homepage.",
      moves: [{ from: "02-knowledge/ai/search/source.md", to: "02-knowledge/ai/search/_search.md" }],
    }, "change-path-collision"],
    [{
      summary: "Traversal.",
      writes: [{ path: "../outside.md", body: "# Unsafe\n" }],
    }, "path-traversal"],
    [{
      summary: "Private path.",
      writes: [{ path: "07-system/secrets/token.md", body: "# Unsafe\n" }],
    }, "private-path"],
    [{
      summary: "Symlink path.",
      writes: [{ path: symlinkPath, body: "# Unsafe\n" }],
    }, "symlink"],
    [{
      summary: "Malformed body.",
      writes: [{ path: retrievalPath, body: "" }],
    }, "invalid-arguments"],
    [{
      summary: "External move.",
      moves: [{ from: dailyPath, to: outside }],
    }, "outside-vault"],
    [{
      summary: "Deletion is unsupported.",
      deletes: [dailyPath],
    }, "change-delete-unsupported"],
    [{
      summary: "External deletion is unsupported.",
      pathActions: [{ type: "delete-file", scope: "external", path: outside }],
    }, "change-delete-unsupported"],
  ];

  for (const [input, expectedCode] of invalidInputs) {
    const created = api.createChange(environment, input);
    assert.equal(created.ok, false, JSON.stringify(created));
    assert.equal(created.error.code, expectedCode);
    assert.doesNotMatch(JSON.stringify(created.error), /CHANGE-LIFECYCLE-SECRET-CANARY/);
    if (expectedCode === "private-path") {
      assert.equal(created.error.path, undefined);
      assert.doesNotMatch(JSON.stringify(created.error), /token\.md/);
    }
  }

  const listed = api.listChanges(environment);
  assert.equal(listed.ok, true, JSON.stringify(listed.error));
  assert.deepEqual(listed.value.items, []);
});

test("create refuses a post-classification symlink swap without reading the external canary", () => {
  const fixture = makeFixture();
  const environment = environmentFor(fixture.frameworkRoot);
  const api = loadBuiltPackage();
  const canary = "CREATE-SYMLINK-SWAP-SECRET-CANARY";
  const outside = path.join(tmpdir("dreamers-note-create-symlink-race"), "outside.md");
  writeText(outside, `${canary}\n`);

  process.env.DREAMERS_NOTE_TEST_SWAP_CREATE_TARGET_WITH_SYMLINK = `${retrievalPath}::${outside}`;
  let created;
  try {
    created = api.createChange(environment, {
      summary: "Refuse a changed target before materializing a pending change.",
      writes: [{ path: retrievalPath, body: "# Planned replacement\n\nDo not read the swapped target.\n" }],
    });
  } finally {
    delete process.env.DREAMERS_NOTE_TEST_SWAP_CREATE_TARGET_WITH_SYMLINK;
  }

  assert.equal(created.ok, false, JSON.stringify(created));
  assert.equal(created.error.code, "change-target-invalid");
  assert.doesNotMatch(JSON.stringify(created), new RegExp(canary));
  const listed = api.listChanges(environment);
  assert.equal(listed.ok, true, JSON.stringify(listed.error));
  assert.deepEqual(listed.value.items, []);
});

test("create refuses a post-scan directory-planner symlink swap without reading the external canary", () => {
  const fixture = makeFixture();
  const environment = environmentFor(fixture.frameworkRoot);
  const api = loadBuiltPackage();
  const canary = "DIRECTORY-PLANNER-SYMLINK-SWAP-SECRET-CANARY";
  const outside = path.join(tmpdir("dreamers-note-directory-symlink-race"), "outside.md");
  writeText(outside, `${canary}\n`);
  const plannerSource = "02-knowledge/ai/search/source.md";

  process.env.DREAMERS_NOTE_TEST_SWAP_DIRECTORY_INDEX_ENTRY_WITH_SYMLINK = `${plannerSource}::${outside}`;
  let created;
  try {
    created = api.createChange(environment, {
      summary: "Refuse an unsafe planner entry before a derived homepage is materialized.",
      writes: [{
        path: retrievalPath,
        body: "# Planned replacement\n\nDo not read the swapped planner entry.\n",
      }],
    });
  } finally {
    delete process.env.DREAMERS_NOTE_TEST_SWAP_DIRECTORY_INDEX_ENTRY_WITH_SYMLINK;
  }

  assert.equal(created.ok, false, JSON.stringify(created));
  assert.equal(created.error.code, "directory-index-scan-failed");
  assert.doesNotMatch(JSON.stringify(created), new RegExp(canary));
  const listed = api.listChanges(environment);
  assert.equal(listed.ok, true, JSON.stringify(listed.error));
  assert.deepEqual(listed.value.items, []);
});

test("list is metadata-only and show supplies a bounded current diff and validation state", () => {
  const fixture = makeFixture();
  const environment = environmentFor(fixture.frameworkRoot);
  const api = loadBuiltPackage();
  const body = `# Retrieval Core\n\n${"bounded change evidence ".repeat(1_000)}\n`;
  const created = pendingChange(api, environment, fixture, {
    summary: "Keep show previews bounded.",
    writes: [{ path: retrievalPath, body }],
    moves: [],
  });

  const listed = api.listChanges(environment);
  assert.equal(listed.ok, true, JSON.stringify(listed.error));
  assert.equal(listed.value.items.length, 1);
  assert.equal(Object.hasOwn(listed.value.items[0], "writes"), false);
  assert.doesNotMatch(JSON.stringify(listed.value.items), /bounded change evidence/);

  const shown = api.showChange(environment, created.id);
  assert.equal(shown.ok, true, JSON.stringify(shown.error));
  assert.equal(shown.value.validation.state, "current");
  assert.equal(shown.value.diff.text.length <= 12_000, true);
  assert.equal(shown.value.diff.truncated, true);
  assert.equal(Object.hasOwn(shown.value.change.writes[0], "body"), false);
});

test("apply commits writes, moves, derived homepages, and refreshed index entries before redacting the terminal record", () => {
  const fixture = makeFixture();
  const environment = environmentFor(fixture.frameworkRoot);
  const api = loadBuiltPackage();
  const created = pendingChange(api, environment, fixture);

  const applied = api.applyChange(environment, { id: created.id, revision: created.revision });
  assert.equal(applied.ok, true, JSON.stringify(applied.error));
  assert.equal(applied.value.status, "applied");
  assert.equal(applied.value.changedPaths.includes(retrievalPath), true);
  assert.match(fixture.readVaultText(retrievalPath), /Updated retrieval guidance/);
  assert.equal(fs.existsSync(fixture.pathInVault(dailyPath)), false);
  assert.match(fixture.readVaultText(archivePath), /Capture to archive atomically/);
  assert.equal(created.derivedPaths.every((relativePath) => fs.existsSync(fixture.pathInVault(relativePath))), true);

  const search = api.searchContext(environment, { query: "updated retrieval guidance", limit: 4 });
  assert.equal(search.ok, true, JSON.stringify(search.error));
  assert.equal(search.value.results.some((result) => result.path === retrievalPath), true);

  const shown = api.showChange(environment, created.id);
  assert.equal(shown.ok, true, JSON.stringify(shown.error));
  assert.equal(shown.value.change.status, "applied");
  assert.match(shown.value.diff.text, /redacted/i);
  const row = rawChangeRow(runtimeDatabasePath(fixture.frameworkRoot), created.id);
  assert.equal(row.status, "applied");
  assert.doesNotMatch(`${row.writes}\n${row.diff_text}`, /Updated retrieval guidance/);

  const secondApply = api.applyChange(environment, { id: created.id, revision: created.revision });
  assert.equal(secondApply.ok, false);
  assert.equal(secondApply.error.code, "change-not-pending");
});

test("apply refuses revision, target, source, destination, branch, git, taxonomy, and exclusion drift without mutation", () => {
  const scenarios = [
    {
      name: "revision",
      expectedCode: "change-revision-mismatch",
      mutate({ created }) {
        created.revision = "0".repeat(64);
      },
    },
    {
      name: "target",
      expectedCode: "change-target-changed",
      mutate({ fixture }) {
        fixture.writeVaultText(retrievalPath, "# Retrieval Core\n\nTarget drift.\n");
      },
    },
    {
      name: "source",
      expectedCode: "change-source-changed",
      mutate({ fixture }) {
        fixture.writeVaultText(dailyPath, "# Daily\n\nSource drift.\n");
      },
    },
    {
      name: "destination",
      expectedCode: "change-destination-changed",
      mutate({ fixture }) {
        fixture.writeVaultText(archivePath, "# Archive\n\nDestination collision.\n");
      },
    },
    {
      name: "branch",
      expectedCode: "change-branch-changed",
      mutate({ fixture }) {
        fixture.git(["checkout", "-qb", "change-drift-branch"], { check: true });
      },
    },
    {
      name: "git",
      expectedCode: "change-git-state-changed",
      mutate({ fixture }) {
        fixture.writeVaultText("02-knowledge/ai/search/unrelated.md", "# Unrelated\n\nGit drift.\n");
      },
    },
    {
      name: "taxonomy",
      expectedCode: "change-taxonomy-changed",
      mutate({ environment }) {
        environment.approvedTags = ["different"];
      },
    },
    {
      name: "exclusion",
      expectedCode: "change-exclusion-config-changed",
      mutate({ environment }) {
        environment.privateGlobs = [...environment.privateGlobs, "01-projects/**"];
      },
    },
  ];

  for (const scenario of scenarios) {
    const fixture = makeFixture();
    const environment = environmentFor(fixture.frameworkRoot);
    const api = loadBuiltPackage();
    const created = pendingChange(api, environment, fixture);
    scenario.mutate({ fixture, environment, created });
    assertApplyRefused(api, environment, fixture, created, scenario.expectedCode);
  }
});

test("mutation and refresh faults restore all bytes, repair the index, and leave the change pending with a bounded failure", () => {
  const fixture = makeFixture();
  const environment = environmentFor(fixture.frameworkRoot);
  const api = loadBuiltPackage();
  const created = pendingChange(api, environment, fixture);
  const before = snapshotVaultContent(fixture.vaultPath);

  process.env.DREAMERS_NOTE_TEST_FAIL_AFTER_WRITE = "after-refresh";
  try {
    const applied = api.applyChange(environment, { id: created.id, revision: created.revision });
    assert.equal(applied.ok, false, JSON.stringify(applied));
    assert.equal(applied.error.code, "change-apply-failed");
  } finally {
    delete process.env.DREAMERS_NOTE_TEST_FAIL_AFTER_WRITE;
  }

  assert.deepEqual(snapshotVaultContent(fixture.vaultPath), before);
  const shown = api.showChange(environment, created.id);
  assert.equal(shown.ok, true, JSON.stringify(shown.error));
  assert.equal(shown.value.change.status, "pending");
  assert.equal(shown.value.change.lastError.code, "change-apply-failed");
  const search = api.searchContext(environment, { query: "Capture to archive atomically", limit: 4 });
  assert.equal(search.ok, true, JSON.stringify(search.error));
  assert.equal(search.value.results.some((result) => result.path === dailyPath), true);
});

test("a write fault after truncate restores the original bytes and keeps the change pending", () => {
  const fixture = makeFixture();
  const environment = environmentFor(fixture.frameworkRoot);
  const api = loadBuiltPackage();
  const created = pendingChange(api, environment, fixture);
  const before = snapshotVaultContent(fixture.vaultPath);

  process.env.DREAMERS_NOTE_TEST_FAIL_AFTER_WRITE = "after-truncate";
  try {
    const applied = api.applyChange(environment, { id: created.id, revision: created.revision });
    assert.equal(applied.ok, false, JSON.stringify(applied));
    assert.equal(applied.error.code, "change-apply-failed");
  } finally {
    delete process.env.DREAMERS_NOTE_TEST_FAIL_AFTER_WRITE;
  }

  assert.deepEqual(snapshotVaultContent(fixture.vaultPath), before);
  const shown = api.showChange(environment, created.id);
  assert.equal(shown.ok, true, JSON.stringify(shown.error));
  assert.equal(shown.value.change.status, "pending");
  assert.equal(shown.value.change.lastError.code, "change-apply-failed");
});

test("setup faults after nested directory or leaf creation leave no partial vault tree", () => {
  for (const stage of ["directory-created", "leaf-created"]) {
    const fixture = makeFixture();
    const environment = environmentFor(fixture.frameworkRoot);
    const api = loadBuiltPackage();
    const targetPath = `00-inbox/setup-fault/${stage}/new-note.md`;
    const created = api.createChange(environment, {
      summary: `Exercise ${stage} rollback journaling.`,
      writes: [{ path: targetPath, body: "# Setup Fault\n\nNo partial tree may remain.\n" }],
    });
    assert.equal(created.ok, true, JSON.stringify(created.error));
    const before = snapshotVaultContent(fixture.vaultPath);

    process.env.DREAMERS_NOTE_TEST_FAIL_AFTER_SETUP = stage;
    try {
      const applied = api.applyChange(environment, { id: created.value.id, revision: created.value.revision });
      assert.equal(applied.ok, false, JSON.stringify(applied));
      assert.equal(applied.error.code, "change-apply-failed");
    } finally {
      delete process.env.DREAMERS_NOTE_TEST_FAIL_AFTER_SETUP;
    }

    assert.deepEqual(snapshotVaultContent(fixture.vaultPath), before);
    assert.equal(fs.existsSync(fixture.pathInVault("00-inbox/setup-fault")), false);
    const shown = api.showChange(environment, created.value.id);
    assert.equal(shown.ok, true, JSON.stringify(shown.error));
    assert.equal(shown.value.change.status, "pending");
    assert.equal(shown.value.change.lastError.code, "change-apply-failed");
  }
});

test("a move destination-parent setup fault leaves the source and vault tree unchanged", () => {
  const fixture = makeFixture();
  const environment = environmentFor(fixture.frameworkRoot);
  const api = loadBuiltPackage();
  const created = api.createChange(environment, {
    summary: "Archive one daily capture without retaining a partially created destination parent.",
    moves: [{ from: dailyPath, to: archivePath }],
  });
  assert.equal(created.ok, true, JSON.stringify(created.error));
  const before = snapshotVaultContent(fixture.vaultPath);

  process.env.DREAMERS_NOTE_TEST_FAIL_AFTER_SETUP = "directory-created";
  try {
    const applied = api.applyChange(environment, { id: created.value.id, revision: created.value.revision });
    assert.equal(applied.ok, false, JSON.stringify(applied));
    assert.equal(applied.error.code, "change-apply-failed");
  } finally {
    delete process.env.DREAMERS_NOTE_TEST_FAIL_AFTER_SETUP;
  }

  assert.deepEqual(snapshotVaultContent(fixture.vaultPath), before);
  assert.equal(fs.existsSync(fixture.pathInVault("99-archive/daily-notes")), false);
});

test("terminal persistence failure rolls back vault bytes while the lifecycle lock still owns the change", () => {
  const fixture = makeFixture();
  const environment = environmentFor(fixture.frameworkRoot);
  const api = loadBuiltPackage();
  const created = pendingChange(api, environment, fixture);
  const before = snapshotVaultContent(fixture.vaultPath);

  process.env.DREAMERS_NOTE_TEST_FAIL_CHANGE_FINALIZATION = "1";
  try {
    const applied = api.applyChange(environment, { id: created.id, revision: created.revision });
    assert.equal(applied.ok, false, JSON.stringify(applied));
    assert.equal(applied.error.code, "change-apply-failed");
  } finally {
    delete process.env.DREAMERS_NOTE_TEST_FAIL_CHANGE_FINALIZATION;
  }

  assert.deepEqual(snapshotVaultContent(fixture.vaultPath), before);
  const shown = api.showChange(environment, created.id);
  assert.equal(shown.ok, true, JSON.stringify(shown.error));
  assert.equal(shown.value.change.status, "pending");
  assert.equal(shown.value.change.lastError.code, "change-apply-failed");

  const retried = api.applyChange(environment, { id: created.id, revision: created.revision });
  assert.equal(retried.ok, true, JSON.stringify(retried.error));
});

test("rollback preserves concurrent replacements of an existing write or moved destination", () => {
  const scenarios = [
    {
      name: "existing write",
      racePath: dailyPath,
      failureStage: "1",
      create(api, environment) {
        return api.createChange(environment, {
          summary: "Replace a daily note without overwriting a concurrent replacement during rollback.",
          writes: [{ path: dailyPath, body: "# Planned daily replacement\n" }],
        });
      },
      assertRestored(fixture, concurrentBody) {
        assert.equal(fixture.readVaultText(dailyPath), concurrentBody);
      },
    },
    {
      name: "moved destination",
      racePath: archivePath,
      failureStage: "after-path-actions",
      create(api, environment) {
        return api.createChange(environment, {
          summary: "Move one daily note without deleting a concurrent destination during rollback.",
          moves: [{ from: dailyPath, to: archivePath }],
        });
      },
      assertRestored(fixture, concurrentBody) {
        assert.match(fixture.readVaultText(dailyPath), /Capture to archive atomically/);
        assert.equal(fixture.readVaultText(archivePath), concurrentBody);
      },
    },
    {
      name: "moved source",
      racePath: dailyPath,
      failureStage: "after-path-actions",
      create(api, environment) {
        return api.createChange(environment, {
          summary: "Move one daily note without overwriting a concurrent source recreation during rollback.",
          moves: [{ from: dailyPath, to: archivePath }],
        });
      },
      assertRestored(fixture, concurrentBody) {
        assert.equal(fixture.readVaultText(dailyPath), concurrentBody);
        assert.equal(fs.existsSync(fixture.pathInVault(archivePath)), false);
      },
    },
  ];

  for (const scenario of scenarios) {
    const fixture = makeFixture();
    const environment = environmentFor(fixture.frameworkRoot);
    const api = loadBuiltPackage();
    const concurrentBody = `# Concurrent ${scenario.name}\n\nKeep these bytes.\n`;
    const created = scenario.create(api, environment);
    assert.equal(created.ok, true, JSON.stringify(created.error));

    process.env.DREAMERS_NOTE_TEST_SWAP_ROLLBACK_TARGET_WITH_CONTENT = `${scenario.racePath}::${concurrentBody}`;
    process.env.DREAMERS_NOTE_TEST_FAIL_AFTER_WRITE = scenario.failureStage;
    try {
      const applied = api.applyChange(environment, { id: created.value.id, revision: created.value.revision });
      assert.equal(applied.ok, false, JSON.stringify(applied));
      assert.equal(applied.error.code, "change-rollback-failed", scenario.name);
      assert.equal(
        applied.error.causes?.some((cause) =>
          cause.code === "change-rollback-affected" && cause.path === scenario.racePath,
        ),
        true,
      );
      assert.doesNotMatch(JSON.stringify(applied.error), /Keep these bytes/);
    } finally {
      delete process.env.DREAMERS_NOTE_TEST_SWAP_ROLLBACK_TARGET_WITH_CONTENT;
      delete process.env.DREAMERS_NOTE_TEST_FAIL_AFTER_WRITE;
    }

    scenario.assertRestored(fixture, concurrentBody);
    const shown = api.showChange(environment, created.value.id);
    assert.equal(shown.ok, true, JSON.stringify(shown.error));
    assert.equal(shown.value.change.status, "pending");
    assert.equal(shown.value.change.lastError.code, "change-rollback-failed");
    assert.equal(shown.value.change.lastError.affectedPaths.includes(scenario.racePath), true);
    assert.doesNotMatch(JSON.stringify(shown.value.change.lastError), /Keep these bytes/);
  }
});

test("rollback preserves a same-inode edit that appears after truncate", () => {
  const fixture = makeFixture();
  const environment = environmentFor(fixture.frameworkRoot);
  const api = loadBuiltPackage();
  const concurrentBody = "# Concurrent after truncate\n\nKeep these bytes.\n";
  const created = api.createChange(environment, {
    summary: "Replace one daily note without overwriting a same-inode edit after truncate.",
    writes: [{ path: dailyPath, body: "# Planned daily replacement\n" }],
  });
  assert.equal(created.ok, true, JSON.stringify(created.error));

  process.env.DREAMERS_NOTE_TEST_SWAP_TARGET_AFTER_TRUNCATE_WITH_CONTENT = `${dailyPath}::${concurrentBody}`;
  process.env.DREAMERS_NOTE_TEST_FAIL_AFTER_WRITE = "after-truncate";
  try {
    const applied = api.applyChange(environment, { id: created.value.id, revision: created.value.revision });
    assert.equal(applied.ok, false, JSON.stringify(applied));
    assert.equal(applied.error.code, "change-rollback-failed");
    assert.equal(
      applied.error.causes?.some((cause) =>
        cause.code === "change-rollback-affected" && cause.path === dailyPath,
      ),
      true,
    );
    assert.doesNotMatch(JSON.stringify(applied.error), /Keep these bytes/);
  } finally {
    delete process.env.DREAMERS_NOTE_TEST_SWAP_TARGET_AFTER_TRUNCATE_WITH_CONTENT;
    delete process.env.DREAMERS_NOTE_TEST_FAIL_AFTER_WRITE;
  }

  assert.equal(fixture.readVaultText(dailyPath), concurrentBody);
});

test("rollback preserves a same-inode edit of a moved destination", () => {
  const fixture = makeFixture();
  const environment = environmentFor(fixture.frameworkRoot);
  const api = loadBuiltPackage();
  const concurrentBody = "# Concurrent moved destination\n\nKeep these bytes.\n";
  const created = api.createChange(environment, {
    summary: "Archive one daily note without overwriting a same-inode destination edit during rollback.",
    moves: [{ from: dailyPath, to: archivePath }],
  });
  assert.equal(created.ok, true, JSON.stringify(created.error));

  process.env.DREAMERS_NOTE_TEST_MUTATE_ROLLBACK_TARGET_WITH_CONTENT = `${archivePath}::${concurrentBody}`;
  process.env.DREAMERS_NOTE_TEST_FAIL_AFTER_WRITE = "after-path-actions";
  try {
    const applied = api.applyChange(environment, { id: created.value.id, revision: created.value.revision });
    assert.equal(applied.ok, false, JSON.stringify(applied));
    assert.equal(applied.error.code, "change-rollback-failed");
    assert.equal(
      applied.error.causes?.some((cause) =>
        cause.code === "change-rollback-affected" && cause.path === archivePath,
      ),
      true,
    );
    assert.doesNotMatch(JSON.stringify(applied.error), /Keep these bytes/);
  } finally {
    delete process.env.DREAMERS_NOTE_TEST_MUTATE_ROLLBACK_TARGET_WITH_CONTENT;
    delete process.env.DREAMERS_NOTE_TEST_FAIL_AFTER_WRITE;
  }

  assert.match(fixture.readVaultText(dailyPath), /Capture to archive atomically/);
  assert.equal(fixture.readVaultText(archivePath), concurrentBody);
});

test("rollback preserves edits that race ownership journaling after a write or move", () => {
  const scenarios = [
    {
      name: "write",
      racePath: dailyPath,
      failureStage: "1",
      create(api, environment) {
        return api.createChange(environment, {
          summary: "Replace one daily note without accepting a post-write ownership-journal race.",
          writes: [{ path: dailyPath, body: "# Planned daily replacement\n" }],
        });
      },
      assertState(fixture, concurrentBody) {
        assert.equal(fixture.readVaultText(dailyPath), concurrentBody);
      },
    },
    {
      name: "move",
      racePath: archivePath,
      failureStage: "after-path-actions",
      create(api, environment) {
        return api.createChange(environment, {
          summary: "Archive one daily note without accepting a post-move ownership-journal race.",
          moves: [{ from: dailyPath, to: archivePath }],
        });
      },
      assertState(fixture, concurrentBody) {
        assert.match(fixture.readVaultText(dailyPath), /Capture to archive atomically/);
        assert.equal(fixture.readVaultText(archivePath), concurrentBody);
      },
    },
  ];

  for (const scenario of scenarios) {
    const fixture = makeFixture();
    const environment = environmentFor(fixture.frameworkRoot);
    const api = loadBuiltPackage();
    const concurrentBody = `# Concurrent ${scenario.name} journal race\n\nKeep these bytes.\n`;
    const created = scenario.create(api, environment);
    assert.equal(created.ok, true, JSON.stringify(created.error));

    process.env.DREAMERS_NOTE_TEST_MUTATE_TARGET_BEFORE_OWNERSHIP_JOURNAL = `${scenario.racePath}::${concurrentBody}`;
    process.env.DREAMERS_NOTE_TEST_FAIL_AFTER_WRITE = scenario.failureStage;
    try {
      const applied = api.applyChange(environment, { id: created.value.id, revision: created.value.revision });
      assert.equal(applied.ok, false, JSON.stringify(applied));
      assert.equal(applied.error.code, "change-rollback-failed");
      assert.equal(
        applied.error.causes?.some((cause) =>
          cause.code === "change-rollback-affected" && cause.path === scenario.racePath,
        ),
        true,
      );
      assert.doesNotMatch(JSON.stringify(applied.error), /Keep these bytes/);
    } finally {
      delete process.env.DREAMERS_NOTE_TEST_MUTATE_TARGET_BEFORE_OWNERSHIP_JOURNAL;
      delete process.env.DREAMERS_NOTE_TEST_FAIL_AFTER_WRITE;
    }

    scenario.assertState(fixture, concurrentBody);
  }
});

test("apply detects a regular-file write race immediately before mutation and leaves the raced bytes pending", () => {
  const fixture = makeFixture();
  const environment = environmentFor(fixture.frameworkRoot);
  const api = loadBuiltPackage();
  const created = api.createChange(environment, {
    summary: "Replace the daily note without overwriting a concurrent edit.",
    writes: [{ path: dailyPath, body: "# Daily\n\nPlanned replacement.\n" }],
  });
  assert.equal(created.ok, true, JSON.stringify(created.error));
  const racedBody = "# Daily\n\nConcurrent editor bytes must survive.\n";

  process.env.DREAMERS_NOTE_TEST_SWAP_TARGET_WITH_CONTENT = `${dailyPath}::${racedBody}`;
  try {
    const applied = api.applyChange(environment, { id: created.value.id, revision: created.value.revision });
    assert.equal(applied.ok, false, JSON.stringify(applied));
    assert.equal(applied.error.code, "change-target-changed");
  } finally {
    delete process.env.DREAMERS_NOTE_TEST_SWAP_TARGET_WITH_CONTENT;
  }

  assert.equal(fixture.readVaultText(dailyPath), racedBody);
  const shown = api.showChange(environment, created.value.id);
  assert.equal(shown.ok, true, JSON.stringify(shown.error));
  assert.equal(shown.value.change.status, "pending");
});

test("descriptor-bound mutation checks refuse post-hash write, move-source, and move-destination races", () => {
  const scenarios = [
    {
      name: "write",
      targetPath: dailyPath,
      expectedCode: "change-target-changed",
      create(api, environment) {
        return api.createChange(environment, {
          summary: "Replace a daily note without accepting a post-check swap.",
          writes: [{ path: dailyPath, body: "# Daily\n\nPlanned replacement.\n" }],
        });
      },
      assertRaced(fixture, racedBody) {
        assert.equal(fixture.readVaultText(dailyPath), racedBody);
      },
    },
    {
      name: "move source",
      targetPath: dailyPath,
      expectedCode: "change-source-changed",
      create(api, environment, fixture) {
        return api.createChange(environment, {
          summary: "Move a daily note without accepting a post-check source swap.",
          writes: [{
            path: retrievalPath,
            body: fixture.readVaultText(retrievalPath).replace("Original retrieval guidance.", "Updated retrieval guidance for the change lifecycle."),
          }],
          moves: [{ from: dailyPath, to: archivePath }],
        });
      },
      assertRaced(fixture, racedBody) {
        assert.equal(fixture.readVaultText(dailyPath), racedBody);
        assert.equal(fs.existsSync(fixture.pathInVault(archivePath)), false);
      },
    },
    {
      name: "move destination",
      targetPath: archivePath,
      expectedCode: "change-destination-changed",
      create(api, environment, fixture) {
        return api.createChange(environment, {
          summary: "Move a daily note without accepting a post-check destination swap.",
          writes: [{
            path: retrievalPath,
            body: fixture.readVaultText(retrievalPath).replace("Original retrieval guidance.", "Updated retrieval guidance for the change lifecycle."),
          }],
          moves: [{ from: dailyPath, to: archivePath }],
        });
      },
      assertRaced(fixture, racedBody) {
        assert.equal(fixture.readVaultText(archivePath), racedBody);
        assert.match(fixture.readVaultText(dailyPath), /Capture to archive atomically/);
      },
    },
  ];

  for (const scenario of scenarios) {
    const fixture = makeFixture();
    const environment = environmentFor(fixture.frameworkRoot);
    const api = loadBuiltPackage();
    const created = scenario.create(api, environment, fixture);
    assert.equal(created.ok, true, `${scenario.name}: ${JSON.stringify(created.error)}`);
    const racedBody = `# Concurrent ${scenario.name}\n\nThese bytes must survive.\n`;

    process.env.DREAMERS_NOTE_TEST_SWAP_TARGET_AFTER_HASH_WITH_CONTENT = `${scenario.targetPath}::${racedBody}`;
    try {
      const applied = api.applyChange(environment, { id: created.value.id, revision: created.value.revision });
      assert.equal(applied.ok, false, `${scenario.name}: ${JSON.stringify(applied)}`);
      assert.equal(applied.error.code, scenario.expectedCode);
    } finally {
      delete process.env.DREAMERS_NOTE_TEST_SWAP_TARGET_AFTER_HASH_WITH_CONTENT;
    }

    scenario.assertRaced(fixture, racedBody);
    const shown = api.showChange(environment, created.value.id);
    assert.equal(shown.ok, true, `${scenario.name}: ${JSON.stringify(shown.error)}`);
    assert.equal(shown.value.change.status, "pending");
  }
});

test("a post-hash replacement of a newly created target survives refusal cleanup", () => {
  const fixture = makeFixture();
  const environment = environmentFor(fixture.frameworkRoot);
  const api = loadBuiltPackage();
  const targetPath = "00-inbox/daily-notes/post-hash-created-race.md";
  const concurrentBody = "# Concurrent replacement\n\nKeep these bytes.\n";
  const created = api.createChange(environment, {
    summary: "Create one daily note without removing a concurrent replacement after refusal.",
    writes: [{ path: targetPath, body: "# Planned note\n\nDo not replace concurrent bytes.\n" }],
  });
  assert.equal(created.ok, true, JSON.stringify(created.error));

  process.env.DREAMERS_NOTE_TEST_SWAP_TARGET_AFTER_HASH_WITH_CONTENT = `${targetPath}::${concurrentBody}`;
  try {
    const applied = api.applyChange(environment, { id: created.value.id, revision: created.value.revision });
    assert.equal(applied.ok, false, JSON.stringify(applied));
    assert.equal(applied.error.code, "change-target-exists");
  } finally {
    delete process.env.DREAMERS_NOTE_TEST_SWAP_TARGET_AFTER_HASH_WITH_CONTENT;
  }

  assert.equal(fixture.readVaultText(targetPath), concurrentBody);
  const shown = api.showChange(environment, created.value.id);
  assert.equal(shown.ok, true, JSON.stringify(shown.error));
  assert.equal(shown.value.change.status, "pending");
});

test("policy drift redacts pending change details instead of exposing newly excluded paths or content", () => {
  const fixture = makeFixture();
  const environment = environmentFor(fixture.frameworkRoot);
  const api = loadBuiltPackage();
  const created = pendingChange(api, environment, fixture);
  environment.privateGlobs = [...environment.privateGlobs, "01-projects/**"];

  const listed = api.listChanges(environment);
  assert.equal(listed.ok, true, JSON.stringify(listed.error));
  assert.deepEqual(listed.value.items[0].changedPaths, []);
  assert.deepEqual(listed.value.items[0].derivedPaths, []);
  assert.doesNotMatch(JSON.stringify(listed.value.items[0]), /retrieval-core\.md|Updated retrieval guidance/);

  const shown = api.showChange(environment, created.id);
  assert.equal(shown.ok, true, JSON.stringify(shown.error));
  assert.equal(shown.value.validation.state, "blocked");
  assert.deepEqual(shown.value.change.writes, []);
  assert.deepEqual(shown.value.change.moves, []);
  assert.deepEqual(shown.value.change.derivedPaths, []);
  assert.doesNotMatch(JSON.stringify(shown.value), /retrieval-core\.md|Updated retrieval guidance/);

  const applied = api.applyChange(environment, { id: created.id, revision: created.revision });
  assert.equal(applied.ok, false, JSON.stringify(applied));
  assert.equal(applied.error.code, "change-exclusion-config-changed");
  assert.doesNotMatch(JSON.stringify(applied.error), /retrieval-core\.md|Updated retrieval guidance/);
});

test("apply returns a deterministic writer-lock error without changing the pending change", () => {
  const fixture = makeFixture();
  const environment = environmentFor(fixture.frameworkRoot);
  const api = loadBuiltPackage();
  const created = pendingChange(api, environment, fixture);
  const lockPath = path.join(environment.runtimeDir, "proposal-apply.lock");
  writeText(lockPath, JSON.stringify({ pid: 999_999, createdAt: new Date().toISOString() }));

  try {
    assertApplyRefused(api, environment, fixture, created, "change-apply-locked");
  } finally {
    fs.unlinkSync(lockPath);
  }
});

test("an old lock owned by a live process is retained while an old dead lock is safely reclaimed", () => {
  const fixture = makeFixture();
  const environment = environmentFor(fixture.frameworkRoot);
  const api = loadBuiltPackage();
  const created = pendingChange(api, environment, fixture);
  const lockPath = path.join(environment.runtimeDir, "proposal-apply.lock");
  const oldTime = new Date("2000-01-01T00:00:00Z");
  writeText(lockPath, JSON.stringify({ pid: process.pid, createdAt: oldTime.toISOString() }));
  fs.utimesSync(lockPath, oldTime, oldTime);

  try {
    assertApplyRefused(api, environment, fixture, created, "change-apply-locked");
    assert.equal(fs.existsSync(lockPath), true);
  } finally {
    fs.unlinkSync(lockPath);
  }

  writeText(lockPath, JSON.stringify({ pid: 999_999, createdAt: oldTime.toISOString() }));
  fs.utimesSync(lockPath, oldTime, oldTime);
  const applied = api.applyChange(environment, { id: created.id, revision: created.revision });
  assert.equal(applied.ok, true, JSON.stringify(applied.error));
  assert.equal(fs.existsSync(lockPath), false);
});

test("reject redacts terminal bodies and diff text, then deterministically rejects further lifecycle actions", () => {
  const fixture = makeFixture();
  const environment = environmentFor(fixture.frameworkRoot);
  const api = loadBuiltPackage();
  const created = pendingChange(api, environment, fixture);

  const rejected = api.rejectChange(environment, created.id);
  assert.equal(rejected.ok, true, JSON.stringify(rejected.error));
  assert.equal(rejected.value.status, "rejected");
  const shown = api.showChange(environment, created.id);
  assert.equal(shown.ok, true, JSON.stringify(shown.error));
  assert.equal(shown.value.change.status, "rejected");
  assert.match(shown.value.diff.text, /redacted/i);
  const row = rawChangeRow(runtimeDatabasePath(fixture.frameworkRoot), created.id);
  assert.doesNotMatch(`${row.writes}\n${row.diff_text}`, /Updated retrieval guidance/);

  const secondReject = api.rejectChange(environment, created.id);
  assert.equal(secondReject.ok, false);
  assert.equal(secondReject.error.code, "change-not-pending");
  const applied = api.applyChange(environment, { id: created.id, revision: created.revision });
  assert.equal(applied.ok, false);
  assert.equal(applied.error.code, "change-not-pending");
});

test("reject serializes with the same writer lock as apply before redacting a terminal change", () => {
  const fixture = makeFixture();
  const environment = environmentFor(fixture.frameworkRoot);
  const api = loadBuiltPackage();
  const created = pendingChange(api, environment, fixture);
  const lockPath = path.join(environment.runtimeDir, "proposal-apply.lock");
  writeText(lockPath, JSON.stringify({ pid: 999_999, createdAt: new Date().toISOString() }));

  try {
    const rejected = api.rejectChange(environment, created.id);
    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    assert.equal(rejected.error.code, "change-apply-locked");
    const shown = api.showChange(environment, created.id);
    assert.equal(shown.ok, true, JSON.stringify(shown.error));
    assert.equal(shown.value.change.status, "pending");
  } finally {
    fs.unlinkSync(lockPath);
  }

  const rejected = api.rejectChange(environment, created.id);
  assert.equal(rejected.ok, true, JSON.stringify(rejected.error));
  assert.equal(rejected.value.status, "rejected");
});

test("one daily-triage style write-plus-archive move applies atomically without bundle or authorization inputs", () => {
  const fixture = makeFixture();
  const environment = environmentFor(fixture.frameworkRoot);
  const api = loadBuiltPackage();
  const durablePath = "02-knowledge/ai/search/daily-extraction.md";
  const created = api.createChange(environment, {
    summary: "Extract the durable daily finding and archive the processed capture.",
    writes: [{
      path: durablePath,
      body: "# Daily Extraction\n\nThe extracted finding is now durable.\n",
    }],
    moves: [{ from: dailyPath, to: archivePath }],
  });
  assert.equal(created.ok, true, JSON.stringify(created.error));
  assert.equal(Object.hasOwn(created.value, "bundleId"), false);
  assert.equal(Object.hasOwn(created.value, "authorizationId"), false);

  const applied = api.applyChange(environment, { id: created.value.id, revision: created.value.revision });
  assert.equal(applied.ok, true, JSON.stringify(applied.error));
  assert.match(fixture.readVaultText(durablePath), /extracted finding/);
  assert.equal(fs.existsSync(fixture.pathInVault(dailyPath)), false);
  assert.match(fixture.readVaultText(archivePath), /Capture to archive atomically/);
});
