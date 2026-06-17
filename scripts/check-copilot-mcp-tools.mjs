import fs from "node:fs";
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
if (!fs.existsSync(registryPath)) {
  console.error("dist/mcp-tool-registry.js is missing. Run npm run build before checking the Copilot MCP allowlist.");
  process.exit(1);
}
const registryMtime = fs.statSync(registryPath).mtimeMs;
const newestSource = Math.max(...registrySources.map((sourcePath) => fs.statSync(sourcePath).mtimeMs));
if (registryMtime < newestSource) {
  console.error("dist/mcp-tool-registry.js is older than the MCP registry source files. Run npm run build before checking the Copilot MCP allowlist.");
  process.exit(1);
}
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
