#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  install(parseArgs(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`install failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function install({ dryRun }) {
  const skills = readSkillList();
  const sourceDir = path.join(root, ".codex", "skills");
  const cliPath = path.join(root, "dist", "cli.js");
  assertRegularFile(cliPath, "built CLI is missing; run npm run build first");
  validateSources(sourceDir, skills);

  const vaultPath = configuredVaultPath();
  assertDirectory(vaultPath, `configured vault does not exist: ${vaultPath}`);
  const codexHome = configuredHome("CODEX_HOME", ".codex");
  const copilotHome = configuredHome("COPILOT_HOME", ".copilot");
  const destinations = [
    destination("vault", path.join(vaultPath, ".codex", "skills"), sourceDir, skills, cliPath),
    destination("Codex", path.join(codexHome, "skills"), sourceDir, skills, cliPath),
    destination("Copilot", path.join(copilotHome, "skills"), sourceDir, skills, cliPath),
  ];
  const copilotConfig = inspectCopilotConfig(absoluteEnv("COPILOT_MCP_CONFIG") ?? path.join(copilotHome, "mcp-config.json"));

  for (const item of destinations) preflightDestination(item);
  const plan = buildPlan(destinations, copilotConfig);
  if (dryRun) {
    printPlan(plan);
    return;
  }
  stagePlan(plan);
  commitPlan(plan);
  process.stdout.write("installed canonical skills. Restart Codex or Copilot to discover the updated note-* skills.\n");
}

function parseArgs(values) {
  let dryRun = false;
  for (const value of values) {
    if (value === "--dry-run") {
      if (dryRun) throw new Error("--dry-run may be supplied only once");
      dryRun = true;
    } else if (value === "-h" || value === "--help") {
      process.stdout.write("usage: ./install.sh [--dry-run]\n");
      process.exit(0);
    } else if (value === "--copilot-mcp") {
      throw new Error("--copilot-mcp is not supported by the clean-break installer");
    } else {
      throw new Error(`unsupported argument: ${value}`);
    }
  }
  return { dryRun };
}

function readSkillList() {
  const configPath = path.join(root, "config", "managed-skills.json");
  const config = readJsonObject(configPath, "managed skill config");
  if (!Array.isArray(config.skills) || config.skills.length !== 5) throw new Error("managed skill config must contain exactly five skills");
  const skills = config.skills.map((value) => {
    if (typeof value !== "string" || !safeSkillName(value) || !value.startsWith("note-")) {
      throw new Error("managed skill config contains an invalid note-* name");
    }
    return value;
  });
  if (new Set(skills).size !== skills.length) throw new Error("managed skill config contains duplicate names");
  const expected = ["note-add", "note-import", "note-daily-triage", "note-review", "note-vault-refactor"];
  if (skills.join("\0") !== expected.join("\0")) throw new Error("managed skill config does not contain the canonical ordered skill set");
  return skills;
}

function destination(label, skillsDir, sourceDir, skills, cliPath) {
  return {
    label,
    skillsDir: path.resolve(skillsDir),
    sourceDir,
    skills,
    cliPath,
    manifest: path.join(skillsDir, ".dreamers-note-managed-skills"),
    locator: path.join(skillsDir, ".dreamers-note-install.json"),
    managed: [],
    stale: [],
  };
}

function configuredVaultPath() {
  const explicit = absoluteEnv("VAULT_PATH");
  if (explicit) return explicit;
  const configPath = path.join(root, "config", "vault.local.json");
  const config = readJsonObject(configPath, "local vault config");
  if (typeof config.vault_path !== "string" || !path.isAbsolute(config.vault_path)) throw new Error("local vault config must contain an absolute vault_path");
  return path.resolve(config.vault_path);
}

function configuredHome(name, fallbackDirectory) {
  const explicit = absoluteEnv(name);
  if (explicit) return explicit;
  const home = process.env.HOME;
  if (!home || !path.isAbsolute(home)) throw new Error(`${name} is unset and HOME is unavailable`);
  return path.join(home, fallbackDirectory);
}

function absoluteEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || !value.trim()) return undefined;
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path when set`);
  return path.resolve(value);
}

function validateSources(sourceDir, skills) {
  assertDirectory(sourceDir, `canonical skill source directory is missing: ${sourceDir}`);
  for (const skill of skills) {
    const skillDir = path.join(sourceDir, skill);
    assertDirectory(skillDir, `canonical skill is missing: ${skill}`);
    assertRegularFile(path.join(skillDir, "SKILL.md"), `canonical skill has no SKILL.md: ${skill}`);
    assertNoLinks(skillDir);
  }
  const sourceNames = fs.readdirSync(sourceDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  if (sourceNames.join("\0") !== [...skills].sort().join("\0")) throw new Error("canonical source contains a non-managed skill directory");
}

function preflightDestination(item) {
  if (pathExists(item.skillsDir)) assertDirectory(item.skillsDir, `${item.label} skills path is not a directory: ${item.skillsDir}`);
  item.managed = readManagedManifest(item.manifest);
  for (const skill of item.skills) {
    const target = path.join(item.skillsDir, skill);
    if (pathExists(target) && !item.managed.includes(skill)) {
      throw new Error(`${item.label} contains an unmanaged canonical skill collision: ${target}`);
    }
    if (pathExists(target)) assertManagedTarget(target, `${item.label} managed skill`);
  }
  item.stale = item.managed.filter((skill) => !item.skills.includes(skill) && pathExists(path.join(item.skillsDir, skill)));
  for (const skill of item.stale) assertManagedTarget(path.join(item.skillsDir, skill), `${item.label} stale managed skill`);
  for (const target of [item.manifest, item.locator]) {
    if (pathExists(target)) assertRegularFile(target, `${item.label} managed metadata is not a regular file: ${target}`);
  }
}

function inspectCopilotConfig(configPath) {
  if (!path.isAbsolute(configPath)) throw new Error("COPILOT_MCP_CONFIG must be an absolute path when set");
  if (!pathExists(configPath)) return { configPath, cleanup: false, text: undefined };
  assertRegularFile(configPath, `Copilot config is not a regular file: ${configPath}`);
  const config = readJsonObject(configPath, "Copilot config");
  if (config.mcpServers !== undefined && (!isObject(config.mcpServers))) {
    throw new Error("Copilot config mcpServers must be an object");
  }
  if (!isObject(config.mcpServers) || !Object.prototype.hasOwnProperty.call(config.mcpServers, "dreamers-note")) {
    return { configPath, cleanup: false, text: undefined };
  }
  const next = { ...config, mcpServers: { ...config.mcpServers } };
  delete next.mcpServers["dreamers-note"];
  return { configPath, cleanup: true, text: `${JSON.stringify(next, null, 2)}\n` };
}

function buildPlan(destinations, copilotConfig) {
  const operations = [];
  for (const item of destinations) {
    for (const skill of item.stale) {
      operations.push({ type: "remove", label: `remove stale managed ${item.label} skill`, target: path.join(item.skillsDir, skill) });
    }
    for (const skill of item.skills) {
      operations.push({ type: "copy", label: `copy canonical skill to ${item.label}`, source: path.join(item.sourceDir, skill), target: path.join(item.skillsDir, skill) });
    }
    operations.push({ type: "write", label: `write ${item.label} managed manifest`, target: item.manifest, text: `${item.skills.join("\n")}\n` });
    operations.push({ type: "write", label: `write ${item.label} framework locator`, target: item.locator, text: `${JSON.stringify({ framework_root: root, cli_path: item.cliPath }, null, 2)}\n` });
  }
  if (copilotConfig.cleanup) {
    operations.push({ type: "write", label: "remove stale Copilot configuration entry", target: copilotConfig.configPath, text: copilotConfig.text });
  }
  return { operations };
}

function printPlan(plan) {
  for (const operation of plan.operations) {
    const suffix = operation.type === "copy" ? `${operation.source} -> ${operation.target}` : operation.target;
    process.stdout.write(`would ${operation.label}: ${suffix}\n`);
  }
}

function stagePlan(plan) {
  try {
    for (const operation of plan.operations) {
      const parent = path.dirname(operation.target);
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      const stageRoot = fs.mkdtempSync(path.join(parent, ".dreamers-note-stage-"));
      operation.stageRoot = stageRoot;
      if (operation.type === "copy") {
        const staged = path.join(stageRoot, path.basename(operation.target));
        fs.cpSync(operation.source, staged, { recursive: true, dereference: false, errorOnExist: true });
        operation.staged = staged;
      } else if (operation.type === "write") {
        const staged = path.join(stageRoot, path.basename(operation.target));
        fs.writeFileSync(staged, operation.text, { encoding: "utf8", mode: 0o600 });
        operation.staged = staged;
      }
    }
  } catch (error) {
    for (const operation of plan.operations) if (operation.stageRoot && pathExists(operation.stageRoot)) removePath(operation.stageRoot);
    throw error;
  }
}

function commitPlan(plan) {
  const applied = [];
  let inProgress;
  try {
    for (const operation of plan.operations) {
      const hadTarget = pathExists(operation.target);
      const backup = hadTarget ? `${operation.target}.dreamers-note-backup-${process.pid}-${applied.length}` : undefined;
      inProgress = { operation, backup, created: Boolean(operation.staged) };
      if (hadTarget) fs.renameSync(operation.target, backup);
      if (operation.staged) fs.renameSync(operation.staged, operation.target);
      applied.push(inProgress);
      inProgress = undefined;
      process.stdout.write(`${operation.label}: ${operation.target}\n`);
    }
    for (const item of applied) if (item.backup) removePath(item.backup);
  } catch (error) {
    if (inProgress) {
      try {
        if (inProgress.created && pathExists(inProgress.operation.target)) removePath(inProgress.operation.target);
        if (inProgress.backup && pathExists(inProgress.backup)) fs.renameSync(inProgress.backup, inProgress.operation.target);
      } catch {
        // Preserve the original installation error; recovery details remain on disk for inspection.
      }
    }
    for (const item of [...applied].reverse()) {
      try {
        if (item.created && pathExists(item.operation.target)) removePath(item.operation.target);
        if (item.backup && pathExists(item.backup)) fs.renameSync(item.backup, item.operation.target);
      } catch {
        // Preserve the original installation error; recovery details remain on disk for inspection.
      }
    }
    throw error;
  } finally {
    for (const operation of plan.operations) if (operation.stageRoot && pathExists(operation.stageRoot)) removePath(operation.stageRoot);
  }
}

function readManagedManifest(manifest) {
  if (!pathExists(manifest)) return [];
  assertRegularFile(manifest, `managed manifest is not a regular file: ${manifest}`);
  const names = fs.readFileSync(manifest, "utf8").split(/\r?\n/).filter(Boolean);
  for (const name of names) if (!safeSkillName(name)) throw new Error(`managed manifest contains an unsafe skill name: ${name}`);
  return [...new Set(names)];
}

function assertDirectory(target, message) {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(message);
}

function assertRegularFile(target, message) {
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(message);
}

function assertManagedTarget(target, message) {
  const stat = fs.lstatSync(target);
  if ((!stat.isDirectory() && !stat.isFile()) || stat.isSymbolicLink()) throw new Error(`${message}: ${target}`);
}

function assertNoLinks(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`canonical skill source contains a symbolic link: ${target}`);
    if (entry.isDirectory()) assertNoLinks(target);
  }
}

function safeSkillName(value) {
  return /^[a-z0-9][a-z0-9-]*$/.test(value);
}

function readJsonObject(target, label) {
  let value;
  try { value = JSON.parse(fs.readFileSync(target, "utf8")); }
  catch { throw new Error(`${label} is not valid JSON: ${target}`); }
  if (!isObject(value)) throw new Error(`${label} must be a JSON object: ${target}`);
  return value;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function removePath(target) {
  const stat = fs.lstatSync(target);
  fs.rmSync(target, { recursive: stat.isDirectory(), force: true });
}

function pathExists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}
