#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = envPath("FRAMEWORK_ROOT") ?? scriptRoot;
const manifestPath = path.join(root, "config", "framework-validation.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const managedSkills = JSON.parse(fs.readFileSync(path.join(root, "config", "managed-skills.json"), "utf8"));

for (const directory of manifest.directories) {
  requireDir(directory);
}
for (const file of manifest.files) {
  requireFile(file);
}
for (const item of manifest.requiredText) {
  requireText(item.path, item.text);
}

for (const skill of validateSkillList("project", managedSkills.projectSkills)) {
  const projectSkill = `.codex/skills/${skill}/SKILL.md`;
  requireSkillFrontmatter(projectSkill, skill);
  for (const heading of manifest.projectSkillHeadings) {
    requireText(projectSkill, heading);
  }
}

for (const skill of validateSkillList("Copilot", managedSkills.copilotSkills)) {
  const copilotSkill = `.github/skills/${skill}/SKILL.md`;
  requireSkillFrontmatter(copilotSkill, skill);
  requireText(copilotSkill, `.codex/skills/${skill}/SKILL.md`);
  requireText(copilotSkill, "source of truth");
  requireText(copilotSkill, "node dist/cli.js mcp");
  requireText(copilotSkill, "proposal-first");
  requireText(copilotSkill, "workflow_ready");
}

for (const agent of manifest.agents) {
  const agentFile = `agents/${agent}.md`;
  for (const heading of manifest.agentHeadings) {
    requireText(agentFile, heading);
  }
}

runCheck("scripts/check-global-skill-launchers.mjs");
runCheck("scripts/check-copilot-mcp-tools.mjs");
rejectText("src/index.ts", /listVaultFiles|isRuntimeGitIgnored|validateConventionPath|isInternalRelativePath|parseApprovedTags/, "src/index.ts exports unsupported foundation helpers");
rejectText(["src/proposal-queue.ts", "src/proposal-targets.ts", "src/proposal-path-actions.ts"], /editSpec|spliceEditSpec/, "proposal queue lifecycle modules must not store editSpec splice state");
rejectTreeText(["taxonomy", ".codex/skills", "agents"], /status\/|kind\//, "lifecycle tags found in framework taxonomy, skills, or agents");
rejectTreeText([".codex/skills"], /\/home\//, "hardcoded vault path found in project skills; use local configuration");
rejectTreeText([".github"], /\/home\/cjstorrs\/projects\/dreamers-note/, "hardcoded checkout path found in Copilot assets");

console.log("framework validation passed");

function requireFile(relativePath) {
  const target = path.join(root, relativePath);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    fail(`missing file ${relativePath}`);
  }
}

function requireDir(relativePath) {
  const target = path.join(root, relativePath);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    fail(`missing directory ${relativePath}`);
  }
}

function requireText(relativePath, text) {
  if (!readProjectFile(relativePath).includes(text)) {
    fail(`${relativePath} missing required text: ${text}`);
  }
}

function requireSkillFrontmatter(relativePath, name) {
  const body = readProjectFile(relativePath);
  const lines = body.split(/\r?\n/);
  if (lines[0] !== "---") {
    fail(`${relativePath} missing opening YAML frontmatter`);
  }
  requireText(relativePath, `name: "${name}"`);
  requireText(relativePath, "description: \"");
}

function runCheck(relativePath) {
  const result = spawnSync(process.execPath, [path.join(root, relativePath)], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail(`${relativePath} failed:\n${result.stderr || result.stdout}`);
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

function validateSkillList(label, value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label} skills must be a non-empty array`);
  }
  return value.map((skillName) => {
    if (typeof skillName !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(skillName)) {
      fail(`unsafe ${label} skill name: ${skillName}`);
    }
    return skillName;
  });
}

function rejectText(relativePaths, pattern, message) {
  for (const relativePath of Array.isArray(relativePaths) ? relativePaths : [relativePaths]) {
    if (pattern.test(readProjectFile(relativePath))) {
      fail(message);
    }
  }
}

function rejectTreeText(relativePaths, pattern, message) {
  for (const relativePath of relativePaths) {
    const absolute = path.join(root, relativePath);
    if (!fs.existsSync(absolute)) {
      continue;
    }
    for (const file of walkFiles(absolute)) {
      if (pattern.test(fs.readFileSync(file, "utf8"))) {
        fail(message);
      }
    }
  }
}

function* walkFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(target);
    } else if (entry.isFile()) {
      yield target;
    }
  }
}

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function fail(message) {
  console.error(`framework validation failed: ${message}`);
  process.exit(1);
}
