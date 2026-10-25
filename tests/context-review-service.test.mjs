import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createProjectFixture, loadBuiltPackage, readJsonEnvelope, runJsonCli, snapshotVaultContent } from "./helpers/project-fixtures.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

function environmentFor(rootDir) {
  const loaded = loadBuiltPackage().loadVaultEnvironment({ rootDir });
  assert.equal(loaded.ok, true, JSON.stringify(loaded.error));
  return loaded.value;
}

test("context and review refresh only the ignored cache and return bounded lexical/graph evidence", () => {
  const fixture = createProjectFixture({
    git: true,
    vaultFiles: {
      "01-projects/ai/notes/retrieval.md": "# Retrieval\n\n#ai Lexical retrieval links [[search]].\n",
      "02-knowledge/ai/search/search.md": "# Search\n\n#search Search context.\n",
      "07-system/secrets/token.md": "CONTEXT-SECRET-CANARY\n",
    },
  });
  const api = loadBuiltPackage();
  const environment = environmentFor(fixture.frameworkRoot);
  const before = snapshotVaultContent(fixture.vaultPath);

  const search = api.searchContext(environment, { query: "lexical retrieval", limit: 4 });
  assert.equal(search.ok, true, JSON.stringify(search.error));
  assert.equal(search.value.results[0].path, "01-projects/ai/notes/retrieval.md");
  assert.equal(search.value.results[0].scoreComponents.lexical > 0, true);
  assert.equal("semantic" in search.value.results[0].scoreComponents, false);

  const read = api.readContext(environment, { path: "01-projects/ai/notes/retrieval.md", maxChars: 80 });
  assert.equal(read.ok, true, JSON.stringify(read.error));
  assert.equal(read.value.excerpts[0].trust, "untrusted");
  const related = api.relatedContext(environment, { path: "01-projects/ai/notes/retrieval.md" });
  assert.equal(related.ok, true, JSON.stringify(related.error));
  assert.equal(Array.isArray(related.value.groups.outgoingLinks.items), true);
  const review = api.reviewContext(environment, { kind: "graph", limit: 5 });
  assert.equal(review.ok, true, JSON.stringify(review.error));

  assert.deepEqual(snapshotVaultContent(fixture.vaultPath), before);
  assert.equal(fs.existsSync(path.join(fixture.frameworkRoot, ".dreamers-note-runtime", "notes.db")), true);
});

test("a version-6 cache rebuilds to schema 7 without changing vault bytes", () => {
  const fixture = createProjectFixture({
    index: true,
    vaultFiles: { "02-knowledge/ai/search/search.md": "# Search\n\nLexical evidence.\n" },
  });
  const db = new Database(fixture.runtime.databasePath);
  db.prepare("update meta set value = '6' where key = 'schema_version'").run();
  db.exec("create table operation_history (id integer primary key, operation text not null)");
  db.close();
  const before = snapshotVaultContent(fixture.vaultPath);
  const api = loadBuiltPackage();
  const result = api.searchContext(environmentFor(fixture.frameworkRoot), { query: "lexical" });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const repaired = new Database(fixture.runtime.databasePath, { readonly: true });
  assert.equal(repaired.prepare("select value from meta where key = 'schema_version'").get().value, "7");
  assert.equal(repaired.prepare("select count(*) as count from sqlite_schema where name = 'chunk_embeddings'").get().count, 0);
  assert.equal(repaired.prepare("select count(*) as count from sqlite_schema where name = 'operation_history'").get().count, 0);
  repaired.close();
  const doctor = readJsonEnvelope(runJsonCli(["doctor", "--root", fixture.frameworkRoot]));
  assert.equal(doctor.data.capabilities.legacyPendingChangesMigrated, false);
  assert.deepEqual(snapshotVaultContent(fixture.vaultPath), before);
});
