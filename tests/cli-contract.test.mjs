import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createProjectFixture,
  readJsonEnvelope,
  runJsonCli,
  tmpdir,
  writeJson,
  writeText,
} from "./helpers/project-fixtures.mjs";

function run(rootDir, args, options = {}) {
  const result = runJsonCli([...args, "--root", rootDir], options);
  return { result, envelope: readJsonEnvelope(result) };
}

function assertSuccess(rootDir, args, options = {}) {
  const { result, envelope } = run(rootDir, args, options);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  assert.equal(result.stderr, "");
  return envelope;
}

function assertUsage(rootDir, args) {
  const { result, envelope } = run(rootDir, args);
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.equal(envelope.ok, false);
  assert.match(envelope.error.code, /^cli-/);
  assert.equal(result.stderr, "");
}

test("the built CLI dispatches the approved JSON command families with bounded one-document output", () => {
  const fixture = createProjectFixture({
    git: true,
    vaultFiles: {
      "01-projects/ai/notes/existing.md": "# Existing\n\n#ai context material\n",
      "02-knowledge/obsidian/search/search.md": "# Search\n\n[[existing]]\n",
      "00-inbox/daily-notes/2026-09-05.md": "# Daily\n\n## project: cli/test\nCapture #ai\n",
    },
  });
  const external = path.join(tmpdir("cli-contract-source"), "source.md");
  writeText(external, "# External\n\noutside source\n");

  const doctor = assertSuccess(fixture.frameworkRoot, ["doctor"]);
  assert.equal(doctor.command, "doctor");
  assert.equal(doctor.data.runtime.state, "missing");
  assert.equal(fs.existsSync(path.join(fixture.vaultPath, ".dreamers-note-runtime")), false);

  const search = assertSuccess(fixture.frameworkRoot, ["context", "search", "--query", "existing", "--limit", "3"]);
  assert.equal(search.command, "context search");
  assert.equal(search.data.results[0].path, "01-projects/ai/notes/existing.md");
  assert.equal(fs.existsSync(path.join(fixture.vaultPath, ".dreamers-note-runtime")), false);
  assert.equal(fs.existsSync(path.join(fixture.frameworkRoot, ".dreamers-note-runtime", "notes.db")), true);

  const read = assertSuccess(fixture.frameworkRoot, ["context", "read", "--path", "01-projects/ai/notes/existing.md", "--max-chars", "100"]);
  assert.equal(read.command, "context read");
  assert.equal(read.data.path, "01-projects/ai/notes/existing.md");
  assertSuccess(fixture.frameworkRoot, ["context", "related", "--path", "01-projects/ai/notes/existing.md"]);
  assertSuccess(fixture.frameworkRoot, ["context", "source", "--path", external, "--max-chars", "100"]);
  assertSuccess(fixture.frameworkRoot, ["review", "graph", "--limit", "3"]);
  assertSuccess(fixture.frameworkRoot, ["review", "health", "--limit", "3"]);
  assertSuccess(fixture.frameworkRoot, ["review", "duplicates", "--limit", "3"]);
  assertSuccess(fixture.frameworkRoot, ["index", "refresh"]);
});

test("context source stays cache-free and operational errors keep protected content out of the envelope", () => {
  const fixture = createProjectFixture({
    vaultFiles: {
      "07-system/secrets/private.md": "protected source canary\n",
    },
  });
  const external = path.join(tmpdir("cli-source-isolation"), "external.md");
  writeText(external, "# External\n\nSafe source evidence.\n");

  const source = assertSuccess(fixture.frameworkRoot, ["context", "source", "--path", external]);
  assert.equal(source.data.text, "# External\n\nSafe source evidence.\n");
  assert.equal(fs.existsSync(path.join(fixture.frameworkRoot, ".dreamers-note-runtime")), false);

  const privateSource = run(fixture.frameworkRoot, [
    "context", "source", "--path", path.join(fixture.vaultPath, "07-system/secrets/private.md"),
  ]);
  assert.equal(privateSource.result.status, 1);
  assert.equal(privateSource.envelope.ok, false);
  assert.equal(privateSource.result.stderr, "");
  assert.doesNotMatch(JSON.stringify(privateSource.envelope), /protected source canary|private\.md/);

  const missing = run(fixture.frameworkRoot, ["context", "source", "--path", path.join(tmpdir("cli-source-missing"), "missing.md")]);
  assert.equal(missing.result.status, 1);
  assert.equal(missing.envelope.error.code, "import-source-missing");
  assert.equal(missing.result.stderr, "");
  assert.equal(fs.existsSync(path.join(fixture.frameworkRoot, ".dreamers-note-runtime")), false);
});

test("the CLI rejects invalid grammar before runtime initialization", () => {
  const fixture = createProjectFixture({
    vaultFiles: { "01-projects/ai/notes/existing.md": "existing\n" },
  });
  const malformedChangePath = path.join(tmpdir("cli-malformed-change"), "change.json");
  const malformedDecisionsPath = path.join(tmpdir("cli-malformed-decisions"), "decisions.jsonl");
  writeText(malformedChangePath, "{not JSON}\n");
  writeText(malformedDecisionsPath, "{not JSON}\n");
  const invalid = [
    ["unknown"],
    ["context", "search", "--query", "x", "--limit", "1", "--limit", "2"],
    ["context", "related", "--path", "01-projects/ai/notes/existing.md", "--query", "x"],
    ["context", "read", "--path", "01-projects/ai/notes/existing.md", "--max-chars", "0"],
    ["change", "show", "--id", "x", "--offset", "1"],
    ["vault", "inventory"],
    ["doctor", "unexpected"],
    ["change", "create", "--input", malformedChangePath],
    ["vault", "normalize", malformedDecisionsPath],
  ];
  for (const args of invalid) {
    assertUsage(fixture.frameworkRoot, args);
  }
  const oversized = run(
    fixture.frameworkRoot,
    ["change", "create", "--input", "-"],
    { input: Buffer.alloc(2_000_001, 0x20) },
  );
  assert.equal(oversized.result.status, 2);
  assert.equal(oversized.envelope.error.code, "cli-input-too-large");
  assert.equal(fs.existsSync(path.join(fixture.frameworkRoot, ".dreamers-note-runtime")), false);
});

test("change commands persist exact revisions across processes, page bodies, and accept only regular JSON input", () => {
  const fixture = createProjectFixture({
    git: true,
    vaultFiles: {
      "01-projects/ai/notes/existing.md": "# Existing\n",
    },
  });
  const inputPath = path.join(tmpdir("cli-change-input"), "change.json");
  writeJson(inputPath, {
    summary: "Add a CLI contract note",
    writes: [{
      path: "01-projects/ai/notes/cli-contract.md",
      body: "# CLI Contract\n\nA paged reviewed change body.\n",
    }],
  });

  const created = assertSuccess(fixture.frameworkRoot, ["change", "create", "--input", inputPath]);
  assert.equal(created.data.status, "pending");
  const shown = assertSuccess(fixture.frameworkRoot, [
    "change", "show", "--id", created.data.id,
    "--path", "01-projects/ai/notes/cli-contract.md", "--offset", "0", "--max-chars", "8",
  ]);
  assert.equal(shown.data.change.revision, created.data.revision);
  assert.equal(shown.data.page.text, "# CLI Co");
  assert.equal(shown.data.page.nextOffset, 8);
  const listed = assertSuccess(fixture.frameworkRoot, ["change", "list"]);
  assert.equal(listed.data.items.some((item) => item.id === created.data.id), true);

  const applied = assertSuccess(fixture.frameworkRoot, [
    "change", "apply", "--id", created.data.id, "--revision", created.data.revision,
  ]);
  assert.equal(applied.data.status, "applied");
  assert.equal(
    fs.readFileSync(path.join(fixture.vaultPath, "01-projects/ai/notes/cli-contract.md"), "utf8"),
    "# CLI Contract\n\nA paged reviewed change body.\n",
  );

  const stdinChange = {
    summary: "Create then reject a stdin change",
    writes: [{ path: "01-projects/ai/notes/stdin.md", body: "# Stdin\n" }],
  };
  const pending = assertSuccess(
    fixture.frameworkRoot,
    ["change", "create", "--input", "-"],
    { input: JSON.stringify(stdinChange) },
  );
  const rejected = assertSuccess(fixture.frameworkRoot, ["change", "reject", "--id", pending.data.id]);
  assert.equal(rejected.data.status, "rejected");
  assert.equal(fs.existsSync(path.join(fixture.vaultPath, "01-projects/ai/notes/stdin.md")), false);

  const linkPath = path.join(tmpdir("cli-change-symlink"), "input-link.json");
  fs.symlinkSync(inputPath, linkPath);
  const { result, envelope } = run(fixture.frameworkRoot, ["change", "create", "--input", linkPath]);
  assert.equal(result.status, 2);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "cli-input-invalid");
});

test("change list refuses history beyond its bounded JSON result", () => {
  const fixture = createProjectFixture({
    git: true,
    vaultFiles: { "00-inbox/seed.md": "seed\n" },
  });
  const environment = fixture.packageApi.loadVaultEnvironment({ rootDir: fixture.frameworkRoot });
  assert.equal(environment.ok, true, JSON.stringify(environment.error));
  for (let index = 0; index < 51; index += 1) {
    const created = fixture.packageApi.createChange(environment.value, {
      summary: `seed change ${index}`,
      writes: [{ path: `00-inbox/seed-${index}.md`, body: `# Seed ${index}\n` }],
    });
    assert.equal(created.ok, true, JSON.stringify(created.error));
  }

  const { result, envelope } = run(fixture.frameworkRoot, ["change", "list"]);
  assert.equal(result.status, 1);
  assert.equal(envelope.error.code, "change-list-too-large");
  assert.doesNotMatch(JSON.stringify(envelope), /seed change 0/);
});
