import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const distDir = path.join(projectRoot, "dist");

const DEFAULT_PRIVATE_GLOBS = ["07-system/secrets/**"];
const DEFAULT_APPROVED_TAGS = ["ai", "obsidian", "local-first", "recipes", "search", "health"];

export function loadBuiltPackage() {
  return require(path.join(distDir, "index.js"));
}

export function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

export function mkdirp(target) {
  fs.mkdirSync(target, { recursive: true });
}

export function writeText(target, text) {
  mkdirp(path.dirname(target));
  fs.writeFileSync(target, text, "utf8");
}

export function writeBinary(target, content) {
  mkdirp(path.dirname(target));
  fs.writeFileSync(target, Array.isArray(content) ? Buffer.from(content) : content);
}

export function writeJson(target, value) {
  writeText(target, `${JSON.stringify(value, null, 2)}\n`);
}

export function readText(target) {
  return fs.readFileSync(target, "utf8");
}

export function makeFrameworkRoot(vaultPath, options = {}) {
  const frameworkRoot = tmpdir(options.tempPrefix ?? "dreamers-note-framework");
  const approvedTags = options.approvedTags ?? DEFAULT_APPROVED_TAGS;
  writeJson(path.join(frameworkRoot, "config", "vault.local.json"), { vault_path: vaultPath });
  writeRuntimeConfig(frameworkRoot, {
    data_dir: ".dreamers-note-runtime",
    private_globs: DEFAULT_PRIVATE_GLOBS,
    ...options.runtimeConfig,
    ...(Object.prototype.hasOwnProperty.call(options, "embeddings")
      ? { embeddings: serializeEmbeddingsConfig(options.embeddings) }
      : {}),
  });
  writeJson(path.join(frameworkRoot, "config", "conventions.json"), {
    classified_note_roots: ["01-projects", "02-knowledge", "04-people"],
    disallowed_roots: ["02-areas", "03-knowledge"],
    classified_note_pattern: "<root>/<main>/<sub>/<note-name>.md",
    ...(options.conventionsConfig ?? {}),
  });
  writeText(
    path.join(frameworkRoot, "taxonomy", "approved-tags.md"),
    `# approved tags\n\n${approvedTags.map((tag) => `- ${tag}`).join("\n")}\n`,
  );
  writeText(
    path.join(frameworkRoot, "docs", "conventions.md"),
    [
      "# conventions",
      "",
      "Project, knowledge, and people notes use exactly two classification directories below the root.",
      "Only approved topical tags may be applied.",
      "",
    ].join("\n"),
  );
  writeText(path.join(frameworkRoot, ".gitignore"), ".dreamers-note-runtime/\n");
  return frameworkRoot;
}

export function createProjectFixture(options = {}) {
  const vaultPath = options.vaultPath ?? tmpdir(options.vaultTempPrefix ?? "dreamers-note-vault");
  for (const [relativePath, content] of Object.entries(options.vaultFiles ?? {})) {
    const target = path.join(vaultPath, relativePath);
    if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
      writeBinary(target, content);
    } else {
      writeText(target, String(content));
    }
  }

  if (options.git === true) {
    initGitRepository(vaultPath, options.gitOptions);
  }

  const frameworkRoot = options.frameworkRoot ?? makeFrameworkRoot(vaultPath, options);
  const packageApi = loadBuiltPackage();
  const indexResult = options.index === true
    ? buildFixtureIndex(frameworkRoot, vaultPath, {
        approvedTags: options.approvedTags,
      })
    : {};

  return {
    vaultPath,
    frameworkRoot,
    packageApi,
    ...indexResult,
    git: (args, runOptions = {}) => runGit(vaultPath, args, runOptions),
    pathInVault: (relativePath) => path.join(vaultPath, relativePath),
    readVaultText: (relativePath) => readText(path.join(vaultPath, relativePath)),
    writeVaultText: (relativePath, text) => writeText(path.join(vaultPath, relativePath), text),
    writeVaultJson: (relativePath, value) => writeJson(path.join(vaultPath, relativePath), value),
  };
}

export function initGitRepository(cwd, options = {}) {
  runGit(cwd, ["init", "-q"], { check: true });
  if (options.branch) {
    runGit(cwd, ["checkout", "-qb", options.branch], { check: true });
  }
  runGit(cwd, ["add", "."], { check: true });
  const status = runGit(cwd, ["status", "--short"]);
  if (!status.stdout.trim()) {
    return;
  }
  runGit(
    cwd,
    [
      "-c",
      "user.name=dreamers-test",
      "-c",
      "user.email=dreamers-test@example.invalid",
      "commit",
      "-qm",
      options.message ?? "baseline",
    ],
    { check: true },
  );
}

export function runGit(cwd, args, options = {}) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  });
  if (options.check === true) {
    assert.equal(result.status, 0, result.stderr);
  }
  return result;
}

export function runtimeDatabasePath(frameworkRoot) {
  return path.join(frameworkRoot, ".dreamers-note-runtime", "notes.db");
}

export function runtimePaths(frameworkRoot) {
  const runtimeDir = path.join(frameworkRoot, ".dreamers-note-runtime");
  return {
    runtimeDir,
    databasePath: path.join(runtimeDir, "notes.db"),
    logPath: path.join(runtimeDir, "dreamers-note.log"),
    lockPath: path.join(runtimeDir, "proposal-apply.lock"),
  };
}

export function snapshotVaultTree(vaultPath) {
  const entries = [];
  collectSnapshotEntries(path.resolve(vaultPath), path.resolve(vaultPath), entries);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export function snapshotVaultContent(vaultPath) {
  return snapshotVaultTree(vaultPath).map(({ path: entryPath, type, hash }) => ({
    path: entryPath,
    type,
    hash,
  }));
}

export function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

export function writeRuntimeConfig(frameworkRoot, config) {
  writeJson(path.join(frameworkRoot, "config", "runtime.json"), config);
}

export function buildFixtureIndex(frameworkRoot, vaultPath, options = {}) {
  const {
    initializeRuntimeState,
    rebuildVaultIndex,
    loadRuntimeConfig,
  } = loadBuiltPackage();
  const runtimeConfigResult = loadRuntimeConfig({ rootDir: frameworkRoot });
  assert.equal(runtimeConfigResult.ok, true, JSON.stringify(runtimeConfigResult.error));
  const runtimeConfig = runtimeConfigResult.value;
  const runtime = initializeRuntimeState({ rootDir: frameworkRoot, config: runtimeConfig });
  const rebuild = rebuildVaultIndex({
    vaultPath,
    databasePath: runtime.databasePath,
    privateGlobs: runtimeConfig.privateGlobs,
    approvedTags: options.approvedTags ?? DEFAULT_APPROVED_TAGS,
    embeddingConfig: runtimeConfig.embeddings,
  });
  assert.equal(rebuild.ok, true, JSON.stringify(rebuild.error));
  return { runtime, runtimeConfig, rebuild };
}

function serializeEmbeddingsConfig(config) {
  if (!config) {
    return undefined;
  }
  if (config.enabled !== true) {
    return { enabled: false };
  }
  return {
    enabled: true,
    provider: config.provider,
    command: config.command,
    model: config.model,
    model_version: config.modelVersion ?? config.model_version,
    dimensions: config.dimensions,
  };
}

function collectSnapshotEntries(rootPath, currentPath, entries) {
  for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
    const absolutePath = path.join(currentPath, entry.name);
    const relativePath = path.relative(rootPath, absolutePath).split(path.sep).join("/");
    const stat = fs.lstatSync(absolutePath);
    if (stat.isDirectory()) {
      collectSnapshotEntries(rootPath, absolutePath, entries);
      continue;
    }
    entries.push({
      path: relativePath,
      type: stat.isSymbolicLink() ? "symlink" : "file",
      hash: stat.isSymbolicLink()
        ? fs.readlinkSync(absolutePath)
        : crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex"),
      mtimeMs: stat.mtimeMs,
    });
  }
}
