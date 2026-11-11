import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const project = fileURLToPath(new URL("../", import.meta.url));
const skills = JSON.parse(fs.readFileSync(path.join(project, "config/managed-skills.json"), "utf8")).skills;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "note-install-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const framework = path.join(root, "framework");
  for (const source of [".codex/skills", "config/managed-skills.json", "scripts/install.mjs",
    "scripts/build-note-index.mjs", "docs/note-workflow-policy.md", "taxonomy/approved-tags.md", "bootstrap.sh"]) {
    const target = path.join(framework, source);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(project, source), target, { recursive: true });
  }
  const vault = path.join(root, "vault");
  const codex = path.join(root, "codex");
  const copilot = path.join(root, "copilot");
  for (const directory of [vault, codex, copilot]) fs.mkdirSync(directory);
  const destinations = [path.join(vault, ".codex/skills"), path.join(codex, "skills"), path.join(copilot, "skills")];
  const env = { ...process.env, VAULT_PATH: vault, CODEX_HOME: codex, COPILOT_HOME: copilot };
  function run(args = [], bootstrap = false, overrides = {}) {
    return spawnSync(bootstrap ? "bash" : process.execPath,
      [path.join(framework, bootstrap ? "bootstrap.sh" : "scripts/install.mjs"), ...args],
      { env: { ...env, ...overrides }, cwd: root, encoding: "utf8" });
  }
  return { root, framework, vault, copilot, destinations, run };
}

function write(target, body) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
}

function tree(directory) {
  if (!fs.existsSync(directory)) return {};
  const result = {};
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    result[entry.name] = entry.isDirectory() ? tree(target)
      : entry.isSymbolicLink() ? { link: fs.readlinkSync(target) }
      : fs.readFileSync(target, "utf8");
  }
  return result;
}

test("source-only bootstrap installs all five skills and usable vault locators", t => {
  const f = fixture(t);
  assert.equal(fs.existsSync(path.join(f.framework, "dist")), false);
  assert.equal(fs.existsSync(path.join(f.framework, "node_modules")), false);
  assert.equal(fs.existsSync(path.join(f.framework, "package.json")), false);
  write(path.join(f.vault, "01-projects/sample/note.md"), "source note");
  for (const destination of f.destinations) {
    write(path.join(destination, "retired-managed/SKILL.md"), "old");
    write(path.join(destination, "personal/SKILL.md"), "personal");
    write(path.join(destination, ".dreamers-note-managed-skills"), "retired-managed\n");
  }
  const clientConfig = path.join(f.copilot, "mcp-config.json");
  write(clientConfig, '{"unrelated":"preserve this verbatim"}\n');
  const result = f.run([f.vault], true);
  assert.equal(result.status, 0, result.stderr);
  for (const destination of f.destinations) {
    for (const skill of skills) {
      assert.deepEqual(tree(path.join(destination, skill)), tree(path.join(f.framework, ".codex/skills", skill)));
    }
    assert.equal(fs.existsSync(path.join(destination, "retired-managed")), false);
    assert.equal(fs.readFileSync(path.join(destination, "personal/SKILL.md"), "utf8"), "personal");
    const locator = JSON.parse(fs.readFileSync(path.join(destination, ".dreamers-note-install.json"), "utf8"));
    assert.deepEqual(locator, { framework_root: f.framework });
    const settings = JSON.parse(fs.readFileSync(path.join(locator.framework_root, "config/vault.local.json"), "utf8"));
    assert.equal(settings.vault_path, f.vault);
    assert.ok(fs.existsSync(path.join(locator.framework_root, "docs/note-workflow-policy.md")));
    const indexed = spawnSync(process.execPath, [path.join(locator.framework_root, "scripts/build-note-index.mjs"), settings.vault_path],
      { cwd: path.join(destination, "note-add"), encoding: "utf8" });
    assert.equal(indexed.status, 0, indexed.stderr);
  }
  assert.equal(fs.readFileSync(clientConfig, "utf8"), '{"unrelated":"preserve this verbatim"}\n');
  assert.equal(fs.readFileSync(path.join(f.vault, "01-projects/sample/note.md"), "utf8"), "source note");
  assert.equal(f.run([], false, { VAULT_PATH: "" }).status, 0);
});

test("first install works without a directory and later uses the setting saved by a skill", t => {
  const f = fixture(t);
  const settingsPath = path.join(f.framework, "config/vault.local.json");
  const result = f.run([], false, { VAULT_PATH: "" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(settingsPath), false);
  assert.equal(fs.existsSync(f.destinations[0]), false);
  for (const destination of f.destinations.slice(1)) {
    assert.ok(fs.existsSync(path.join(destination, "note-add/SKILL.md")));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(destination, ".dreamers-note-install.json"), "utf8")),
      { framework_root: f.framework });
  }

  // This is the settings write performed after the user answers a skill's setup question.
  write(settingsPath, JSON.stringify({ vault_path: f.vault, preference: "preserve" }) + "\n");
  const saved = fs.readFileSync(settingsPath, "utf8");
  assert.equal(f.run([], false, { VAULT_PATH: "" }).status, 0);
  assert.equal(fs.readFileSync(settingsPath, "utf8"), saved);
  assert.ok(fs.existsSync(path.join(f.destinations[0], "note-add/SKILL.md")));

  const replacement = path.join(f.root, "new-notes");
  fs.mkdirSync(replacement);
  assert.equal(f.run([replacement], false, { VAULT_PATH: "" }).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")),
    { vault_path: replacement, preference: "preserve" });
  for (const destination of f.destinations.slice(1)) {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(destination, ".dreamers-note-install.json"), "utf8")),
      { framework_root: f.framework });
  }
});

test("malformed and symlinked settings are not replaced or read through", t => {
  const f = fixture(t);
  const settingsPath = path.join(f.framework, "config/vault.local.json");
  write(settingsPath, "{malformed");
  assert.notEqual(f.run().status, 0);
  assert.equal(fs.readFileSync(settingsPath, "utf8"), "{malformed");
  assert.equal(fs.existsSync(f.destinations[0]), false);
  assert.equal(fs.existsSync(f.destinations[1]), false);
  assert.equal(fs.existsSync(f.destinations[2]), false);

  fs.unlinkSync(settingsPath);
  const canary = path.join(f.root, "other-settings.json");
  write(canary, JSON.stringify({ vault_path: f.vault }));
  fs.symlinkSync(canary, settingsPath);
  assert.notEqual(f.run().status, 0);
  assert.ok(fs.lstatSync(settingsPath).isSymbolicLink());
  assert.equal(fs.readFileSync(canary, "utf8"), JSON.stringify({ vault_path: f.vault }));
  assert.equal(fs.existsSync(f.destinations[1]), false);
});

test("dry run leaves all destinations untouched and an unmanaged collision blocks every copy", t => {
  const f = fixture(t);
  const before = tree(f.root);
  const preview = f.run(["--dry-run"]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /would copy canonical skill/);
  assert.deepEqual(tree(f.root), before);
  write(path.join(f.destinations[2], "note-add/SKILL.md"), "my own skill");
  const collision = tree(f.root);
  assert.notEqual(f.run().status, 0);
  assert.deepEqual(tree(f.root), collision);
});

test("symlink targets and ancestor directories fail preflight without following them", async t => {
  for (const kind of ["skills", "skill", "manifest", "locator", "ancestor"]) {
    await t.test(kind, t => {
      const f = fixture(t);
      const destination = f.destinations[2];
      const target = kind === "ancestor" ? path.dirname(destination)
        : kind === "skills" ? destination
        : path.join(destination, kind === "skill" ? "note-add"
          : kind === "manifest" ? ".dreamers-note-managed-skills" : ".dreamers-note-install.json");
      if (kind === "ancestor") fs.rmdirSync(target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(path.join(f.root, "missing"), target);
      assert.notEqual(f.run().status, 0);
      assert.ok(fs.lstatSync(target).isSymbolicLink());
      assert.equal(fs.existsSync(path.join(f.destinations[0], "note-import")), false);
      assert.equal(fs.existsSync(path.join(f.destinations[1], "note-import")), false);
      assert.equal(fs.existsSync(path.join(f.root, "missing")), false);
    });
  }
});
