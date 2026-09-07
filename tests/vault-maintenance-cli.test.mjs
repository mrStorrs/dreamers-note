import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createProjectFixture, readJsonEnvelope, runJsonCli, snapshotVaultContent, tmpdir, writeText } from "./helpers/project-fixtures.mjs";

test("inventory and normalization return change input rather than directly writing", () => {
  const fixture = createProjectFixture({
    git: true,
    vaultFiles: { "Projects/My AI Note.md": "# My AI Note\n\n#ai\n" },
  });
  const before = snapshotVaultContent(fixture.vaultPath);
  const inventory = readJsonEnvelope(runJsonCli(["vault", "inventory", "Projects/My AI Note.md", "--root", fixture.frameworkRoot]));
  assert.equal(inventory.ok, true, JSON.stringify(inventory));
  const decisions = path.join(tmpdir("normalize-decisions"), "decisions.jsonl");
  writeText(decisions, `${JSON.stringify({
    source_path: "Projects/My AI Note.md",
    target_path: "01-projects/ai/notes/my-ai-note.md",
    reviewed: true,
    reviewed_scope: ["placement", "tags", "links", "content"],
    approved_tags: ["ai"],
    links_to_add: [],
    unresolved_questions: [],
  })}\n`);
  const normalized = readJsonEnvelope(runJsonCli(["vault", "normalize", decisions, "--root", fixture.frameworkRoot]));
  assert.equal(normalized.ok, true, JSON.stringify(normalized));
  assert.equal(normalized.data.changeInput.moves.length, 1);
  assert.deepEqual(snapshotVaultContent(fixture.vaultPath), before);
});
