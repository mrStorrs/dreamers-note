import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createProjectFixture,
  projectRoot,
  readJsonEnvelope,
  runJsonCli,
  snapshotVaultContent,
  writeText,
} from "./helpers/project-fixtures.mjs";

function run(rootDir, args) {
  const result = runJsonCli([...args, "--root", rootDir]);
  const envelope = readJsonEnvelope(result);
  assert.equal(result.stderr, "");
  return { result, envelope };
}

test("daily triage ports deterministic fragment and archive-readiness behavior without mutating the vault", () => {
  const fixture = createProjectFixture({
    git: true,
    vaultFiles: {
      "00-inbox/daily-notes/2026-09-01.md": [
        "# 2026-09-01",
        "",
        "## project: recipes/planner",
        "Build a dinner planner. #ai #recipes #new-topic",
        "",
        "## source: kitchen notes",
        "Reference source content.",
      ].join("\n"),
      "00-inbox/daily-notes/2026-09-02.md": [
        "# 2026-09-02",
        "",
        "## area: obsidian/search/retrieval",
        "Improve lexical search. #obsidian #search",
      ].join("\n"),
    },
  });
  writeText(path.join(fixture.vaultPath, "01-projects", "recipes", "general", "planner.md"), "reviewed\n");
  writeText(path.join(fixture.vaultPath, "03-sources", "kitchen-notes.md"), "reviewed\n");
  writeText(path.join(fixture.vaultPath, "02-knowledge", "obsidian", "search", "retrieval.md"), "reviewed\n");
  const before = snapshotVaultContent(fixture.vaultPath);
  const beforeGitStatus = fixture.git(["status", "--short"]).stdout;

  const python = spawnSync(
    "python3",
    [
      path.join(projectRoot, "scripts", "propose-daily-triage.py"),
      "--vault", fixture.vaultPath,
      "--tags", path.join(fixture.frameworkRoot, "taxonomy", "approved-tags.md"),
      "--archive",
    ],
    { cwd: projectRoot, encoding: "utf8" },
  );
  assert.equal(python.status, 0, python.stderr);
  assert.match(python.stdout, /01-projects\/recipes\/general\/planner\.md/);
  assert.match(python.stdout, /03-sources\/kitchen-notes\.md/);

  const { result, envelope } = run(fixture.frameworkRoot, ["daily", "triage", "--archive-check"]);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, "daily triage");
  assert.equal(envelope.data.items.length, 2);
  assert.deepEqual(
    envelope.data.items[0].fragments.map((fragment) => fragment.suggestedDestination),
    ["01-projects/recipes/general/planner.md", "03-sources/kitchen-notes.md"],
  );
  assert.deepEqual(envelope.data.items[0].fragments[0].approvedTags, ["ai", "recipes"]);
  assert.deepEqual(envelope.data.items[0].fragments[0].proposedTags, ["new-topic"]);
  assert.equal(envelope.data.items.every((item) => item.archive.ready), true);
  assert.deepEqual(
    envelope.data.changeInput.moves.map((move) => move.from),
    ["00-inbox/daily-notes/2026-09-01.md", "00-inbox/daily-notes/2026-09-02.md"],
  );
  assert.deepEqual(snapshotVaultContent(fixture.vaultPath), before);
  assert.equal(fixture.git(["status", "--short"]).stdout, beforeGitStatus);
  assert.equal(fs.existsSync(path.join(fixture.frameworkRoot, ".dreamers-note-runtime")), false);
});

test("daily triage uses stable cursors and refuses non-daily selections", () => {
  const fixture = createProjectFixture({
    vaultFiles: {
      "00-inbox/daily-notes/2026-09-01.md": "## project: a/b\nOne\n",
      "00-inbox/daily-notes/2026-09-02.md": "## project: c/d\nTwo\n",
      "00-inbox/daily-notes/nested/2026-09-03.md": "## project: ignored/nested\nThree\n",
      "01-projects/ai/notes/not-daily.md": "not daily\n",
    },
  });
  const first = run(fixture.frameworkRoot, ["daily", "triage", "--limit", "1"]);
  assert.equal(first.result.status, 0);
  assert.equal(first.envelope.data.items[0].path, "00-inbox/daily-notes/2026-09-01.md");
  assert.equal(first.envelope.data.nextCursor, "00-inbox/daily-notes/2026-09-01.md");
  const second = run(fixture.frameworkRoot, [
    "daily", "triage", "--cursor", first.envelope.data.nextCursor, "--limit", "1",
  ]);
  assert.equal(second.result.status, 0);
  assert.equal(second.envelope.data.items[0].path, "00-inbox/daily-notes/2026-09-02.md");

  const all = run(fixture.frameworkRoot, ["daily", "triage"]);
  assert.equal(all.result.status, 0);
  assert.deepEqual(
    all.envelope.data.items.map((item) => item.path),
    ["00-inbox/daily-notes/2026-09-01.md", "00-inbox/daily-notes/2026-09-02.md"],
  );

  const nested = run(fixture.frameworkRoot, ["daily", "triage", "00-inbox/daily-notes/nested/2026-09-03.md"]);
  assert.equal(nested.result.status, 1);
  assert.equal(nested.envelope.error.code, "daily-triage-path-invalid");

  const invalid = run(fixture.frameworkRoot, ["daily", "triage", "01-projects/ai/notes/not-daily.md"]);
  assert.equal(invalid.result.status, 1);
  assert.equal(invalid.envelope.error.code, "daily-triage-path-invalid");
});

test("daily triage refuses an oversized review result without emitting fragments", () => {
  const headings = Array.from(
    { length: 2_500 },
    (_, index) => `## project: project-${index}/${"x".repeat(120)}\n`,
  ).join("\n");
  const fixture = createProjectFixture({
    vaultFiles: {
      "00-inbox/daily-notes/2026-09-03.md": headings,
    },
  });
  const failed = run(fixture.frameworkRoot, ["daily", "triage"]);
  assert.equal(failed.result.status, 1);
  assert.equal(failed.envelope.error.code, "daily-triage-output-too-large");
  assert.doesNotMatch(JSON.stringify(failed.envelope), /project-0/);
});
