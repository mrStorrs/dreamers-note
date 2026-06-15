import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  distDir,
  loadBuiltPackage,
  makeFrameworkRoot,
  mkdirp,
  projectRoot,
  tmpdir,
  writeText,
} from "./helpers/project-fixtures.mjs";

const root = projectRoot;
const dist = distDir;

function loadPackage() {
  return loadBuiltPackage();
}

function listFiles(base) {
  if (!fs.existsSync(base)) {
    return [];
  }
  const results = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    const absolute = path.join(base, entry.name);
    if (entry.isDirectory()) {
      for (const child of listFiles(absolute)) {
        results.push(path.join(entry.name, child));
      }
    } else if (entry.isFile()) {
      results.push(entry.name);
    }
  }
  return results.sort();
}

function listTree(base) {
  if (!fs.existsSync(base)) {
    return [];
  }
  const results = [];
  const visit = (current, relative) => {
    const stat = fs.lstatSync(current);
    if (stat.isDirectory()) {
      results.push(`${relative || "."}/`);
      for (const entry of fs.readdirSync(current)) {
        visit(path.join(current, entry), relative ? path.join(relative, entry) : entry);
      }
      return;
    }
    results.push(relative);
  };
  visit(base, "");
  return results.map((entry) => entry.split(path.sep).join("/")).sort();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    text: true,
    encoding: "utf8",
    timeout: 30_000,
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

test("package metadata, build output, and doctor command exist without mutating the vault", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.name, "dreamers-note");
  assert.equal(pkg.private, true);
  assert.equal(pkg.bin["dreamers-note"], "dist/cli.js");
  assert.equal(fs.existsSync(path.join(root, "tsconfig.json")), true);
  assert.equal(fs.existsSync(path.join(dist, "cli.js")), true);

  const vault = tmpdir("dreamers-note-vault");
  writeText(path.join(vault, "01-projects", "ai", "notes", "existing.md"), "existing\n");
  const frameworkRoot = makeFrameworkRoot(vault);
  const before = listFiles(vault);

  const result = run("node", [path.join(dist, "cli.js"), "doctor", "--root", frameworkRoot]);

  assert.match(result.stdout, /dreamers-note package foundation/);
  assert.match(result.stdout, new RegExp(vault.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.deepEqual(listFiles(vault), before);
  assert.equal(fs.existsSync(path.join(vault, ".dreamers-note-runtime")), false);
});

test("vault config validation returns structured errors and creates no vault files", () => {
  const {
    loadVaultConfig,
    validateVaultConfig,
  } = loadPackage();
  const rootDir = tmpdir("dreamers-note-config");
  const expectedRoot = path.join(rootDir, "allowed");
  const missingVault = path.join(expectedRoot, "missing");
  mkdirp(path.dirname(missingVault));
  writeText(
    path.join(rootDir, "config", "vault.json"),
    `${JSON.stringify({ vault_path: missingVault }, null, 2)}\n`,
  );

  const loaded = loadVaultConfig({ rootDir });
  assert.equal(loaded.ok, true);
  const missing = validateVaultConfig(loaded.value, { expectedVaultRoot: expectedRoot });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "vault-missing");
  assert.equal(fs.existsSync(missingVault), false);

  const outside = path.join(rootDir, "outside-vault");
  mkdirp(outside);
  const outsideBefore = listTree(outside);
  const outsideResult = validateVaultConfig(
    { vaultPath: outside, configPath: path.join(rootDir, "config", "vault.json") },
    { expectedVaultRoot: expectedRoot },
  );
  assert.equal(outsideResult.ok, false);
  assert.equal(outsideResult.error.code, "vault-outside-boundary");
  assert.deepEqual(listTree(outside), outsideBefore);

  const symlinkTarget = path.join(rootDir, "symlink-target");
  const symlinkVault = path.join(expectedRoot, "symlink-vault");
  mkdirp(symlinkTarget);
  fs.symlinkSync(symlinkTarget, symlinkVault);
  const symlinkBefore = listTree(symlinkTarget);
  const symlinkResult = validateVaultConfig(
    { vaultPath: symlinkVault, configPath: path.join(rootDir, "config", "vault.json") },
    { expectedVaultRoot: expectedRoot },
  );
  assert.equal(symlinkResult.ok, false);
  assert.equal(symlinkResult.error.code, "vault-symlink");
  assert.deepEqual(listTree(symlinkTarget), symlinkBefore);

  const unreadable = path.join(expectedRoot, "unreadable");
  mkdirp(unreadable);
  writeText(path.join(unreadable, "existing.md"), "existing\n");
  const unreadableBefore = listTree(unreadable);
  fs.chmodSync(unreadable, 0o000);
  try {
    const unreadableResult = validateVaultConfig(
      { vaultPath: unreadable, configPath: path.join(rootDir, "config", "vault.json") },
      { expectedVaultRoot: expectedRoot },
    );
    assert.equal(unreadableResult.ok, false);
    assert.equal(unreadableResult.error.code, "vault-unreadable");
  } finally {
    fs.chmodSync(unreadable, 0o700);
  }
  assert.deepEqual(listTree(unreadable), unreadableBefore);
});

test("path safety rejects unsafe inputs with structured reasons before vault reads", () => {
  const { classifyVaultPath } = loadPackage();
  const vault = tmpdir("dreamers-note-paths");
  const outside = tmpdir("dreamers-note-outside");
  writeText(path.join(outside, "secret.md"), "secret\n");
  mkdirp(path.join(vault, "01-projects", "ai", "notes"));
  fs.symlinkSync(
    path.join(outside, "secret.md"),
    path.join(vault, "01-projects", "ai", "notes", "outside.md"),
  );
  fs.symlinkSync(
    path.join(outside, "missing.md"),
    path.join(vault, "01-projects", "ai", "notes", "broken.md"),
  );
  writeText(path.join(vault, "01-projects", "ai", "notes", "Case.md"), "case\n");
  writeText(path.join(vault, "01-projects", "ai", "notes", "Café.md"), "unicode\n");

  const classify = (input) =>
    classifyVaultPath({
      vaultPath: vault,
      input,
      privateGlobs: ["07-system/secrets/**"],
    });

  const valid = classify("01-projects/ai/notes/note.md");
  assert.equal(valid.ok, true);
  assert.equal(valid.value.normalizedRelativePath, "01-projects/ai/notes/note.md");

  for (const [input, code] of [
    [".git/config", "excluded-root"],
    [".obsidian/workspace.json", "excluded-root"],
    [".codex/skills/secret.md", "excluded-root"],
    ["07-system/secrets/token.md", "private-path"],
    ["../outside.md", "path-traversal"],
    [path.join(outside, "secret.md"), "outside-vault"],
    ["01-projects%2fai/notes/note.md", "encoded-separator"],
    ["01-projects/ai\u0000/notes/note.md", "control-character"],
    ["01-projects/ ai/notes/note.md", "ambiguous-whitespace"],
    ["01-projects/ai/notes/outside.md", "symlink"],
    ["01-projects/ai/notes/broken.md", "symlink"],
    ["01-projects/ai/notes/case.md", "case-collision"],
    ["01-projects/ai/notes/Cafe\u0301.md", "normalization-collision"],
  ]) {
    const result = classify(input);
    assert.equal(result.ok, false, input);
    assert.equal(result.error.code, code, input);
  }

  const missingVaultParent = tmpdir("dreamers-note-no-access-parent");
  const missingVault = path.join(missingVaultParent, "missing-vault");
  const parentBefore = listTree(missingVaultParent);
  for (const [input, code] of [
    [".git/config", "excluded-root"],
    [".obsidian/workspace.json", "excluded-root"],
    [".codex/skills/secret.md", "excluded-root"],
    ["07-system/secrets/token.md", "private-path"],
    ["../outside.md", "path-traversal"],
    [path.join(outside, "secret.md"), "outside-vault"],
    ["01-projects%2fai/notes/note.md", "encoded-separator"],
    ["01-projects/ai\u0000/notes/note.md", "control-character"],
    ["01-projects/ ai/notes/note.md", "ambiguous-whitespace"],
  ]) {
    const result = classifyVaultPath({
      vaultPath: missingVault,
      input,
      privateGlobs: ["07-system/secrets/**"],
    });
    assert.equal(result.ok, false, input);
    assert.equal(result.error.code, code, input);
  }
  assert.deepEqual(listTree(missingVaultParent), parentBefore);
  assert.equal(fs.existsSync(missingVault), false);
});

test("convention validation enforces approved roots, tags, and classification depth", () => {
  const { loadApprovedTags, loadConventionPolicy, validateConventionPath } = loadPackage();
  const frameworkRoot = makeFrameworkRoot(tmpdir("dreamers-note-vault"), {
    approvedTags: ["ai", "local-first", "obsidian", "recipes"],
  });
  const approved = loadApprovedTags(path.join(frameworkRoot, "taxonomy", "approved-tags.md"));
  const policy = loadConventionPolicy({ rootDir: frameworkRoot });

  assert.deepEqual([...approved].sort(), ["ai", "local-first", "obsidian", "recipes"]);
  assert.equal(
    validateConventionPath("01-projects/ai/obsidian/package-foundation.md", ["ai"], approved, policy).ok,
    true,
  );
  assert.equal(
    validateConventionPath(
      "02-knowledge/ai/obsidian/package-foundation.md",
      ["obsidian"],
      approved,
      policy,
    ).ok,
    true,
  );
  assert.equal(
    validateConventionPath("04-people/family/immediate/jane-doe.md", [], approved, policy).ok,
    true,
  );
  assert.equal(
    validateConventionPath("02-areas/ai/obsidian/topic.md", [], approved, policy).error.code,
    "disallowed-root",
  );
  assert.equal(
    validateConventionPath("03-knowledge/ai/obsidian/topic.md", [], approved, policy).error.code,
    "disallowed-root",
  );
  assert.equal(
    validateConventionPath("02-knowledge/ai/topic.md", [], approved, policy).error.code,
    "classification-depth",
  );
  for (const tooDeepPath of [
    "01-projects/ai/obsidian/extra/topic.md",
    "02-knowledge/ai/obsidian/extra/topic.md",
    "04-people/family/immediate/extra/jane-doe.md",
  ]) {
    assert.equal(
      validateConventionPath(tooDeepPath, [], approved, policy).error.code,
      "classification-depth",
      tooDeepPath,
    );
  }
  assert.equal(
    validateConventionPath("02-knowledge/ai/obsidian/topic.md", ["unknown-tag"], approved, policy).error
      .code,
    "unapproved-tag",
  );
});

test("runtime initialization creates Git-ignored private state files", () => {
  const { initializeRuntimeState, isRuntimeGitIgnored, loadRuntimeConfig } = loadPackage();
  const frameworkRoot = makeFrameworkRoot(tmpdir("dreamers-note-vault"));
  const runtimeConfig = loadRuntimeConfig({ rootDir: frameworkRoot });
  const runtime = initializeRuntimeState({ rootDir: frameworkRoot, config: runtimeConfig });

  assert.equal(path.basename(runtime.dataDir), ".dreamers-note-runtime");
  assert.equal(isRuntimeGitIgnored({ rootDir: frameworkRoot, dataDir: runtime.dataDir }), true);
  assert.equal(fs.statSync(runtime.dataDir).mode & 0o077, 0);
  for (const file of [runtime.databasePath, runtime.walPath, runtime.logPath]) {
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.statSync(file).mode & 0o077, 0, file);
  }
});

test("file, tag, and link primitives are reusable and exclude internal paths", () => {
  const {
    extractMarkdownLinks,
    extractTags,
    extractWikilinks,
    fileHash,
    listVaultFiles,
  } = loadPackage();
  const vault = tmpdir("dreamers-note-files");
  writeText(
    path.join(vault, "01-projects", "ai", "notes", "my-note.md"),
    "---\ntags:\n  - ai\n  - missing\n---\n[[Other Note|label]]\n![pic](assets/Pasted Image.png)\n#recipes\n",
  );
  writeText(path.join(vault, ".obsidian", "workspace.json"), "{}\n");
  writeText(path.join(vault, ".git", "config"), "git\n");
  writeText(path.join(vault, "07-system", "secrets", "token.md"), "secret\n");
  const outside = tmpdir("dreamers-note-link-outside");
  writeText(path.join(outside, "secret.md"), "secret\n");
  fs.symlinkSync(
    path.join(outside, "secret.md"),
    path.join(vault, "01-projects", "ai", "notes", "secret.md"),
  );

  const files = listVaultFiles({
    vaultPath: vault,
    selectedPaths: ["."],
    privateGlobs: ["07-system/secrets/**"],
  }).map((file) => path.relative(vault, file).split(path.sep).join("/"));
  assert.deepEqual(files, ["01-projects/ai/notes/my-note.md"]);

  const text = fs.readFileSync(path.join(vault, files[0]), "utf8");
  assert.deepEqual(extractTags(text), ["ai", "missing", "recipes"]);
  assert.deepEqual(extractWikilinks(text), ["Other Note"]);
  assert.deepEqual(extractMarkdownLinks(text), ["assets/Pasted Image.png"]);
  assert.match(fileHash(path.join(vault, files[0])), /^[a-f0-9]{64}$/);
});

test("legacy Python compatibility tests stay green", () => {
  for (const script of [
    "tests/test-daily-triage.py",
    "tests/test-vault-normalization.py",
    "tests/test-vault-remap.py",
  ]) {
    run("python3", [path.join(root, script)]);
  }
});
