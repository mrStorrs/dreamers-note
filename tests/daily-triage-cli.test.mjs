import assert from "node:assert/strict";
import test from "node:test";
import { createProjectFixture, readJsonEnvelope, runJsonCli, snapshotVaultContent } from "./helpers/project-fixtures.mjs";

function run(root, args) {
  const result = runJsonCli([...args, "--root", root]);
  return { result, envelope: readJsonEnvelope(result) };
}

test("daily triage produces deterministic extraction/change input without writing", () => {
  const fixture = createProjectFixture({
    git: true,
    vaultFiles: {
      "00-inbox/daily-notes/2026-09-01.md": "# Daily\n\n## project: recipes/planner\nBuild dinner planner #ai #recipes\n",
      "01-projects/recipes/general/planner.md": "# Planner\n",
    },
  });
  const before = snapshotVaultContent(fixture.vaultPath);
  const { result, envelope } = run(fixture.frameworkRoot, ["daily", "triage", "--archive-check"]);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(envelope.command, "daily triage");
  assert.equal(envelope.data.items.length, 1);
  assert.equal(envelope.data.items[0].fragments[0].suggestedDestination, "01-projects/recipes/general/planner.md");
  assert.equal(envelope.data.items[0].archive.ready, false);
  assert.equal(envelope.data.changeInput, null);
  assert.deepEqual(snapshotVaultContent(fixture.vaultPath), before);
});

test("daily triage refuses non-daily input", () => {
  const fixture = createProjectFixture({ vaultFiles: { "01-projects/ai/notes/not-daily.md": "No\n" } });
  const { result, envelope } = run(fixture.frameworkRoot, ["daily", "triage", "01-projects/ai/notes/not-daily.md"]);
  assert.equal(result.status, 1);
  assert.equal(envelope.error.code, "daily-triage-path-invalid");
});
