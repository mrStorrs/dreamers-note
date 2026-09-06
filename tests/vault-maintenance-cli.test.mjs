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
  tmpdir,
  writeBinary,
  writeJson,
  writeText,
} from "./helpers/project-fixtures.mjs";

function run(rootDir, args) {
  const result = runJsonCli([...args, "--root", rootDir]);
  const envelope = readJsonEnvelope(result);
  assert.equal(result.stderr, "");
  return { result, envelope };
}

function assertSuccess(rootDir, args) {
  const response = run(rootDir, args);
  assert.equal(response.result.status, 0, response.result.stdout);
  assert.equal(response.envelope.ok, true, JSON.stringify(response.envelope));
  return response.envelope;
}

test("vault inventory returns paged deterministic records equivalent to the legacy inventory without vault writes", () => {
  const fixture = createProjectFixture({
    git: true,
    vaultFiles: {
      "Projects/My AI Note.md": "---\ntags:\n  - ai\n  - missing-tag\n---\n[[Other Note]]\n![[Pasted Image.PNG]]\n",
      "Pasted Image.PNG": Buffer.from("image"),
      "07-system/secrets/private.md": "private canary\n",
      ".obsidian/Plugin State.md": "ignored\n",
    },
  });
  const before = snapshotVaultContent(fixture.vaultPath);
  const beforeGitStatus = fixture.git(["status", "--short"]).stdout;
  const indexes = tmpdir("vault-inventory-parity");
  const legacy = spawnSync(
    "python3",
    [
      path.join(projectRoot, "scripts", "build-vault-inventory.py"),
      "--vault", fixture.vaultPath,
      "--indexes", indexes,
      "--tags", path.join(fixture.frameworkRoot, "taxonomy", "approved-tags.md"),
      ".",
    ],
    { cwd: projectRoot, encoding: "utf8" },
  );
  assert.equal(legacy.status, 0, legacy.stderr);
  const legacyRecords = fs.readFileSync(path.join(indexes, "vault-inventory.jsonl"), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const first = assertSuccess(fixture.frameworkRoot, ["vault", "inventory", ".", "--limit", "1"]);
  assert.equal(first.data.items.length, 1);
  assert.equal(first.data.nextCursor, first.data.items[0].sourcePath);
  const full = assertSuccess(fixture.frameworkRoot, ["vault", "inventory", "."]);
  assert.deepEqual(
    full.data.items.map((item) => ({ sourcePath: item.sourcePath, proposedPath: item.proposedPath })),
    legacyRecords.map((item) => ({ sourcePath: item.source_path, proposedPath: item.proposed_path })),
  );
  const note = full.data.items.find((item) => item.sourcePath === "Projects/My AI Note.md");
  assert.deepEqual(note.approvedTags, ["ai"]);
  assert.deepEqual(note.unapprovedTagCandidates, ["missing-tag"]);
  assert.equal(note.mustReadFile, true);
  const asset = full.data.items.find((item) => item.sourcePath === "Pasted Image.PNG");
  assert.equal(asset.risk.attachmentRisk, true);
  assert.equal(full.data.items.some((item) => item.sourcePath.includes("private")), false);
  assert.deepEqual(snapshotVaultContent(fixture.vaultPath), before);
  assert.equal(fixture.git(["status", "--short"]).stdout, beforeGitStatus);
});

test("reviewed normalization emits a safe change input, never applies directly, and supports write-before-move application", () => {
  const fixture = createProjectFixture({
    git: true,
    vaultFiles: {
      "Projects/My AI Note.md": "---\ntags:\n  - recipes\n---\n# My AI Note\n\n![[Pasted Image.PNG]]\n",
      "Areas/Index.md": "[[My AI Note]]\n[project](Projects/My AI Note.md)\n![pic](Pasted Image.PNG)\n",
      "Pasted Image.PNG": Buffer.from("image"),
    },
  });
  const decisionsPath = path.join(tmpdir("normalization-decisions"), "decisions.jsonl");
  const decisions = [
    {
      source_path: "Projects/My AI Note.md",
      target_path: "01-projects/ai/recipes/my-ai-note.md",
      reviewed: true,
      reviewed_scope: ["placement", "tags", "links", "content"],
      approved_tags: ["ai", "recipes"],
      links_to_add: ["02-knowledge/food/recipes/ai-recipe-prompts.md"],
      unresolved_questions: [],
      extracted_notes: [{
        target_path: "02-knowledge/food/recipes/ai-recipe-prompts.md",
        title: "AI Recipe Prompts",
        body: "Prompt patterns for recipe planning.",
        approved_tags: ["ai", "recipes"],
        links_to_add: ["01-projects/ai/recipes/my-ai-note.md"],
      }],
    },
    {
      source_path: "Pasted Image.PNG",
      target_path: "05-assets/pasted-image.png",
      reviewed: true,
      reviewed_scope: ["placement", "tags", "links", "content"],
      approved_tags: [],
      links_to_add: [],
      unresolved_questions: [],
    },
  ];
  writeText(decisionsPath, `${decisions.map((item) => JSON.stringify(item)).join("\n")}\n`);
  const before = snapshotVaultContent(fixture.vaultPath);
  const beforeGitStatus = fixture.git(["status", "--short"]).stdout;

  const normalized = assertSuccess(fixture.frameworkRoot, ["vault", "normalize", decisionsPath]);
  assert.equal(normalized.data.decisions, 2);
  assert.equal(normalized.data.moves, 2);
  assert.equal(normalized.data.changeInput.moves.some((move) => move.from === "Projects/My AI Note.md"), true);
  assert.equal(
    normalized.data.changeInput.writes.some((write) => write.path === "Projects/My AI Note.md" && write.beforeMove === true),
    true,
  );
  assert.deepEqual(snapshotVaultContent(fixture.vaultPath), before);
  assert.equal(fixture.git(["status", "--short"]).stdout, beforeGitStatus);

  const changePath = path.join(tmpdir("normalization-change"), "change.json");
  writeJson(changePath, normalized.data.changeInput);
  const created = assertSuccess(fixture.frameworkRoot, ["change", "create", "--input", changePath]);
  assertSuccess(fixture.frameworkRoot, [
    "change", "apply", "--id", created.data.id, "--revision", created.data.revision,
  ]);
  assert.equal(fs.existsSync(path.join(fixture.vaultPath, "Projects", "My AI Note.md")), false);
  assert.equal(fs.existsSync(path.join(fixture.vaultPath, "Pasted Image.PNG")), false);
  const moved = fs.readFileSync(path.join(fixture.vaultPath, "01-projects/ai/recipes/my-ai-note.md"), "utf8");
  assert.match(moved, /  - ai\n  - recipes/);
  assert.match(moved, /\[\[02-knowledge\/food\/recipes\/ai-recipe-prompts\]\]/);
  assert.equal(fs.existsSync(path.join(fixture.vaultPath, "05-assets/pasted-image.png")), true);
  assert.match(
    fs.readFileSync(path.join(fixture.vaultPath, "Areas/Index.md"), "utf8"),
    /\[\[01-projects\/ai\/recipes\/my-ai-note\|My AI Note\]\]/,
  );
  assert.match(
    fs.readFileSync(path.join(fixture.vaultPath, "02-knowledge/food/recipes/ai-recipe-prompts.md"), "utf8"),
    /source: \[\[01-projects\/ai\/recipes\/my-ai-note\]\]/,
  );

  const incompletePath = path.join(tmpdir("normalization-incomplete"), "decisions.jsonl");
  writeText(incompletePath, `${JSON.stringify({ ...decisions[0], reviewed: false })}\n`);
  const failed = run(fixture.frameworkRoot, ["vault", "normalize", incompletePath]);
  assert.equal(failed.result.status, 1);
  assert.equal(failed.envelope.error.code, "vault-normalize-review-required");
});

test("normalization rejects an unsafe existing target during planning", () => {
  const fixture = createProjectFixture({
    git: true,
    vaultFiles: {
      "Projects/My AI Note.md": "# My AI Note\n",
    },
  });
  const outsidePath = path.join(tmpdir("normalization-hard-link-source"), "outside.md");
  const targetPath = path.join(fixture.vaultPath, "01-projects/ai/recipes/hard-target.md");
  writeText(outsidePath, "outside hard-link canary\n");
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.linkSync(outsidePath, targetPath);
  const decisionsPath = path.join(tmpdir("normalization-hard-link-decision"), "decisions.jsonl");
  writeText(decisionsPath, `${JSON.stringify({
    source_path: "Projects/My AI Note.md",
    target_path: "01-projects/ai/recipes/hard-target.md",
    reviewed: true,
    reviewed_scope: ["placement", "tags", "links", "content"],
    approved_tags: ["ai", "recipes"],
    links_to_add: [],
    unresolved_questions: [],
  })}\n`);

  const failed = run(fixture.frameworkRoot, ["vault", "normalize", decisionsPath]);
  assert.equal(failed.result.status, 1);
  assert.equal(failed.envelope.error.code, "vault-normalize-target-invalid");
  assert.doesNotMatch(JSON.stringify(failed.envelope), /outside hard-link canary/);
});

test("normalization rejects a symlink target during planning", () => {
  const fixture = createProjectFixture({
    git: true,
    vaultFiles: {
      "Projects/My AI Note.md": "# My AI Note\n",
    },
  });
  const outsidePath = path.join(tmpdir("normalization-symlink-source"), "outside.md");
  const targetPath = path.join(fixture.vaultPath, "01-projects/ai/recipes/symlink-target.md");
  writeText(outsidePath, "outside symlink canary\n");
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.symlinkSync(outsidePath, targetPath);
  const decisionsPath = path.join(tmpdir("normalization-symlink-decision"), "decisions.jsonl");
  writeText(decisionsPath, `${JSON.stringify({
    source_path: "Projects/My AI Note.md",
    target_path: "01-projects/ai/recipes/symlink-target.md",
    reviewed: true,
    reviewed_scope: ["placement", "tags", "links", "content"],
    approved_tags: ["ai", "recipes"],
    links_to_add: [],
    unresolved_questions: [],
  })}\n`);

  const failed = run(fixture.frameworkRoot, ["vault", "normalize", decisionsPath]);
  assert.equal(failed.result.status, 1);
  assert.equal(failed.envelope.error.code, "vault-normalize-target-invalid");
  assert.doesNotMatch(JSON.stringify(failed.envelope), /outside symlink canary/);
});

test("vault inventory reports incoming note and asset reference risks outside the selected path", () => {
  const fixture = createProjectFixture({
    vaultFiles: {
      "Projects/Target.md": "# Target\n",
      "Pasted Image.PNG": Buffer.from("image"),
      "Areas/Index.md": "![[Target]]\n![[Pasted Image.PNG]]\n",
    },
  });

  const response = assertSuccess(fixture.frameworkRoot, ["vault", "inventory", "Projects/Target.md", "Pasted Image.PNG"]);
  const target = response.data.items.find((item) => item.sourcePath === "Projects/Target.md");
  const asset = response.data.items.find((item) => item.sourcePath === "Pasted Image.PNG");
  assert.deepEqual(target.risk, { linkUpdateNeeded: true, attachmentRisk: true });
  assert.deepEqual(asset.risk, { linkUpdateNeeded: true, attachmentRisk: true });
});

test("vault inventory refuses an oversized review result without emitting link arrays", () => {
  const links = Array.from(
    { length: 8_000 },
    (_, index) => `[[05-assets/really-long-reference-name-${index}.png]]`,
  ).join("\n");
  const fixture = createProjectFixture({
    vaultFiles: {
      "Projects/Large Links.md": links,
    },
  });
  const failed = run(fixture.frameworkRoot, ["vault", "inventory", "Projects/Large Links.md"]);
  assert.equal(failed.result.status, 1);
  assert.equal(failed.envelope.error.code, "vault-inventory-output-too-large");
  assert.doesNotMatch(JSON.stringify(failed.envelope), /really-long-reference-name-0/);
});

test("maintenance planners refuse change inputs that exceed the bounded review output", () => {
  const largeBody = "x".repeat(600 * 1024);
  const normalization = createProjectFixture({
    vaultFiles: {
      "01-projects/ai/recipes/large.md": `# Large\n\n${largeBody}\n`,
    },
  });
  const decisionsPath = path.join(tmpdir("normalization-large-decision"), "decisions.jsonl");
  writeText(decisionsPath, `${JSON.stringify({
    source_path: "01-projects/ai/recipes/large.md",
    target_path: "01-projects/ai/recipes/large.md",
    reviewed: true,
    reviewed_scope: ["placement", "tags", "links", "content"],
    approved_tags: ["ai", "recipes"],
    links_to_add: [],
    unresolved_questions: [],
  })}\n`);
  const normalizationFailure = run(normalization.frameworkRoot, ["vault", "normalize", decisionsPath]);
  assert.equal(normalizationFailure.result.status, 1);
  assert.equal(normalizationFailure.envelope.error.code, "vault-normalize-output-too-large");
  assert.doesNotMatch(JSON.stringify(normalizationFailure.envelope), /xxxxxxxx/);

  const directory = createProjectFixture({
    vaultFiles: {
      "02-knowledge/games/_games.md": `Old lead.\n\n## Notes\n\n${largeBody}\n\n## Pages\n\n- stale\n`,
      "02-knowledge/games/board-games.md": "Board game notes cover strategy.\n",
    },
  });
  const directoryFailure = run(directory.frameworkRoot, ["vault", "directory-index", "02-knowledge/games"]);
  assert.equal(directoryFailure.result.status, 1);
  assert.equal(directoryFailure.envelope.error.code, "directory-index-output-too-large");
  assert.doesNotMatch(JSON.stringify(directoryFailure.envelope), /xxxxxxxx/);
});

test("directory index planning emits changed full bodies and preserves human Notes without direct writes", () => {
  const fixture = createProjectFixture({
    git: true,
    vaultFiles: {
      "02-knowledge/games/_games.md": "Old lead.\n\n## Notes\n\nKeep this exact.\n\n## Pages\n\n- stale\n",
      "02-knowledge/games/board-games.md": "Board game notes cover strategy.\n",
    },
  });
  const before = snapshotVaultContent(fixture.vaultPath);
  const beforeGitStatus = fixture.git(["status", "--short"]).stdout;
  const planned = assertSuccess(fixture.frameworkRoot, ["vault", "directory-index", "02-knowledge/games"]);
  assert.deepEqual(planned.data.changedPaths, ["02-knowledge/games/_games.md"]);
  assert.equal(planned.data.changeInput.writes.length, 1);
  assert.match(planned.data.changeInput.writes[0].body, /## Notes\n\nKeep this exact\./);
  assert.deepEqual(snapshotVaultContent(fixture.vaultPath), before);
  assert.equal(fixture.git(["status", "--short"]).stdout, beforeGitStatus);
});

test("normalization change apply matches the retained remap implementation", () => {
  const vaultFiles = {
    "Projects/Legacy Note.md": "---\ntags:\n  - recipes\n---\n# Legacy Note\n\n[[Legacy Note]]\n",
    "Areas/Index.md": "[[Legacy Note]]\n[legacy](Projects/Legacy Note.md)\n",
  };
  const current = createProjectFixture({ git: true, vaultFiles });
  const legacy = createProjectFixture({ git: true, vaultFiles });
  const decisions = [{
    source_path: "Projects/Legacy Note.md",
    target_path: "03-sources/legacy-note.md",
    reviewed: true,
    reviewed_scope: ["placement", "tags", "links", "content"],
    approved_tags: ["ai", "recipes"],
    links_to_add: ["02-knowledge/food/recipes/ai-recipe-prompts.md"],
    unresolved_questions: [],
  }];
  const decisionsPath = path.join(tmpdir("normalization-parity-decisions"), "decisions.jsonl");
  writeText(decisionsPath, `${decisions.map((decision) => JSON.stringify(decision)).join("\n")}\n`);

  const planned = assertSuccess(current.frameworkRoot, ["vault", "normalize", decisionsPath]);
  const changePath = path.join(tmpdir("normalization-parity-change"), "change.json");
  writeJson(changePath, planned.data.changeInput);
  const created = assertSuccess(current.frameworkRoot, ["change", "create", "--input", changePath]);
  assertSuccess(current.frameworkRoot, ["change", "apply", "--id", created.data.id, "--revision", created.data.revision]);

  const indexes = tmpdir("normalization-parity-indexes");
  writeText(
    path.join(indexes, "ai-review-decisions.jsonl"),
    `${decisions.map((decision) => JSON.stringify(decision)).join("\n")}\n`,
  );
  const applied = spawnSync(
    "python3",
    [
      path.join(projectRoot, "scripts", "apply-vault-remap.py"),
      "--vault", legacy.vaultPath,
      "--indexes", indexes,
      "--tags", path.join(legacy.frameworkRoot, "taxonomy", "approved-tags.md"),
    ],
    { cwd: projectRoot, encoding: "utf8" },
  );
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(visibleVaultSnapshot(current.vaultPath), visibleVaultSnapshot(legacy.vaultPath));
});

test("directory index change apply matches the retained owner-note migration", () => {
  const ownerBody = [
    "# Project Zomboid",
    "",
    "Related: [[games]]",
    "",
    "Project Zomboid hub for run planning, spawn notes, Lua commands, and helper references.",
    "",
    "## Build",
    "",
    "Useful setup details.",
    "",
  ].join("\n");
  const vaultFiles = {
    "02-knowledge/games/project-zomboid/project-zomboid.md": ownerBody,
    "02-knowledge/games/project-zomboid/sandbox-settings.md": "Sandbox settings cover population and loot tuning.\n",
    "02-knowledge/games/links.md": [
      "[[project-zomboid]]",
      "[[02-knowledge/games/project-zomboid/project-zomboid#Build|Build notes]]",
      "[guide](02-knowledge/games/project-zomboid/project-zomboid.md#Build)",
      "",
    ].join("\n"),
  };
  const current = createProjectFixture({ git: true, vaultFiles });
  const legacy = createProjectFixture({ git: true, vaultFiles });
  const before = snapshotVaultContent(current.vaultPath);
  const beforeGitStatus = current.git(["status", "--short"]).stdout;

  const planned = assertSuccess(current.frameworkRoot, ["vault", "directory-index"]);
  const ownerWrite = planned.data.changeInput.writes.find((write) =>
    write.path === "02-knowledge/games/project-zomboid/project-zomboid.md");
  assert.equal(ownerWrite.beforeMove, true);
  assert.equal(
    planned.data.changeInput.moves.some((move) =>
      move.from === "02-knowledge/games/project-zomboid/project-zomboid.md"
      && move.to === "02-knowledge/games/project-zomboid/_project-zomboid.md"),
    true,
  );
  assert.deepEqual(snapshotVaultContent(current.vaultPath), before);
  assert.equal(current.git(["status", "--short"]).stdout, beforeGitStatus);

  const changePath = path.join(tmpdir("directory-index-parity-change"), "change.json");
  writeJson(changePath, planned.data.changeInput);
  const created = assertSuccess(current.frameworkRoot, ["change", "create", "--input", changePath]);
  assertSuccess(current.frameworkRoot, ["change", "apply", "--id", created.data.id, "--revision", created.data.revision]);

  const migrated = spawnSync(
    process.execPath,
    [path.join(projectRoot, "dist", "cli.js"), "migrate-directory-indexes", "--vault", legacy.vaultPath, "--write"],
    { cwd: projectRoot, encoding: "utf8" },
  );
  assert.equal(migrated.status, 0, migrated.stderr);
  assert.deepEqual(visibleVaultSnapshot(current.vaultPath), visibleVaultSnapshot(legacy.vaultPath));
});

function visibleVaultSnapshot(vaultPath) {
  return snapshotVaultContent(vaultPath).filter((entry) => !entry.path.startsWith(".git/"));
}
