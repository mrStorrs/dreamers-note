import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  initGitRepository,
  projectRoot,
  tmpdir,
  writeText,
} from "./helpers/project-fixtures.mjs";

function migration(vaultPath, ...args) {
  return spawnSync(
    process.execPath,
    ["dist/cli.js", "migrate-directory-indexes", "--vault", vaultPath, ...args],
    { cwd: projectRoot, encoding: "utf8" },
  );
}

test("TypeScript migration dry-run reports recursive indexes without mutation", () => {
  const vault = tmpdir("directory-index-migration-dry-run");
  writeText(
    path.join(vault, "01-projects/linux-install/install-plan.md"),
    "Install notes for a Linux workstation.\n",
  );
  writeText(
    path.join(vault, "02-knowledge/games/project-zomboid/project-zomboid.md"),
    "Project Zomboid owner notes.\n",
  );
  initGitRepository(vault, { branch: "directory-index-fixture" });

  const result = migration(vault, "--dry-run");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /mode: dry-run/);
  assert.match(result.stdout, /eligible directories: 3/);
  assert.match(result.stdout, /created indexes: 2/);
  assert.match(result.stdout, /renamed owner notes: 1/);
  assert.match(result.stdout, /02-knowledge\/games\/_games\.md/);
  assert.match(result.stdout, /02-knowledge\/games\/project-zomboid\/_project-zomboid\.md/);
  assert.equal(
    fs.existsSync(path.join(vault, "02-knowledge/games/project-zomboid/project-zomboid.md")),
    true,
  );
  assert.equal(fs.existsSync(path.join(vault, "02-knowledge/games/_games.md")), false);
  assert.equal(spawnSync("git", ["-C", vault, "status", "--short"], { encoding: "utf8" }).stdout, "");
});

test("TypeScript migration renames owner notes and rewrites wiki and Markdown links", () => {
  const vault = tmpdir("directory-index-migration-write");
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
  writeText(path.join(vault, "02-knowledge/games/project-zomboid/project-zomboid.md"), ownerBody);
  writeText(
    path.join(vault, "02-knowledge/games/project-zomboid/sandbox-settings.md"),
    "Sandbox settings cover population and loot tuning.\n",
  );
  writeText(
    path.join(vault, "02-knowledge/games/links.md"),
    [
      "[[project-zomboid]]",
      "[[02-knowledge/games/project-zomboid/project-zomboid#Build|Build notes]]",
      "[guide](02-knowledge/games/project-zomboid/project-zomboid.md#Build)",
      "",
    ].join("\n"),
  );
  initGitRepository(vault, { branch: "directory-index-fixture" });

  const result = migration(vault, "--write");

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /mode: write/);
  assert.match(result.stdout, /renamed owner notes: 1/);
  const indexPath = path.join(vault, "02-knowledge/games/project-zomboid/_project-zomboid.md");
  assert.equal(fs.existsSync(path.join(vault, "02-knowledge/games/project-zomboid/project-zomboid.md")), false);
  const indexText = fs.readFileSync(indexPath, "utf8");
  assert.equal(
    indexText.split(/\r?\n/)[0],
    "Project Zomboid covers run planning, spawn notes, Lua commands, and helper references.",
  );
  assert.match(indexText, new RegExp(`## Notes\\n\\n${escapeRegExp(ownerBody)}`));
  assert.match(indexText, /## Pages/);
  assert.match(indexText, /\[\[02-knowledge\/games\/project-zomboid\/sandbox-settings\|Sandbox Settings\]\]/);
  const linksText = fs.readFileSync(path.join(vault, "02-knowledge/games/links.md"), "utf8");
  assert.match(linksText, /\[\[02-knowledge\/games\/project-zomboid\/_project-zomboid\|project-zomboid\]\]/);
  assert.match(linksText, /\[\[02-knowledge\/games\/project-zomboid\/_project-zomboid#Build\|Build notes\]\]/);
  assert.match(linksText, /\[guide\]\(02-knowledge\/games\/project-zomboid\/_project-zomboid\.md#Build\)/);

  initGitRepository(vault, { message: "commit migrated directory indexes" });
  const refreshed = migration(vault, "--write");
  assert.equal(refreshed.status, 0, `${refreshed.stdout}\n${refreshed.stderr}`);
  assert.equal(fs.readFileSync(indexPath, "utf8"), indexText);
  assert.match(fs.readFileSync(indexPath, "utf8"), /## Build\n\nUseful setup details\./);
});

test("TypeScript migration uses the canonical renderer for topics, metadata, and Notes", () => {
  const vault = tmpdir("directory-index-migration-render");
  const preserved = "\n\nKeep this human-owned summary exactly as written.\n\n### Detail\n\nNested detail.\n";
  writeText(
    path.join(vault, "02-knowledge/games/_games.md"),
    `Old lead.\n\n## Notes${preserved}\n## Pages\n\n- stale\n`,
  );
  writeText(
    path.join(vault, "02-knowledge/games/board-games.md"),
    "Related: [[games]]\n\nCaptured: 2026-07-04\n\nBoard game notes cover strategy.\n",
  );
  writeText(
    path.join(vault, "02-knowledge/games/project-zomboid/servers.md"),
    "Server notes cover hosting.\n",
  );
  initGitRepository(vault, { branch: "directory-index-fixture" });

  const result = migration(vault, "--write");

  assert.equal(result.status, 0, result.stderr);
  const index = fs.readFileSync(path.join(vault, "02-knowledge/games/_games.md"), "utf8");
  assert.equal(index.includes("Old lead."), false);
  assert.equal(index.includes(preserved), true);
  assert.match(index, /## Subfolders/);
  assert.match(index, /\[\[02-knowledge\/games\/project-zomboid\/_project-zomboid\|Project Zomboid\]\]/);
  assert.match(index, /\[\[02-knowledge\/games\/board-games\|Board Games\]\] - Board game notes cover strategy\./);
  assert.doesNotMatch(index, /- Related: Games/);
});

test("TypeScript migration rejects dirty vaults and malformed existing indexes", () => {
  const dirtyVault = tmpdir("directory-index-migration-dirty");
  writeText(path.join(dirtyVault, "02-knowledge/games/board-games.md"), "Board game notes.\n");
  initGitRepository(dirtyVault, { branch: "directory-index-fixture" });
  writeText(path.join(dirtyVault, "unrelated.md"), "uncommitted work\n");

  const dirty = migration(dirtyVault, "--dry-run");
  assert.equal(dirty.status, 2);
  assert.match(dirty.stderr, /vault worktree is dirty/);
  assert.equal(fs.existsSync(path.join(dirtyVault, "02-knowledge/games/_games.md")), false);

  const malformedVault = tmpdir("directory-index-migration-malformed");
  const malformedPath = path.join(malformedVault, "02-knowledge/games/_games.md");
  writeText(malformedPath, "Unstructured content that must not be replaced.\n");
  writeText(path.join(malformedVault, "02-knowledge/games/board-games.md"), "Board game notes.\n");
  initGitRepository(malformedVault, { branch: "directory-index-fixture" });

  const malformed = migration(malformedVault, "--write");
  assert.equal(malformed.status, 2);
  assert.match(malformed.stderr, /index conflict/);
  assert.equal(fs.readFileSync(malformedPath, "utf8"), "Unstructured content that must not be replaced.\n");
});

test("TypeScript migration rejects contradictory dry-run and write flags", () => {
  const vault = tmpdir("directory-index-migration-mode");
  writeText(path.join(vault, "02-knowledge/games/board-games.md"), "Board game notes.\n");
  initGitRepository(vault, { branch: "directory-index-fixture" });

  const result = migration(vault, "--dry-run", "--write");

  assert.equal(result.status, 2);
  assert.match(result.stderr, /mutually exclusive/);
  assert.equal(fs.existsSync(path.join(vault, "02-knowledge/games/_games.md")), false);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
