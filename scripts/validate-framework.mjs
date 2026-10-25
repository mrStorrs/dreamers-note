#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = configuredRoot();
const manifest = readJson(path.join(root, "config", "framework-validation.json"), "framework validation manifest");
const managed = readJson(path.join(root, "config", "managed-skills.json"), "managed skill config");

for (const directory of list(manifest.directories, "directories")) requireDirectory(directory);
for (const file of list(manifest.files, "files")) requireFile(file);
for (const absent of list(manifest.absentPaths, "absentPaths")) rejectPath(absent);

const expectedSkills = list(manifest.skills, "skills");
if (expectedSkills.join("\0") !== ["note-add", "note-import", "note-daily-triage", "note-review", "note-vault-refactor"].join("\0")) {
  fail("framework validation manifest must contain the canonical ordered skill set");
}
if (!sameList(managed.skills, expectedSkills)) fail("managed skill config does not match the canonical ordered skill set");

const skillRoot = path.join(root, ".codex", "skills");
const actualSkills = fs.readdirSync(skillRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
  .map((entry) => entry.name)
  .sort();
if (!sameList(actualSkills, [...expectedSkills].sort())) fail("canonical skill source contains missing or extra directories");

for (const skill of expectedSkills) validateSkill(skill);
validateTextContracts();
validateSourceCleanup();

process.stdout.write("framework validation passed\n");

function configuredRoot() {
  const value = process.env.FRAMEWORK_ROOT;
  if (!value?.trim()) return scriptRoot;
  if (!path.isAbsolute(value)) fail(`FRAMEWORK_ROOT must be an absolute path when set: ${value}`);
  return path.resolve(value);
}

function validateSkill(skill) {
  if (!/^note-[a-z0-9][a-z0-9-]*$/.test(skill)) fail(`unsafe canonical skill name: ${skill}`);
  const directory = path.join(".codex", "skills", skill);
  requireDirectory(directory);
  const skillFile = path.join(directory, "SKILL.md");
  requireFile(skillFile);
  const text = readProjectFile(skillFile);
  if (!text.startsWith("---\n")) fail(`${skillFile} is missing YAML frontmatter`);
  requireText(skillFile, `name: "${skill}"`);
  requireText(skillFile, "description: ");
  requireText(skillFile, "note-workflow-policy.md");
  requireText(skillFile, "change create");
  requireText(skillFile, "change show");
  rejectText(skillFile, /\bMCP\b|workflow_ready|proposal_authorize|proposal_apply/i, "legacy server workflow text");
  rejectTreeLinks(path.join(root, directory));
}

function validateTextContracts() {
  requireText("README.md", "canonical `note-*` skills");
  requireText("README.md", "change apply");
  requireText("AGENTS.md", "canonical `note-*` skill");
  requireText("docs/note-workflow-policy.md", "change create");
  requireText("docs/note-workflow-policy.md", "change apply");
  requireText("package.json", "Skill-led local vault CLI");
  requireText("config/runtime.json", ".dreamers-note-runtime");
  rejectText(".github/copilot-instructions.md", /node dist\/cli\.js mcp|workflow_ready|proposal_authorize|proposal_apply/i, "legacy Copilot workflow text");
  rejectText(".github/instructions/dreamers-note.instructions.md", /\bMCP\b|workflow_ready|proposal_authorize|proposal_apply/i, "legacy Copilot instruction text");
}

function validateSourceCleanup() {
  const sourceRoot = path.join(root, "src");
  for (const file of walkFiles(sourceRoot)) {
    const relative = path.relative(root, file);
    const text = fs.readFileSync(file, "utf8");
    if (/\b(?:startMcpServer|callMcpTool|recordHybridRetrievalFeedback)\b/.test(text)) {
      fail(`${relative} retains a deleted server or feedback API`);
    }
  }
  rejectText("src/index.ts", /mcp|embedding|proposal|retrieval.?feedback|diagnostic/i, "public package exports legacy APIs");
  rejectText("src/cli.ts", /migrate-directory-indexes|\bmcp\b/i, "CLI retains a deleted command");
}

function readJson(file, label) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isObject(value)) throw new Error("not an object");
    return value;
  } catch {
    fail(`${label} is not valid JSON: ${file}`);
  }
}

function list(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    fail(`${label} must be a list of non-empty strings`);
  }
  return value;
}

function sameList(value, expected) {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireDirectory(relative) {
  const target = path.join(root, relative);
  if (!fs.existsSync(target) || !fs.lstatSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink()) {
    fail(`missing directory ${relative}`);
  }
}

function requireFile(relative) {
  const target = path.join(root, relative);
  if (!fs.existsSync(target) || !fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink()) {
    fail(`missing regular file ${relative}`);
  }
}

function rejectPath(relative) {
  if (fs.existsSync(path.join(root, relative))) fail(`legacy path remains: ${relative}`);
}

function requireText(relative, text) {
  if (!readProjectFile(relative).includes(text)) fail(`${relative} is missing required text: ${text}`);
}

function rejectText(relative, pattern, message) {
  if (pattern.test(readProjectFile(relative))) fail(`${relative} contains ${message}`);
}

function rejectTreeLinks(directory) {
  for (const file of walkFiles(directory)) {
    if (fs.lstatSync(file).isSymbolicLink()) fail(`canonical skill source contains a symbolic link: ${path.relative(root, file)}`);
  }
}

function* walkFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      yield target;
    } else if (entry.isDirectory()) {
      yield* walkFiles(target);
    } else if (entry.isFile()) {
      yield target;
    }
  }
}

function readProjectFile(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function fail(message) {
  process.stderr.write(`framework validation failed: ${message}\n`);
  process.exit(1);
}
