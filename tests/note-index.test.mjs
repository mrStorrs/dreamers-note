import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../scripts/build-note-index.mjs", import.meta.url));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "note-index-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = path.join(root, "vault");
  fs.mkdirSync(vault);
  return { root, vault };
}

function write(vault, relative, body = "note body") {
  const target = path.join(vault, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
  return target;
}

function run(vault) {
  return spawnSync(process.execPath, [script, vault], { encoding: "utf8" });
}

test("index lists sorted Markdown links without reading bodies or exposing excluded paths", t => {
  const { root, vault } = fixture(t);
  const visible = ["02-knowledge/a/topic.md", "01-projects/b/plan.md", "spaces/[draft] café (v1)#.MD"];
  for (const name of visible) write(vault, name, "BODY_CANARY");
  for (const name of [".git/hidden.md", ".obsidian/private.md", ".codex/skills/private.md",
    ".dreamers-note-runtime/private.md", "07-system/secrets/credential.md", "07-system/SECRETS/nested/private.md",
    "02-knowledge/.hidden/private.md", "binary.pdf", "line\ninjection.md"]) write(vault, name, "PRIVATE_CANARY");
  const outside = write(root, "outside/private.md", "EXTERNAL_CANARY");
  fs.symlinkSync(path.dirname(outside), path.join(vault, "linked-directory"));
  fs.symlinkSync(outside, path.join(vault, "linked-note.md"));

  const result = run(vault);
  assert.equal(result.status, 0, result.stderr);
  const index = fs.readFileSync(path.join(vault, "note-index.md"), "utf8");
  assert.match(result.stdout, /3 notes/);
  assert.equal(index.includes("BODY_CANARY"), false);
  assert.doesNotMatch(index, /PRIVATE_CANARY|EXTERNAL_CANARY|credential|private|linked-|binary|injection/);
  const links = [...index.matchAll(/\]\(\.\/(.+)\)/g)].map(match => decodeURIComponent(match[1]));
  assert.deepEqual(links, [...visible].sort());
  assert.match(index, /%5Bdraft%5D%20caf%C3%A9%20%28v1%29%23\.MD/);
  for (const name of visible) assert.equal(fs.readFileSync(path.join(vault, name), "utf8"), "BODY_CANARY");
  assert.equal(fs.readFileSync(outside, "utf8"), "EXTERNAL_CANARY");
});

test("regeneration is stable and follows path changes without touching folder homepages", t => {
  const { vault } = fixture(t);
  const original = write(vault, "01-projects/topic/old.md");
  const homepage = write(vault, "01-projects/topic/_topic.md", "## Notes\n\nKeep my writing.\n");
  assert.equal(run(vault).status, 0);
  const indexFile = path.join(vault, "note-index.md");
  const before = fs.readFileSync(indexFile, "utf8");
  const beforeTime = fs.statSync(indexFile).mtimeMs;
  assert.match(run(vault).stdout, /unchanged/);
  assert.equal(fs.readFileSync(indexFile, "utf8"), before);
  assert.equal(fs.statSync(indexFile).mtimeMs, beforeTime);
  fs.renameSync(original, path.join(path.dirname(original), "new.md"));
  assert.equal(run(vault).status, 0);
  const after = fs.readFileSync(indexFile, "utf8");
  assert.doesNotMatch(after, /old\.md/);
  assert.match(after, /new\.md/);
  assert.equal(fs.readFileSync(homepage, "utf8"), "## Notes\n\nKeep my writing.\n");
  assert.equal(fs.readdirSync(vault).some(name => name.startsWith(".note-index-")), false);
});

test("a handwritten index and symlink destinations are preserved", t => {
  const { root, vault } = fixture(t);
  const index = write(vault, "note-index.md", "# My handwritten index\n");
  assert.notEqual(run(vault).status, 0);
  assert.equal(fs.readFileSync(index, "utf8"), "# My handwritten index\n");
  fs.unlinkSync(index);
  const canary = write(root, "external.md", "do not change");
  fs.symlinkSync(canary, index);
  assert.notEqual(run(vault).status, 0);
  assert.equal(fs.readFileSync(canary, "utf8"), "do not change");
  assert.ok(fs.lstatSync(index).isSymbolicLink());
  const alias = path.join(root, "vault-alias");
  fs.symlinkSync(vault, alias);
  assert.notEqual(run(alias).status, 0);
});

test("an empty vault works and broad or relative targets are refused", t => {
  const { vault } = fixture(t);
  assert.equal(run(vault).status, 0);
  assert.equal(run(vault).stdout.includes("0 notes (unchanged)"), true);
  assert.notEqual(run(".").status, 0);
  assert.notEqual(run(path.parse(vault).root).status, 0);
  assert.notEqual(run(os.homedir()).status, 0);
});
