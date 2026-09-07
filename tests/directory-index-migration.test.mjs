import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createProjectFixture, readJsonEnvelope, runJsonCli, snapshotVaultContent, tmpdir, writeJson } from "./helpers/project-fixtures.mjs";

test("directory-index emits a safe change input and does not directly write", () => {
  const fixture = createProjectFixture({
    git: true,
    vaultFiles: {
      "02-knowledge/ai/search/retrieval.md": "# Retrieval\n\nUseful search material.\n",
    },
  });
  const before = snapshotVaultContent(fixture.vaultPath);
  const planned = runJsonCli(["vault", "directory-index", "--root", fixture.frameworkRoot]);
  const envelope = readJsonEnvelope(planned);
  assert.equal(planned.status, 0, planned.stdout);
  assert.equal(envelope.data.changeInput !== null, true);
  assert.deepEqual(snapshotVaultContent(fixture.vaultPath), before);

  const input = path.join(tmpdir("directory-index-change"), "change.json");
  writeJson(input, envelope.data.changeInput);
  const created = readJsonEnvelope(runJsonCli(["change", "create", "--input", input, "--root", fixture.frameworkRoot]));
  const applied = readJsonEnvelope(runJsonCli(["change", "apply", "--id", created.data.id, "--revision", created.data.revision, "--root", fixture.frameworkRoot]));
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(fs.existsSync(path.join(fixture.vaultPath, "02-knowledge/ai/search/_search.md")), true);
});
