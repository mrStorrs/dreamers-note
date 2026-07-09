#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = envPath("FRAMEWORK_ROOT") ?? scriptRoot;
const vaultPath = envPath("VAULT_PATH") ?? readConfiguredVaultPath();
const manifest = JSON.parse(fs.readFileSync(path.join(root, "config", "vault-bootstrap-validation.json"), "utf8"));

requireDir(vaultPath, `vault path does not exist: ${vaultPath}`);
requireFile(path.join(root, "taxonomy", "approved-tags.md"), "missing framework approved tags");

for (const supportFile of manifest.supportFiles) {
  const vaultFile = path.join(vaultPath, supportFile.path);
  requireFile(vaultFile, `missing vault file: ${supportFile.path}`);
  if (supportFile.source) {
    const sourceFile = path.join(root, supportFile.source);
    if (fs.readFileSync(sourceFile, "utf8") !== fs.readFileSync(vaultFile, "utf8")) {
      fail("vault approved tags differ from framework taxonomy");
    }
  }
  for (const text of supportFile.requiredText ?? []) {
    if (!fs.readFileSync(vaultFile, "utf8").includes(text)) {
      fail(`${supportFile.path} does not contain: ${text}`);
    }
  }
}

if (isGitRepository(vaultPath)) {
  const staged = git(["diff", "--cached", "--name-status", "--"]);
  const expected = manifest.supportFiles
    .map((item) => `A\t${item.path}`)
    .sort()
    .join("\n");
  if (staged && staged.split(/\r?\n/).sort().join("\n") !== expected) {
    fail("staged vault changes must be exactly the bootstrap support files");
  }

  const unstagedTracked = git(["diff", "--name-status", "--"]);
  if (unstagedTracked) {
    fail("tracked vault files have unstaged changes");
  }
}

for (const legacyPath of manifest.legacyPaths) {
  if (!fs.existsSync(path.join(vaultPath, legacyPath))) {
    fail(`existing vault path missing after bootstrap: ${legacyPath}`);
  }
}

function isGitRepository(directory) {
  return spawnSync("git", ["-C", directory, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
  }).status === 0;
}

function git(args) {
  const result = spawnSync("git", ["-C", vaultPath, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function requireDir(target, message) {
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    fail(message);
  }
}

function requireFile(target, message) {
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    fail(message);
  }
}

function readConfiguredVaultPath() {
  const configPath = path.join(root, "config", "vault.json");
  try {
    const configuredVaultPath = JSON.parse(fs.readFileSync(configPath, "utf8")).vault_path;
    if (typeof configuredVaultPath !== "string" || !configuredVaultPath.trim()) {
      fail(`configured vault path must be a non-empty string in ${configPath}`);
    }
    if (!path.isAbsolute(configuredVaultPath)) {
      fail(`configured vault path must be absolute: ${configuredVaultPath}`);
    }
    return path.resolve(configuredVaultPath);
  } catch (error) {
    fail(`could not read configured vault path from ${configPath}: ${error.message}`);
  }
}

function envPath(name) {
  const value = process.env[name];
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  if (!path.isAbsolute(value)) {
    fail(`${name} must be an absolute path when set: ${value}`);
  }
  return path.resolve(value);
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}
