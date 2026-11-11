#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(root, ".codex", "skills");
const { skills } = JSON.parse(fs.readFileSync(path.join(root, "config", "managed-skills.json"), "utf8"));
assert.equal(skills.length, 5);
assert.equal(new Set(skills).size, 5);
assert.deepEqual(fs.readdirSync(skillsRoot).sort(), [...skills].sort());
for (const name of skills) {
  assert.match(name, /^note-[a-z-]+$/);
  const text = fs.readFileSync(path.join(skillsRoot, name, "SKILL.md"), "utf8");
  assert.ok(text.startsWith("---\nname: " + name + "\n"), "invalid skill frontmatter: " + name);
  assert.match(text, /\ndescription: .+\n/);
}
for (const file of ["docs/note-workflow-policy.md", "taxonomy/approved-tags.md", "scripts/build-note-index.mjs", "scripts/install.mjs"]) {
  assert.ok(fs.statSync(path.join(root, file)).isFile(), "missing skill resource: " + file);
}
for (const file of ["package.json", "package-lock.json", "tsconfig.json", "config/runtime.json", "src/cli.ts", "src/index-db.ts"]) {
  assert.ok(!fs.existsSync(path.join(root, file)), "retired application file: " + file);
}
console.log("framework validation passed");
