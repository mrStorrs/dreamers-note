import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createProjectFixture, projectRoot, readJsonEnvelope, runJsonCli, snapshotVaultContent, tmpdir, writeJson } from "./helpers/project-fixtures.mjs";

const canonical = ["note-add", "note-import", "note-daily-triage", "note-review", "note-vault-refactor"];

test("canonical skill source has exactly five note-* workflows with CLI approval gates", () => {
  assert.deepEqual(fs.readdirSync(path.join(projectRoot, ".codex", "skills")).sort(), [...canonical].sort());
  for (const skill of canonical) {
    const text = fs.readFileSync(path.join(projectRoot, ".codex", "skills", skill, "SKILL.md"), "utf8");
    assert.match(text, new RegExp(`name: "${skill}"`));
    assert.match(text, /change create/);
    assert.match(text, /change show/);
    assert.doesNotMatch(text, /MCP|workflow_ready|proposal_authorize|proposal_apply/);
  }
});

test("an add-style change is inert before approval and applies only its shown revision", () => {
  const fixture = createProjectFixture({ git: true, vaultFiles: { "01-projects/ai/notes/existing.md": "# Existing\n" } });
  const input = path.join(tmpdir("note-add-change"), "change.json");
  writeJson(input, { summary: "Add capture", writes: [{ path: "01-projects/ai/notes/capture.md", body: "# Capture\n\nReviewed addition.\n" }] });
  const before = snapshotVaultContent(fixture.vaultPath);
  const createdResult = runJsonCli(["change", "create", "--input", input, "--root", fixture.frameworkRoot]);
  const created = readJsonEnvelope(createdResult);
  assert.equal(createdResult.status, 0);
  assert.deepEqual(snapshotVaultContent(fixture.vaultPath), before);
  const shown = readJsonEnvelope(runJsonCli(["change", "show", "--id", created.data.id, "--root", fixture.frameworkRoot]));
  assert.equal(shown.data.change.revision, created.data.revision);
  const wrong = readJsonEnvelope(runJsonCli(["change", "apply", "--id", created.data.id, "--revision", "0".repeat(64), "--root", fixture.frameworkRoot]));
  assert.equal(wrong.ok, false);
  assert.equal(fs.existsSync(path.join(fixture.vaultPath, "01-projects/ai/notes/capture.md")), false);
  const applied = readJsonEnvelope(runJsonCli(["change", "apply", "--id", created.data.id, "--revision", created.data.revision, "--root", fixture.frameworkRoot]));
  assert.equal(applied.ok, true, JSON.stringify(applied));
});

test("an installed locator command anchors the CLI to its framework from a skill working directory", () => {
  const fixture = createProjectFixture({
    vaultFiles: { "01-projects/ai/notes/locator.md": "# Locator\n\nLocator-bound retrieval evidence.\n" },
  });
  const skillDir = path.join(tmpdir("note-add-installed-skill"), "skills", "note-add");
  const skillsDir = path.dirname(skillDir);
  fs.mkdirSync(skillDir, { recursive: true });
  const locatorPath = path.join(skillsDir, ".dreamers-note-install.json");
  fs.writeFileSync(locatorPath, `${JSON.stringify({
    framework_root: fixture.frameworkRoot,
    cli_path: path.join(projectRoot, "dist", "cli.js"),
  })}\n`);
  const locator = JSON.parse(fs.readFileSync(locatorPath, "utf8"));
  const result = spawnSync(
    process.execPath,
    [locator.cli_path, "--root", locator.framework_root, "context", "search", "--query", "locator-bound"],
    { cwd: skillDir, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const envelope = readJsonEnvelope(result);
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  assert.equal(envelope.data.results[0].path, "01-projects/ai/notes/locator.md");
});
