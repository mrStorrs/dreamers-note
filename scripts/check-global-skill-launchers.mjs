#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "config", "global-skill-launchers.json");
const managedSkillsPath = path.join(root, "config", "managed-skills.json");
const write = process.argv.includes("--write");

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const managedSkills = JSON.parse(fs.readFileSync(managedSkillsPath, "utf8"));
let drift = false;
const projectSkills = validateSkillList("project", managedSkills.projectSkills);
const expectedLaunchers = Object.keys(manifest).sort();
const actualLaunchers = fs.readdirSync(path.join(root, "global-skills"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (JSON.stringify(actualLaunchers) !== JSON.stringify(expectedLaunchers)) {
  console.error("global-skills directory set is out of sync with config/global-skill-launchers.json.");
  console.error(`expected: ${JSON.stringify(expectedLaunchers)}`);
  console.error(`actual:   ${JSON.stringify(actualLaunchers)}`);
  drift = true;
}

for (const launcherName of expectedLaunchers) {
  if (!isSafeSkillName(launcherName)) {
    console.error(`unsafe launcher name in config/global-skill-launchers.json: ${launcherName}`);
    drift = true;
    continue;
  }
  const launcher = manifest[launcherName];
  if (!isSafeSkillName(launcher.targetSkill)) {
    console.error(`unsafe targetSkill for ${launcherName}: ${launcher.targetSkill}`);
    drift = true;
    continue;
  }
  if (!projectSkills.includes(launcher.targetSkill)) {
    console.error(`unknown targetSkill for ${launcherName}: ${launcher.targetSkill}`);
    drift = true;
    continue;
  }
  let valid = true;
  for (const field of ["description", "workflowId", "payloadMapping"]) {
    if (typeof launcher[field] !== "string" || !launcher[field].trim()) {
      console.error(`${launcherName} missing ${field}`);
      drift = true;
      valid = false;
    }
  }
  if (!Array.isArray(launcher.reportingFields) || launcher.reportingFields.length === 0 || launcher.reportingFields.some((field) => typeof field !== "string" || !field.trim())) {
    console.error(`${launcherName} reportingFields must be a non-empty string array`);
    drift = true;
    valid = false;
  }
  if (!valid) {
    continue;
  }
  const expected = renderLauncher(launcherName, launcher);
  const targetPath = path.join(root, "global-skills", launcherName, "SKILL.md");
  if (write) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, expected, "utf8");
    continue;
  }
  const actual = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "";
  if (actual !== expected) {
    console.error(`${path.relative(root, targetPath)} is out of sync with config/global-skill-launchers.json.`);
    drift = true;
  }
}

if (drift) {
  console.error("Run: node scripts/check-global-skill-launchers.mjs --write");
  process.exit(1);
}

function renderLauncher(name, launcher) {
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

function isSafeSkillName(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]*$/.test(value);
}

function validateSkillList(label, values) {
  if (!Array.isArray(values) || values.length === 0) {
    console.error(`${label} skills must be a non-empty array`);
    drift = true;
    return [];
  }
  return values.filter((value) => {
    if (!isSafeSkillName(value)) {
      console.error(`unsafe ${label} skill name: ${value}`);
      drift = true;
      return false;
    }
    return true;
  });
}
