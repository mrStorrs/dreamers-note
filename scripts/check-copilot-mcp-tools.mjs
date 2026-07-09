import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
ensureFreshRegistryBuild();
const registry = require(registryPath);
const allowlistPath = path.join(root, "config", "copilot-mcp-tools.json");
const actual = JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
const expected = registry.COPILOT_MCP_TOOL_NAMES;

if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  console.error("config/copilot-mcp-tools.json is out of sync with MCP registry metadata.");
  console.error(`expected: ${JSON.stringify(expected)}`);
  console.error(`actual:   ${JSON.stringify(actual)}`);
  process.exit(1);
}


for (const forbidden of ["proposal_authorize", "proposal_apply"]) {
  if (actual.includes(forbidden)) {
    console.error(`config/copilot-mcp-tools.json must not allow ${forbidden}.`);
    process.exit(1);
  }
}

function ensureFreshRegistryBuild() {
  if (registryBuildIsFresh()) {
    return;
  }
  const result = spawnSync("npm", ["run", "build", "--silent"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error("could not build dist/mcp-tool-registry.js before checking the Copilot MCP allowlist.");
    console.error(result.stderr || result.stdout);
    process.exit(1);
  }
  if (!registryBuildIsFresh()) {
    console.error("dist/mcp-tool-registry.js is still missing or stale after npm run build.");
    process.exit(1);
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
