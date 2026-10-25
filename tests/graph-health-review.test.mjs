import assert from "node:assert/strict";
import test from "node:test";
import { createProjectFixture, loadBuiltPackage } from "./helpers/project-fixtures.mjs";

test("graph, health, and duplicate review remain read-only and bounded", () => {
  const fixture = createProjectFixture({
    index: true,
    vaultFiles: {
      "02-knowledge/ai/search/one.md": "# Same\n\n[[missing-note]]\n",
      "02-knowledge/ai/search/two.md": "# Same\n\n",
    },
  });
  const api = loadBuiltPackage();
  const environment = api.loadVaultEnvironment({ rootDir: fixture.frameworkRoot });
  assert.equal(environment.ok, true, JSON.stringify(environment.error));
  for (const kind of ["graph", "health", "duplicates"]) {
    const review = api.reviewContext(environment.value, { kind, limit: 1 });
    assert.equal(review.ok, true, JSON.stringify(review.error));
    assert.equal(review.value.kind, kind);
  }
});
