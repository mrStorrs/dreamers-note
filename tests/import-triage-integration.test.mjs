import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createProjectFixture, loadBuiltPackage, readJsonEnvelope, runJsonCli, tmpdir, writeJson, writeText } from "./helpers/project-fixtures.mjs";

test("import evidence preserves the external source and uses the same exact change lifecycle", () => {
  const fixture = createProjectFixture({ git: true, vaultFiles: { "02-knowledge/ai/search/search.md": "# Search\n" } });
  const source = path.join(tmpdir("note-import-source"), "source.md");
  writeText(source, "# Imported\n\nDurable source material.\n");
  const api = loadBuiltPackage();
  const environment = api.loadVaultEnvironment({ rootDir: fixture.frameworkRoot });
  assert.equal(environment.ok, true, JSON.stringify(environment.error));
  const inspected = api.inspectContextSource(environment.value, { path: source });
  assert.equal(inspected.ok, true, JSON.stringify(inspected.error));
  const before = fs.readFileSync(source, "utf8");
  const input = path.join(tmpdir("note-import-change"), "change.json");
  writeJson(input, { summary: "Import source", writes: [{ path: "02-knowledge/ai/search/imported.md", body: inspected.value.text }] });
  const created = readJsonEnvelope(runJsonCli(["change", "create", "--input", input, "--root", fixture.frameworkRoot]));
  assert.equal(created.ok, true);
  assert.equal(fs.readFileSync(source, "utf8"), before);
  const applied = readJsonEnvelope(runJsonCli(["change", "apply", "--id", created.data.id, "--revision", created.data.revision, "--root", fixture.frameworkRoot]));
  assert.equal(applied.ok, true);
  assert.equal(fs.readFileSync(source, "utf8"), before);
});
