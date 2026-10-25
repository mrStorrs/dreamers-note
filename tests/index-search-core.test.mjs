import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createProjectFixture, loadBuiltPackage } from "./helpers/project-fixtures.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

test("lexical index/search retains FTS, graph, freshness, and explainable scores without vector tables", () => {
  const fixture = createProjectFixture({
    index: true,
    vaultFiles: {
      "01-projects/ai/notes/retrieval.md": "---\ntags: [ai, search]\n---\n# Retrieval Core\n\nLexical ranking [[search-guide|search guide]].\n",
      "02-knowledge/ai/search/search-guide.md": "# Search Guide\n\nRetrieval context.\n",
      "07-system/secrets/token.md": "SEARCH-SECRET-CANARY\n",
    },
  });
  const api = loadBuiltPackage();
  const result = api.searchVaultIndex({ databasePath: fixture.runtime.databasePath, query: "retrieval core", limit: 5 });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.value.results[0].path, "01-projects/ai/notes/retrieval.md");
  assert.equal(result.value.results[0].whyMatched.includes("title"), true);
  assert.equal("semantic" in result.value.results[0].scoreComponents, false);
  assert.doesNotMatch(JSON.stringify(result.value), /SEARCH-SECRET-CANARY/);
  const db = new Database(fixture.runtime.databasePath, { readonly: true });
  assert.equal(db.prepare("select count(*) as count from sqlite_schema where name = 'chunk_embeddings'").get().count, 0);
  db.close();
});
