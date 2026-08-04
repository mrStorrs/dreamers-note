import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { buildFixtureIndex, makeFrameworkRoot, tmpdir, writeText } from "./helpers/project-fixtures.mjs";
import { distDir, projectRoot } from "./helpers/project-fixtures.mjs";

const require = createRequire(import.meta.url);

function loadBuiltModule(moduleName) {
  return require(path.join(distDir, moduleName));
}

test("Copilot CLI extension tools mirror the complete MCP tool surface", () => {
  const extension = loadBuiltModule("copilot-cli-extension.js");
  const registry = loadBuiltModule("mcp-tool-registry.js");
  const definitions = extension.listCopilotCliToolDefinitions();

  assert.deepEqual(
    definitions.map((definition) => definition.name),
    registry.MCP_TOOL_NAMES.map((name) => `dreamers_note_${name}`),
  );
  assert.equal(definitions.some((definition) => definition.name === "dreamers_note_proposal_authorize"), true);
  assert.equal(definitions.some((definition) => definition.name === "dreamers_note_proposal_apply"), true);
  assert.equal(
    definitions.find((definition) => definition.name === "dreamers_note_proposal_create_note").writePolicy,
    "write-enabled",
  );
});

test("Copilot CLI extension bridge dispatches MCP tools and rejects unavailable tools", () => {
  const extension = loadBuiltModule("copilot-cli-extension.js");
  const vault = tmpdir("dreamers-note-copilot-cli-vault");
  writeText(path.join(vault, "02-knowledge", "ai", "search", "local-tools.md"), "# Local Tools\n\nCopilot CLI uses local tools.\n");
  const frameworkRoot = makeFrameworkRoot(vault);
  buildFixtureIndex(frameworkRoot, vault);

  const search = extension.callCopilotCliTool(
    frameworkRoot,
    "dreamers_note_search_hybrid",
    { query: "local tools" },
  );
  assert.equal(search.isError, false);
  assert.match(extension.formatCopilotCliToolResult(search), /local-tools\.md/);

  const apply = extension.callCopilotCliTool(
    frameworkRoot,
    "dreamers_note_proposal_apply",
    { proposalId: "proposal", authorizationId: "authorization" },
  );
  assert.equal(apply.isError, true);
  assert.notEqual(apply.structuredContent.error.code, "unknown-tool");

  const unavailable = extension.callCopilotCliTool(
    frameworkRoot,
    "dreamers_note_not_a_real_tool",
    {},
  );
  assert.equal(unavailable.isError, true);
  assert.equal(unavailable.structuredContent.error.code, "unknown-tool");
});

test("project extension loads the compiled bridge and does not embed vault paths", () => {
  const extensionPath = path.join(projectRoot, ".github", "extensions", "dreamers-note", "extension.mjs");
  const source = require("node:fs").readFileSync(extensionPath, "utf8");
  assert.match(source, /@github\/copilot-sdk\/extension/);
  assert.match(source, /copilot-cli-extension\.js/);
  assert.doesNotMatch(source, /vault\.local\.json/);
  assert.match(source, /callCopilotCliTool/);
});
