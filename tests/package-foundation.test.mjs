import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
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
const require = createRequire(import.meta.url);

function loadPackage() {
  return loadBuiltPackage();
}

function loadBuiltModule(moduleName) {
  return require(path.join(dist, moduleName));
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

function unwrapResult(result) {
  assert.equal(result.ok, true, JSON.stringify(result.error ?? result));
  return result.value;
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

  assert.equal(result.stderr, "");
  assert.equal(result.stdout.endsWith("\n"), true);
  const doctor = JSON.parse(result.stdout);
  assert.equal(doctor.ok, true);
  assert.equal(doctor.command, "doctor");
  assert.equal(doctor.data.runtime.state, "missing");
  assert.doesNotMatch(result.stdout, new RegExp(vault.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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
    path.join(rootDir, "config", "vault.local.json"),
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
    { vaultPath: outside, configPath: path.join(rootDir, "config", "vault.local.json") },
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
    { vaultPath: symlinkVault, configPath: path.join(rootDir, "config", "vault.local.json") },
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
      { vaultPath: unreadable, configPath: path.join(rootDir, "config", "vault.local.json") },
      { expectedVaultRoot: expectedRoot },
    );
    assert.equal(unreadableResult.ok, false);
    assert.equal(unreadableResult.error.code, "vault-unreadable");
  } finally {
    fs.chmodSync(unreadable, 0o700);
  }
  assert.deepEqual(listTree(unreadable), unreadableBefore);
});

test("foundation config loaders return consistent Result contracts for config failures", () => {
  const {
    loadConventionPolicy,
    loadRuntimeConfig,
    loadVaultConfig,
  } = loadPackage();
  const rootDir = tmpdir("dreamers-note-foundation-config");

  assert.equal(loadVaultConfig({ rootDir }).ok, false);
  assert.equal(loadVaultConfig({ rootDir }).error.code, "vault-config-missing");
  assert.equal(loadRuntimeConfig({ rootDir }).ok, false);
  assert.equal(loadRuntimeConfig({ rootDir }).error.code, "runtime-config-missing");
  assert.equal(loadConventionPolicy({ rootDir }).ok, false);
  assert.equal(loadConventionPolicy({ rootDir }).error.code, "convention-config-missing");

  writeText(path.join(rootDir, "config", "vault.local.json"), "{");
  writeText(path.join(rootDir, "config", "runtime.json"), "{");
  writeText(path.join(rootDir, "config", "conventions.json"), "{");
  assert.equal(loadVaultConfig({ rootDir }).error.code, "vault-config-invalid-json");
  assert.equal(loadRuntimeConfig({ rootDir }).error.code, "runtime-config-invalid-json");
  assert.equal(loadConventionPolicy({ rootDir }).error.code, "convention-config-invalid-json");

  writeText(path.join(rootDir, "config", "vault.local.json"), JSON.stringify({ vault_path: "" }));
  writeText(path.join(rootDir, "config", "runtime.json"), JSON.stringify({ data_dir: "", private_globs: [7] }));
  writeText(
    path.join(rootDir, "config", "conventions.json"),
    JSON.stringify({
      classified_note_roots: ["01-projects"],
      disallowed_roots: "02-areas",
      classified_note_pattern: "",
    }),
  );
  assert.equal(loadVaultConfig({ rootDir }).error.code, "vault-config-invalid");
  assert.equal(loadRuntimeConfig({ rootDir }).error.code, "runtime-config-invalid");
  assert.equal(loadConventionPolicy({ rootDir }).error.code, "convention-config-invalid");

  writeText(
    path.join(rootDir, "config", "runtime.json"),
    JSON.stringify({
      data_dir: ".dreamers-note-runtime",
      private_globs: ["07-system/secrets/**"],
      embeddings: 7,
    }),
  );
  assert.equal(loadRuntimeConfig({ rootDir }).error.code, "runtime-config-invalid");

  writeText(
    path.join(rootDir, "config", "conventions.json"),
    JSON.stringify({
      classified_note_roots: ["01-projects", "02-knowledge", "04-people"],
      disallowed_roots: ["02-areas", "03-knowledge"],
      classified_note_pattern: "<root>/<main>/<sub>/<note-name>.md",
      directory_index: {
        filename_pattern: "_<folder-name>.md",
        protected_section: "",
      },
    }),
  );
  assert.equal(loadConventionPolicy({ rootDir }).error.code, "convention-config-invalid");
});

test("vault config loads only ignored local configuration by default", () => {
  const { loadVaultConfig } = loadPackage();
  const rootDir = tmpdir("dreamers-note-local-vault-config");
  const vault = path.join(rootDir, "vault");
  mkdirp(vault);
  writeText(
    path.join(rootDir, "config", "vault.example.json"),
    JSON.stringify({ vault_path: "/replace/me" }),
  );

  const missing = loadVaultConfig({ rootDir });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "vault-config-missing");
  assert.equal(missing.error.path, path.join(rootDir, "config", "vault.local.json"));

  writeText(
    path.join(rootDir, "config", "vault.local.json"),
    JSON.stringify({ vault_path: vault }),
  );
  const loaded = loadVaultConfig({ rootDir });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.value.vaultPath, vault);
  assert.equal(loaded.value.configPath, path.join(rootDir, "config", "vault.local.json"));
});

test("CLI and MCP callers surface structured config errors without uncaught JSON exceptions", () => {
  const { callMcpTool } = loadPackage();
  const rootDir = tmpdir("dreamers-note-foundation-callers");
  const vault = path.join(rootDir, "vault");
  mkdirp(vault);
  writeText(path.join(rootDir, "config", "vault.local.json"), JSON.stringify({ vault_path: vault }));
  writeText(path.join(rootDir, "config", "runtime.json"), "{");
  writeText(
    path.join(rootDir, "config", "conventions.json"),
    JSON.stringify({
      classified_note_roots: ["01-projects", "02-knowledge", "04-people"],
      disallowed_roots: ["02-areas", "03-knowledge"],
      classified_note_pattern: "<root>/<main>/<sub>/<note-name>.md",
    }),
  );

  const cli = spawnSync("node", [path.join(dist, "cli.js"), "doctor", "--root", rootDir], {
    cwd: root,
    text: true,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(cli.status, 1);
  assert.equal(JSON.parse(cli.stdout).error.code, "runtime-config-invalid-json");
  assert.doesNotMatch(`${cli.stdout}\n${cli.stderr}`, /SyntaxError|Unexpected end of JSON input/);

  const status = callMcpTool(rootDir, "server_status", {});
  assert.equal(status.isError, true);
  assert.equal(status.structuredContent.error.code, "runtime-config-invalid-json");

  writeText(
    path.join(rootDir, "config", "runtime.json"),
    JSON.stringify({
      data_dir: ".dreamers-note-runtime",
      private_globs: ["07-system/secrets/**"],
    }),
  );
  writeText(path.join(rootDir, "config", "conventions.json"), "{");
  const conventionStatus = callMcpTool(rootDir, "server_status", {});
  assert.equal(conventionStatus.isError, true);
  assert.equal(conventionStatus.structuredContent.error.code, "convention-config-invalid-json");

  writeText(
    path.join(rootDir, "config", "conventions.json"),
    JSON.stringify({
      classified_note_roots: ["01-projects", "02-knowledge", "04-people"],
      disallowed_roots: ["02-areas", "03-knowledge"],
      classified_note_pattern: "<root>/<main>/<sub>/<note-name>.md",
    }),
  );
  const tagStatus = callMcpTool(rootDir, "workflow_policy", { workflow: "add" });
  assert.equal(tagStatus.isError, true);
  assert.equal(tagStatus.structuredContent.error.code, "approved-tags-missing");
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
  const { loadApprovedTagList, loadConventionPolicy } = loadPackage();
  const { validateConventionPath } = loadBuiltModule("conventions.js");
  const frameworkRoot = makeFrameworkRoot(tmpdir("dreamers-note-vault"), {
    approvedTags: ["ai", "local-first", "obsidian", "recipes"],
  });
  writeText(
    path.join(frameworkRoot, "taxonomy", "approved-tags.md"),
    "# approved tags\n\n- obsidian\n- ai\n- recipes\n- ai\n- local-first\n- **not-a-tag**\n",
  );
  const approvedList = unwrapResult(loadApprovedTagList(path.join(frameworkRoot, "taxonomy", "approved-tags.md")));
  const approved = new Set(approvedList);
  const policy = unwrapResult(loadConventionPolicy({ rootDir: frameworkRoot }));

  assert.deepEqual(approvedList, ["ai", "local-first", "obsidian", "recipes"]);
  assert.deepEqual(policy.directoryIndex, {
    filenamePattern: "_<folder-name>.md",
    protectedSection: "Notes",
  });
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
  for (const indexPath of [
    "02-knowledge/games/_games.md",
    "02-knowledge/games/project-zomboid/_project-zomboid.md",
    "02-knowledge/games/project-zomboid/extra/_extra.md",
  ]) {
    assert.equal(validateConventionPath(indexPath, [], approved, policy).ok, true, indexPath);
  }
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
  for (const invalidIndexPath of [
    "02-knowledge/games/_wrong.md",
    "02-knowledge/_knowledge.md",
    "02-knowledge/games/project-zomboid/extra/_wrong.md",
  ]) {
    assert.equal(validateConventionPath(invalidIndexPath, [], approved, policy).ok, false, invalidIndexPath);
  }
  assert.equal(
    validateConventionPath("02-knowledge/ai/obsidian/topic.md", ["unknown-tag"], approved, policy).error
      .code,
    "unapproved-tag",
  );
});

test("runtime initialization creates Git-ignored private state files", () => {
  const { initializeRuntimeState, loadRuntimeConfig } = loadPackage();
  const frameworkRoot = makeFrameworkRoot(tmpdir("dreamers-note-vault"));
  const runtimeConfig = unwrapResult(loadRuntimeConfig({ rootDir: frameworkRoot }));
  const runtime = initializeRuntimeState({ rootDir: frameworkRoot, config: runtimeConfig });

  assert.equal(path.basename(runtime.dataDir), ".dreamers-note-runtime");
  assert.match(fs.readFileSync(path.join(frameworkRoot, ".gitignore"), "utf8"), /\.dreamers-note-runtime\//);
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
    scanVaultEntries,
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

  const files = scanVaultEntries({
    vaultPath: vault,
    selectedPaths: ["."],
    privateGlobs: ["07-system/secrets/**"],
  }).files.map((file) => file.relativePath);
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
