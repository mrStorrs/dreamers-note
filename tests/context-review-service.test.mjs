import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import {
  buildFixtureIndex,
  createProjectFixture,
  loadBuiltPackage,
  runtimeDatabasePath,
  snapshotVaultTree,
  tmpdir,
  writeBinary,
  writeRuntimeConfig,
  writeText,
} from "./helpers/project-fixtures.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const retrievalPath = "01-projects/ai/obsidian/retrieval-core.md";

function makeFixture(options = {}) {
  return createProjectFixture({
    vaultFiles: {
      [retrievalPath]: [
        "---",
        "tags: [ai, search]",
        "aliases: [Retrieval Engine]",
        "---",
        "# Retrieval Core",
        "",
        "Lexical retrieval keeps local evidence deterministic.",
        "It links to [[Knowledge Base]].",
        "",
        "## Ranking",
        "Backlink and heading evidence explain why retrieval matched.",
        "",
      ].join("\n"),
      "02-knowledge/ai/search/knowledge-base.md": [
        "---",
        "tags: [ai, search]",
        "---",
        "# Knowledge Base",
        "",
        "The linked knowledge base preserves lexical retrieval context and points to [[Retrieval Core|Retrieval Engine]].",
        "",
      ].join("\n"),
      "03-assets/diagrams/retrieval.png": "fixture image bytes\n",
      "07-system/secrets/token.md": "CONTEXT-SERVICE-SECRET-CANARY\n",
    },
    git: true,
    ...options,
  });
}

function environmentFor(frameworkRoot) {
  const { loadVaultEnvironment } = loadBuiltPackage();
  const environment = loadVaultEnvironment({ rootDir: frameworkRoot });
  assert.equal(environment.ok, true, JSON.stringify(environment.error));
  return environment.value;
}

function countRows(databasePath, tableName) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const exists = db.prepare("select 1 from sqlite_schema where type = 'table' and name = ?").get(tableName);
    if (!exists) {
      return 0;
    }
    return db.prepare(`select count(*) as count from ${tableName}`).get().count;
  } finally {
    db.close();
  }
}

test("shared vault environment exposes normalized runtime, policy, tags, and exclusions without MCP values", () => {
  const fixture = makeFixture();
  const environment = environmentFor(fixture.frameworkRoot);
  const { loadVaultEnvironment } = loadBuiltPackage();
  const invalid = loadVaultEnvironment({ rootDir: tmpdir("dreamers-note-invalid-environment") });
  const unsafeFixture = makeFixture();
  writeRuntimeConfig(unsafeFixture.frameworkRoot, {
    data_dir: unsafeFixture.vaultPath,
    private_globs: ["07-system/secrets/**"],
  });
  const unsafe = loadVaultEnvironment({ rootDir: unsafeFixture.frameworkRoot });

  assert.equal(environment.rootDir, fixture.frameworkRoot);
  assert.equal(environment.vaultPath, fixture.vaultPath);
  assert.equal(environment.databasePath, runtimeDatabasePath(fixture.frameworkRoot));
  assert.deepEqual(environment.approvedTags, ["ai", "health", "local-first", "obsidian", "recipes", "search"]);
  assert.deepEqual(environment.privateGlobs, ["07-system/secrets/**"]);
  assert.equal(environment.conventionPolicy.classifiedNoteRoots.includes("01-projects"), true);
  assert.equal(JSON.stringify(environment).toLowerCase().includes("mcp"), false);
  assert.equal(invalid.ok, false);
  assert.equal(typeof invalid.error.code, "string");
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.error.code, "runtime-config-unsafe-data-dir");
  assert.equal(fs.existsSync(path.join(unsafeFixture.vaultPath, "notes.db")), false);
});

test("context operations initialize stale and incompatible ignored caches without changing vault bytes or mtimes", () => {
  const fixture = makeFixture();
  const environment = environmentFor(fixture.frameworkRoot);
  const api = loadBuiltPackage();
  const before = snapshotVaultTree(fixture.vaultPath);

  const initial = api.searchContext(environment, { query: "lexical retrieval", limit: 4 });
  assert.equal(initial.ok, true, JSON.stringify(initial.error));
  assert.equal(initial.value.readiness.action, "initialize");
  assert.equal(fs.existsSync(runtimeDatabasePath(fixture.frameworkRoot)), true);
  assert.equal(initial.value.results.length > 0, true);
  assert.deepEqual(snapshotVaultTree(fixture.vaultPath), before);

  const ready = api.searchContext(environment, { query: "lexical retrieval", limit: 4 });
  assert.equal(ready.ok, true, JSON.stringify(ready.error));
  assert.equal(ready.value.readiness.action, "none");
  assert.deepEqual(snapshotVaultTree(fixture.vaultPath), before);

  fixture.writeVaultText("07-system/secrets/token.md", "UPDATED-CONTEXT-SERVICE-SECRET-CANARY\n");
  const excluded = api.searchContext(environment, { query: "UPDATED-CONTEXT-SERVICE-SECRET-CANARY", limit: 4 });
  assert.equal(excluded.ok, true, JSON.stringify(excluded.error));
  assert.equal(excluded.value.readiness.action, "none");
  assert.equal(excluded.value.results.length, 0);

  fixture.writeVaultText(retrievalPath, `${fixture.readVaultText(retrievalPath)}\nStale cache marker.\n`);
  const beforeStaleRefresh = snapshotVaultTree(fixture.vaultPath);
  const stale = api.searchContext(environment, { query: "stale cache marker", limit: 4 });
  assert.equal(stale.ok, true, JSON.stringify(stale.error));
  assert.equal(stale.value.readiness.action, "refresh");
  assert.equal(stale.value.results[0].path, retrievalPath);
  assert.deepEqual(snapshotVaultTree(fixture.vaultPath), beforeStaleRefresh);

  const db = new Database(runtimeDatabasePath(fixture.frameworkRoot));
  db.prepare("update meta set value = ? where key = 'schema_version'").run("incompatible");
  db.close();
  const beforeIncompatibleRebuild = snapshotVaultTree(fixture.vaultPath);
  const incompatible = api.searchContext(environment, { query: "stale cache marker", limit: 4 });
  assert.equal(incompatible.ok, true, JSON.stringify(incompatible.error));
  assert.equal(incompatible.value.readiness.action, "rebuild");
  assert.deepEqual(snapshotVaultTree(fixture.vaultPath), beforeIncompatibleRebuild);
});

test("automatic direct refresh preserves the temporary MCP embedding index", () => {
  const fixture = makeFixture({
    embeddings: {
      enabled: true,
      provider: "builtin",
      model: "dreamers-local-semantic",
      modelVersion: "test-1",
      dimensions: 12,
    },
  });
  const environment = environmentFor(fixture.frameworkRoot);
  const api = loadBuiltPackage();

  const initial = api.searchContext(environment, { query: "lexical retrieval", limit: 2 });
  assert.equal(initial.ok, true, JSON.stringify(initial.error));
  assert.equal(countRows(runtimeDatabasePath(fixture.frameworkRoot), "chunk_embeddings") > 0, true);

  fixture.writeVaultText(retrievalPath, `${fixture.readVaultText(retrievalPath)}\nEmbedded refresh marker.\n`);
  const refreshed = api.searchContext(environment, { query: "embedded refresh marker", limit: 2 });
  assert.equal(refreshed.ok, true, JSON.stringify(refreshed.error));
  assert.equal(refreshed.value.readiness.action, "refresh");
  assert.equal(Object.hasOwn(refreshed.value, "embedding"), false);

  const legacy = api.callMcpTool(fixture.frameworkRoot, "search_hybrid", {
    query: "embedded refresh marker",
    limit: 2,
  });
  assert.equal(legacy.isError, false, JSON.stringify(legacy));
  assert.equal(legacy.structuredContent.embedding.state, "ready");
  assert.equal(legacy.structuredContent.embedding.freshChunks > 0, true);
});

test("readiness returns stable busy and refresh-failure errors without vault mutation", () => {
  const fixture = makeFixture();
  const environment = environmentFor(fixture.frameworkRoot);
  const api = loadBuiltPackage();
  const databasePath = runtimeDatabasePath(fixture.frameworkRoot);
  const initialized = api.searchContext(environment, { query: "lexical retrieval", limit: 2 });
  assert.equal(initialized.ok, true, JSON.stringify(initialized.error));
  fixture.writeVaultText(retrievalPath, `${fixture.readVaultText(retrievalPath)}\nLocked refresh marker.\n`);
  const before = snapshotVaultTree(fixture.vaultPath);
  const lock = new Database(databasePath);
  lock.exec("begin exclusive");
  try {
    const busy = api.searchContext(environment, { query: "locked refresh marker", limit: 2 });
    assert.equal(busy.ok, false);
    assert.equal(busy.error.code, "index-busy");
  } finally {
    lock.exec("rollback");
    lock.close();
  }
  assert.deepEqual(snapshotVaultTree(fixture.vaultPath), before);

  const blockedParent = path.join(tmpdir("dreamers-note-refresh-failure"), "runtime-file");
  writeText(blockedParent, "not a directory\n");
  const refreshFailure = api.searchContext(
    { ...environment, databasePath: path.join(blockedParent, "notes.db") },
    { query: "locked refresh marker", limit: 2 },
  );
  assert.equal(refreshFailure.ok, false);
  assert.equal(refreshFailure.error.code, "index-refresh-failed");
  assert.deepEqual(snapshotVaultTree(fixture.vaultPath), before);
});

test("lexical context search is bounded, deterministic, explained, and has no semantic or embedding contract", () => {
  const fixture = makeFixture();
  const environment = environmentFor(fixture.frameworkRoot);
  const api = loadBuiltPackage();

  const first = api.searchContext(environment, { query: "retrieval engine", limit: 1 });
  const second = api.searchContext(environment, { query: "retrieval engine", limit: 1 });
  assert.equal(first.ok, true, JSON.stringify(first.error));
  assert.equal(second.ok, true, JSON.stringify(second.error));
  assert.deepEqual(second.value.results, first.value.results);
  assert.equal(first.value.results.length, 1);
  assert.equal(first.value.results[0].path, retrievalPath);
  assert.equal(first.value.results[0].snippet.length <= 240, true);
  assert.equal(Array.isArray(first.value.results[0].whyMatched), true);
  assert.equal(typeof first.value.results[0].scoreComponents.lexical, "number");
  assert.equal(Object.hasOwn(first.value, "embedding"), false);
  assert.equal(Object.hasOwn(first.value.results[0].scoreComponents, "semantic"), false);
});

test("context read returns bounded cited excerpts and refuses unsafe or unsupported selections without body leakage", () => {
  const fixture = makeFixture();
  const environment = environmentFor(fixture.frameworkRoot);
  const api = loadBuiltPackage();

  const read = api.readContext(environment, { path: retrievalPath, heading: "Ranking", maxChars: 72 });
  assert.equal(read.ok, true, JSON.stringify(read.error));
  assert.equal(read.value.path, retrievalPath);
  assert.equal(read.value.excerpts.length > 0, true);
  assert.equal(read.value.excerpts[0].headingPath, "Retrieval Core > Ranking");
  assert.equal(read.value.excerpts[0].line > 0, true);
  assert.equal(read.value.excerpts[0].text.length <= 72, true);

  for (const request of [
    { path: "07-system/secrets/token.md" },
    { path: "../../outside.md" },
    { path: "03-assets/diagrams/retrieval.png" },
    { path: "01-projects/ai/obsidian/missing.md" },
    { path: retrievalPath, heading: "Missing heading" },
    { chunkId: `${retrievalPath}#chunk-0` },
  ]) {
    const refused = api.readContext(environment, request);
    assert.equal(refused.ok, false);
    assert.equal(JSON.stringify(refused.error).includes("CONTEXT-SERVICE-SECRET-CANARY"), false);
  }
});

test("external source inspection pages safe explicit files without changing their bytes", () => {
  const fixture = makeFixture();
  const environment = environmentFor(fixture.frameworkRoot);
  const api = loadBuiltPackage();
  const sources = tmpdir("dreamers-note-context-source");
  const source = path.join(sources, "source.md");
  const symlink = path.join(sources, "source-link.md");
  const binary = path.join(sources, "binary.md");
  const oversized = path.join(sources, "oversized.md");
  writeText(source, "# Source\n\nThis source contains a bounded page of import evidence.\n");
  writeBinary(binary, Buffer.from([0x00, 0x01, 0x02]));
  writeText(oversized, "x".repeat(512 * 1024 + 1));
  fs.symlinkSync(source, symlink);
  const before = fs.readFileSync(source);

  const inspected = api.inspectContextSource(environment, { path: source, offset: 2, maxChars: 24 });
  assert.equal(inspected.ok, true, JSON.stringify(inspected.error));
  assert.equal(inspected.value.offset, 2);
  assert.equal(inspected.value.text.length <= 24, true);
  assert.equal(inspected.value.text, before.toString("utf8").slice(2, 26));
  assert.equal(Object.hasOwn(inspected.value, "preview"), false);
  assert.equal(typeof inspected.value.hash, "string");
  assert.deepEqual(fs.readFileSync(source), before);

  for (const input of ["relative.md", symlink, sources, binary, oversized, path.join(sources, "missing.md")]) {
    const refused = api.inspectContextSource(environment, { path: input, maxChars: 24 });
    assert.equal(refused.ok, false, input);
  }
  for (const input of [
    { path: source, offset: -1 },
    { path: source, maxChars: 12_001 },
  ]) {
    const refused = api.inspectContextSource(environment, input);
    assert.equal(refused.ok, false);
  }
});

test("related context requires exactly one selector and returns a bounded grouped neighborhood", () => {
  const fixture = makeFixture();
  const environment = environmentFor(fixture.frameworkRoot);
  const api = loadBuiltPackage();

  const byPath = api.relatedContext(environment, { path: retrievalPath, limit: 3 });
  assert.equal(byPath.ok, true, JSON.stringify(byPath.error));
  assert.equal(byPath.value.subject.path, retrievalPath);
  assert.equal(Array.isArray(byPath.value.groups.outgoingLinks.items), true);

  const byQuery = api.relatedContext(environment, { query: "knowledge base retrieval", limit: 3 });
  assert.equal(byQuery.ok, true, JSON.stringify(byQuery.error));
  assert.equal(typeof byQuery.value.subject.path, "string");

  for (const request of [{}, { path: retrievalPath, query: "retrieval" }]) {
    const refused = api.relatedContext(environment, request);
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, "context-selector-invalid");
  }
});

test("ephemeral graph, health, and duplicate review return current findings without report or feedback rows", () => {
  const fixture = makeFixture();
  const environment = environmentFor(fixture.frameworkRoot);
  const api = loadBuiltPackage();
  buildFixtureIndex(fixture.frameworkRoot, fixture.vaultPath);
  const databasePath = runtimeDatabasePath(fixture.frameworkRoot);
  const beforeReports = countRows(databasePath, "diagnostic_reports");
  const beforeFeedback = countRows(databasePath, "diagnostic_feedback");

  for (const kind of ["graph", "health", "duplicates"]) {
    const review = api.reviewContext(environment, { kind, limit: 4 });
    assert.equal(review.ok, true, JSON.stringify(review.error));
    assert.equal(review.value.kind, kind);
  }

  assert.equal(countRows(databasePath, "diagnostic_reports"), beforeReports);
  assert.equal(countRows(databasePath, "diagnostic_feedback"), beforeFeedback);
});
