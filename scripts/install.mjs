#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const registryPath = path.join(root, "dist", "mcp-tool-registry.js");
const registrySources = [
  "src/mcp-tool-registry.ts",
  "src/mcp-tool-arguments.ts",
  "src/mcp-tools-proposal.ts",
  "src/mcp-tools-retrieval.ts",
  "src/mcp-tools-review.ts",
  "src/mcp-tools-runtime.ts",
  "src/mcp-workflow-policy.ts",
].map((relativePath) => path.join(root, relativePath));

const managedSkillConfig = readJsonFile(path.join(root, "config", "managed-skills.json"));
const launcherConfig = readJsonFile(path.join(root, "config", "global-skill-launchers.json"));
const home = envPath("HOME");
const codeHome = envPath("CODEX_HOME") ?? path.join(requireHome("CODEX_HOME"), ".codex");
const skillsHome = envPath("SKILLS_HOME") ?? path.join(codeHome, "skills");
const copilotHome = envPath("COPILOT_HOME") ?? path.join(requireHome("COPILOT_HOME"), ".copilot");
const copilotSkillsHome = envPath("COPILOT_SKILLS_HOME") ?? path.join(copilotHome, "skills");
const copilotMcpConfig = envPath("COPILOT_MCP_CONFIG") ?? path.join(copilotHome, "mcp-config.json");
const copilotMcpToolsFile = envPath("COPILOT_MCP_TOOLS_FILE") ?? path.join(root, "config", "copilot-mcp-tools.json");
const vaultPath = envPath("VAULT_PATH") ?? readConfiguredVaultPath();

const projectSourceDir = path.join(root, ".codex", "skills");
const projectSkillsDir = path.join(vaultPath, ".codex", "skills");
const globalSourceDir = path.join(root, "global-skills");
const copilotSourceDir = path.join(root, ".github", "skills");
const projectManagedFile = path.join(projectSkillsDir, ".dreamers-note-managed-skills");
const globalManagedFile = path.join(skillsHome, ".dreamers-note-managed-skills");
const copilotManagedFile = path.join(copilotSkillsHome, ".dreamers-note-managed-skills");

const projectManagedSkills = validateSkillList("project", managedSkillConfig.projectSkills);
const legacyManagedSkills = [
  "dreamers-note-add",
  "dreamers-note-capture",
  "dreamers-note-triage",
  "dreamers-note-normalize",
  "dreamers-note-tags",
];
const copilotManagedSkills = validateSkillList("Copilot", managedSkillConfig.copilotSkills);

const args = parseArgs(process.argv.slice(2));

main();

function main() {
  assertDirectory(projectSourceDir, `missing project skill source directory: ${projectSourceDir}`);
  assertDirectory(globalSourceDir, "missing global-skills directory");
  assertDirectory(copilotSourceDir, `missing Copilot skill source directory: ${copilotSourceDir}`);
  assertFile(copilotMcpToolsFile, `missing Copilot MCP tools file: ${copilotMcpToolsFile}`);
  assertDirectory(vaultPath, `configured vault does not exist: ${vaultPath}`);

  const projectSkills = [...projectManagedSkills];
  const globalSkills = validateSkillList("global launcher", Object.keys(launcherConfig).sort());
  const copilotSkills = [...copilotManagedSkills];

  validateSkillSources("project", projectSourceDir, projectSkills);
  validateSkillSources("Copilot", copilotSourceDir, copilotSkills);
  validateLauncherConfig(globalSkills);
  validateCopilotToolsFile();

  const projectManagedCandidates = readManagedFile(projectManagedFile);
  const globalManagedCandidates = unique([...legacyManagedSkills, ...readManagedFile(globalManagedFile)]);
  const copilotManagedCandidates = readManagedFile(copilotManagedFile);

  const staleProjectSkills = computeStaleSkills(projectSkillsDir, projectSkills, projectManagedCandidates);
  const staleGlobalSkills = computeStaleSkills(skillsHome, globalSkills, globalManagedCandidates);
  const staleCopilotSkills = computeStaleSkills(copilotSkillsHome, copilotSkills, copilotManagedCandidates);
  ensureNoUnmanagedConflicts("Copilot", copilotSkillsHome, copilotSkills, copilotManagedCandidates);

  const copilotTools = args.writeCopilotMcp
    ? validateCopilotToolsAgainstRegistry(readCopilotTools(), { allowBuild: !args.dryRun })
    : null;

  if (args.writeCopilotMcp) {
    validateCopilotMcpConfig();
  }

  console.log(`project skills install to: ${projectSkillsDir}`);
  console.log(`global launchers install to: ${skillsHome}`);
  console.log(`Copilot skills install to: ${copilotSkillsHome}`);
  if (args.writeCopilotMcp) {
    console.log(`Copilot MCP config: ${copilotMcpConfig}`);
  }

  if (args.dryRun) {
    printSyncPlan("install project skill:", "remove stale managed project skill:", projectSkills, staleProjectSkills);
    printSyncPlan("install:", "remove stale managed skill:", globalSkills, staleGlobalSkills);
    printSyncPlan("install Copilot skill:", "remove stale managed Copilot skill:", copilotSkills, staleCopilotSkills);
    if (args.writeCopilotMcp) {
      console.log(`would update Copilot MCP config: ${copilotMcpConfig}`);
    }
    return;
  }

  syncManagedSkillSet(
    projectSourceDir,
    projectSkillsDir,
    projectManagedFile,
    projectSkills,
    staleProjectSkills,
    "installed project skill:",
    "removed stale managed project skill:",
  );
  syncRenderedSkillSet(
    skillsHome,
    globalManagedFile,
    globalSkills,
    staleGlobalSkills,
    (skillName) => renderGlobalLauncher(skillName, launcherConfig[skillName]),
    "installed:",
    "removed stale managed skill:",
  );
  syncManagedSkillSet(
    copilotSourceDir,
    copilotSkillsHome,
    copilotManagedFile,
    copilotSkills,
    staleCopilotSkills,
    "installed Copilot skill:",
    "removed stale managed Copilot skill:",
  );

  if (args.writeCopilotMcp) {
    writeCopilotMcpConfig(copilotTools);
    console.log(`updated Copilot MCP config: ${copilotMcpConfig}`);
  }

  console.log("done. restart codex, copilot, or open a new session for newly installed skills to appear in the skill list.");
}

function parseArgs(values) {
  const parsed = {
    dryRun: false,
    writeCopilotMcp: false,
  };
  for (const value of values) {
    if (value === "--dry-run") {
      parsed.dryRun = true;
    } else if (value === "--copilot-mcp") {
      parsed.writeCopilotMcp = true;
    } else if (value === "-h" || value === "--help") {
      usage();
      process.exit(0);
    } else {
      console.error(`unknown argument: ${value}`);
      usage();
      process.exit(2);
    }
  }
  return parsed;
}

function usage() {
  console.error(`usage: ./install.sh [--dry-run] [--copilot-mcp]

Installs dreamers-note project skills into the configured vault's
.codex/skills directory, global launcher skills into $CODEX_HOME/skills,
and Copilot project-skill wrappers into $COPILOT_HOME/skills.

Use --copilot-mcp to also create or update the dreamers-note entry in
$COPILOT_HOME/mcp-config.json with a safe non-apply tool allowlist from
config/copilot-mcp-tools.json.`);
}

function readConfiguredVaultPath() {
  const configPath = path.join(root, "config", "vault.local.json");
  try {
    const configuredVaultPath = JSON.parse(fs.readFileSync(configPath, "utf8")).vault_path;
    if (!path.isAbsolute(configuredVaultPath)) {
      fail(`configured vault path must be absolute: ${configuredVaultPath}`);
    }
    return configuredVaultPath;
  } catch (error) {
    fail(`could not read configured vault path from ${configPath}: ${error.message}`);
  }
}

function envText(name) {
  const value = env[name];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function envPath(name) {
  const value = envText(name);
  if (!value) {
    return undefined;
  }
  if (!path.isAbsolute(value)) {
    fail(`${name} must be an absolute path when set: ${value}`);
  }
  return path.resolve(value);
}

function requireHome(defaultFor) {
  if (!home) {
    fail(`${defaultFor} is unset and HOME is unavailable; set ${defaultFor} to an absolute path`);
  }
  return home;
}

function fail(message) {
  console.error(`install failed: ${message}`);
  process.exit(1);
}

function assertDirectory(target, message) {
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    fail(message);
  }
}

function assertFile(target, message) {
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    fail(message);
  }
}

function isSafeSkillName(value) {
  return Boolean(value) && /^[a-z0-9][a-z0-9-]*$/.test(value);
}

function unique(values) {
  return [...new Set(values)];
}

function readManagedFile(manifest) {
  if (!fs.existsSync(manifest)) {
    return [];
  }
  return unique(fs.readFileSync(manifest, "utf8").split(/\r?\n/).filter(Boolean).map((skillName) => {
    if (!isSafeSkillName(skillName)) {
      fail(`unsafe managed skill name: ${skillName}`);
    }
    return skillName;
  }));
}

function readJsonFile(target) {
  try {
    return JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (error) {
    fail(`invalid JSON in ${target}: ${error.message}`);
  }
}

function validateSkillList(label, value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label} skills must be a non-empty array`);
  }
  return unique(value.map((skillName) => {
    if (typeof skillName !== "string" || !isSafeSkillName(skillName)) {
      fail(`unsafe ${label} skill name: ${skillName}`);
    }
    return skillName;
  }));
}

function validateSkillSources(label, sourceDir, skills) {
  for (const skillName of skills) {
    if (!isSafeSkillName(skillName)) {
      fail(`unsafe ${label} skill name: ${skillName}`);
    }
    assertFile(path.join(sourceDir, skillName, "SKILL.md"), `missing ${label} skill: ${path.join(sourceDir, skillName, "SKILL.md")}`);
  }
}

function validateLauncherConfig(globalSkills) {
  for (const skillName of globalSkills) {
    const launcher = launcherConfig[skillName];
    if (!launcher || typeof launcher !== "object") {
      fail(`missing launcher config for ${skillName}`);
    }
    if (!isSafeSkillName(launcher.targetSkill)) {
      fail(`unsafe target skill for ${skillName}: ${launcher.targetSkill}`);
    }
    if (!projectManagedSkills.includes(launcher.targetSkill)) {
      fail(`unknown target skill for ${skillName}: ${launcher.targetSkill}`);
    }
    for (const field of ["description", "workflowId", "payloadMapping"]) {
      if (typeof launcher[field] !== "string" || !launcher[field].trim()) {
        fail(`launcher ${skillName} missing ${field}`);
      }
    }
    if (!Array.isArray(launcher.reportingFields) || launcher.reportingFields.length === 0 || launcher.reportingFields.some((field) => typeof field !== "string" || !field.trim())) {
      fail(`launcher ${skillName} reportingFields must be a non-empty string array`);
    }
  }
}

function computeStaleSkills(destDir, currentSkills, managedSkills) {
  return managedSkills.filter((skillName) => !currentSkills.includes(skillName) && fs.existsSync(path.join(destDir, skillName)));
}

function ensureNoUnmanagedConflicts(label, destDir, currentSkills, managedSkills) {
  for (const skillName of currentSkills) {
    if (fs.existsSync(path.join(destDir, skillName)) && !managedSkills.includes(skillName)) {
      fail(`${label} skill exists but is not managed by dreamers-note: ${path.join(destDir, skillName)}`);
    }
  }
}

function printSyncPlan(installPrefix, removePrefix, currentSkills, staleSkills) {
  for (const skillName of staleSkills) {
    console.log(`would ${removePrefix} ${skillName}`);
  }
  for (const skillName of currentSkills) {
    console.log(`would ${installPrefix} ${skillName}`);
  }
}

function syncManagedSkillSet(sourceDir, destDir, manifest, currentSkills, staleSkills, installPrefix, removePrefix) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const skillName of staleSkills) {
    const target = path.join(destDir, skillName);
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`${removePrefix} ${target}`);
  }
  for (const skillName of currentSkills) {
    const dest = path.join(destDir, skillName);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(path.join(sourceDir, skillName), dest, { recursive: true });
    console.log(`${installPrefix} ${dest}`);
  }
  fs.writeFileSync(manifest, `${currentSkills.join("\n")}\n`, "utf8");
}

function syncRenderedSkillSet(destDir, manifest, currentSkills, staleSkills, render, installPrefix, removePrefix) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const skillName of staleSkills) {
    const target = path.join(destDir, skillName);
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`${removePrefix} ${target}`);
  }
  for (const skillName of currentSkills) {
    const dest = path.join(destDir, skillName);
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "SKILL.md"), render(skillName), "utf8");
    console.log(`${installPrefix} ${dest}`);
  }
  fs.writeFileSync(manifest, `${currentSkills.join("\n")}\n`, "utf8");
}

function renderGlobalLauncher(name, launcher) {
  const reportingFields = launcher.reportingFields.map((field) => `- ${field}`).join("\n");
  return [
    "---",
    `name: "${name}"`,
    `description: "${launcher.description}"`,
    "---",
    "",
    `# ${name}`,
    "",
    `target_skill: ${launcher.targetSkill}`,
    `workflow_id: ${launcher.workflowId}`,
    "payload_mapping: >",
    `  ${launcher.payloadMapping}`,
    "reporting_fields:",
    reportingFields,
    "",
  ].join("\n");
}

function readCopilotTools() {
  let tools;
  try {
    tools = JSON.parse(fs.readFileSync(copilotMcpToolsFile, "utf8"));
  } catch (error) {
    fail(`invalid Copilot MCP tools JSON in ${copilotMcpToolsFile}: ${error.message}`);
  }
  if (!Array.isArray(tools) || tools.length === 0 || tools.some((tool) => typeof tool !== "string" || !tool)) {
    fail(`Copilot MCP tools file must be a non-empty JSON string array: ${copilotMcpToolsFile}`);
  }
  return tools;
}

function validateCopilotToolsFile() {
  readCopilotTools();
}

function validateCopilotToolsAgainstRegistry(tools, options = { allowBuild: true }) {
  ensureFreshRegistryBuild(options);
  const registry = require(registryPath);
  const allowed = new Set(registry.COPILOT_MCP_TOOL_NAMES ?? []);
  for (const forbidden of ["proposal_authorize", "proposal_apply"]) {
    if (tools.includes(forbidden)) {
      fail(`Copilot MCP tools file must not allow ${forbidden}: ${copilotMcpToolsFile}`);
    }
  }
  for (const tool of tools) {
    if (!allowed.has(tool)) {
      fail(`Copilot MCP tool is not registry allowlisted: ${tool}`);
    }
  }
  if (new Set(tools).size !== tools.length) {
    fail(`Copilot MCP tools file must not contain duplicate tool names: ${copilotMcpToolsFile}`);
  }
  return [...tools];
}

function ensureFreshRegistryBuild(options = { allowBuild: true }) {
  if (registryBuildIsFresh()) {
    return;
  }
  if (!options.allowBuild) {
    fail("dist/mcp-tool-registry.js is missing or stale; run npm run build before previewing --copilot-mcp");
  }
  const result = spawnSync("npm", ["run", "build", "--silent"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail(`could not build MCP tool registry before validating Copilot tools: ${result.stderr || result.stdout}`);
  }
  if (!registryBuildIsFresh()) {
    fail("dist/mcp-tool-registry.js is still missing or stale after npm run build");
  }
}

function registryBuildIsFresh() {
  if (!fs.existsSync(registryPath)) {
    return false;
  }
  const registryMtime = fs.statSync(registryPath).mtimeMs;
  const newestSource = Math.max(...registrySources.map((sourcePath) => fs.statSync(sourcePath).mtimeMs));
  return registryMtime >= newestSource;
}

function readCopilotMcpConfig() {
  if (!fs.existsSync(copilotMcpConfig)) {
    return {};
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(copilotMcpConfig, "utf8"));
  } catch (error) {
    fail(`invalid Copilot MCP JSON in ${copilotMcpConfig}: ${error.message}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    fail(`Copilot MCP config must be a JSON object: ${copilotMcpConfig}`);
  }
  if (data.mcpServers !== undefined && (!data.mcpServers || typeof data.mcpServers !== "object" || Array.isArray(data.mcpServers))) {
    fail(`Copilot MCP config mcpServers must be an object: ${copilotMcpConfig}`);
  }
  return data;
}

function validateCopilotMcpConfig() {
  readCopilotMcpConfig();
}

function writeCopilotMcpConfig(tools) {
  const data = readCopilotMcpConfig();
  const servers = data.mcpServers ?? {};
  servers["dreamers-note"] = {
    type: "stdio",
    command: "node",
    args: [path.join(root, "dist", "cli.js"), "mcp", "--root", root],
    tools: [...tools],
  };
  data.mcpServers = servers;
  fs.mkdirSync(path.dirname(copilotMcpConfig), { recursive: true });
  fs.writeFileSync(copilotMcpConfig, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
