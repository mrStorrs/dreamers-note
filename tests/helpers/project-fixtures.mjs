import assert from "node:assert/strict";
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

export function writeJson(target, value) {
  writeText(target, `${JSON.stringify(value, null, 2)}\n`);
}

export function readText(target) {
  return fs.readFileSync(target, "utf8");
}

export function makeFrameworkRoot(vaultPath, options = {}) {
  const frameworkRoot = tmpdir(options.tempPrefix ?? "dreamers-note-framework");
  const approvedTags = options.approvedTags ?? DEFAULT_APPROVED_TAGS;
  writeJson(path.join(frameworkRoot, "config", "vault.json"), { vault_path: vaultPath });
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

export function runtimeDatabasePath(frameworkRoot) {
  return path.join(frameworkRoot, ".dreamers-note-runtime", "notes.db");
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
  const runtimeConfig = loadRuntimeConfig({ rootDir: frameworkRoot });
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
