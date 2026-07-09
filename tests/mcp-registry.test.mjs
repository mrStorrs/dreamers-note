import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { distDir, projectRoot } from "./helpers/project-fixtures.mjs";

const require = createRequire(import.meta.url);

function loadBuiltModule(moduleName) {
  return require(path.join(distDir, moduleName));
}

test("MCP tool registry owns advertised metadata, argument parsers, and write policy", () => {
  const surface = loadBuiltModule("mcp-surface.js");
  const registry = loadBuiltModule("mcp-tool-registry.js");

  assert.deepEqual(surface.MCP_TOOLS, registry.listMcpToolDefinitions());
  assert.deepEqual(registry.MCP_TOOL_NAMES, surface.MCP_TOOLS.map((tool) => tool.name));

  const specs = registry.listMcpToolSpecs();
  assert.equal(specs.length, surface.MCP_TOOLS.length);
  for (const spec of specs) {
    assert.equal(typeof spec.name, "string");
    assert.equal(typeof spec.description, "string");
    assert.equal(typeof spec.inputSchema, "object");
    assert.equal(typeof spec.parseArguments, "function");
    assert.equal(["read-only", "write-enabled"].includes(spec.writePolicy), true);
  }

  const search = registry.getMcpToolSpec("search_hybrid");
  assert.equal(search.parseArguments({ query: "local notes", limit: 2 }).ok, true);
  assert.equal(search.parseArguments({ limit: 2 }).error.code, "invalid-arguments");
  assert.deepEqual(search.inputSchema.required, ["query"]);

  assert.equal(registry.getMcpToolSpec("proposal_list").writePolicy, "read-only");
  assert.equal(registry.getMcpToolSpec("proposal_read").writePolicy, "read-only");
  assert.equal(registry.getMcpToolSpec("proposal_create_note").writePolicy, "write-enabled");
  assert.equal(registry.getMcpToolSpec("proposal_create").writePolicy, "write-enabled");
  assert.equal(registry.getMcpToolSpec("proposal_reject").writePolicy, "write-enabled");
  assert.equal(registry.getMcpToolSpec("proposal_authorize").writePolicy, "write-enabled");
  assert.equal(registry.getMcpToolSpec("proposal_apply").writePolicy, "write-enabled");
});

test("MCP tool registry builds parsed dispatch entries and rejects missing handlers", () => {
  const registry = loadBuiltModule("mcp-tool-registry.js");

  assert.throws(
    () => registry.buildMcpToolRegistry({}),
    /missing MCP handler for server_status/,
  );

  const handlers = Object.fromEntries(registry.MCP_TOOL_NAMES.map((name) => [
    name,
    (_rootDir, args, options) => ({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { name, args, options },
      isError: false,
    }),
  ]));
  const entries = registry.buildMcpToolRegistry(handlers);
  const search = entries.get("search_hybrid");
  const parsed = search.parseArguments({ query: " local notes ", limit: 2 });

  assert.equal(parsed.ok, true);
  const result = search.handler("/tmp/dreamers-note", parsed.value, { writeEnabled: true });
  assert.deepEqual(result.structuredContent, {
    name: "search_hybrid",
    args: { query: "local notes", limit: 2 },
    options: { writeEnabled: true },
  });
});

test("MCP tool registry parsers preserve existing structured validation errors", () => {
  const registry = loadBuiltModule("mcp-tool-registry.js");
  const invalidCases = [
    ["search_hybrid", { query: "" }, "query must be a non-empty string"],
    ["read_note", {}, "read_note requires path or chunkId"],
    ["context_pack", { query: "notes", profile: "unknown" }, "profile must be one of"],
    ["graph_context_pack", {}, "graph_context_pack requires path or query"],
    [
      "diagnostic_feedback",
      {
        reportType: "health_report",
        itemKey: "item",
        evidenceHash: "hash",
        action: "ignore",
        reason: "not relevant",
      },
      "action must be dismiss, snooze, pin, or intentional",
    ],
    ["proposal_read", {}, "proposalId must be a non-empty string"],
  ];

  for (const [toolName, args, message] of invalidCases) {
    const result = registry.getMcpToolSpec(toolName).parseArguments(args);
    assert.equal(result.ok, false, toolName);
    assert.equal(result.error.code, "invalid-arguments", toolName);
    assert.match(result.error.message, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), toolName);
  }
});

test("proposal placement debt schema stays structured for MCP clients", () => {
  const registry = loadBuiltModule("mcp-tool-registry.js");
  const noteSchema = registry.getMcpToolSpec("proposal_create_note").inputSchema;
  const advancedSchema = registry.getMcpToolSpec("proposal_create").inputSchema;

  for (const schema of [noteSchema, advancedSchema]) {
    const placementDebt = schema.properties.placementDebt;
    assert.equal(placementDebt.additionalProperties, false);
    assert.deepEqual(placementDebt.required, ["originalText", "ambiguityReason", "candidateDestinations"]);
    assert.equal(placementDebt.properties.candidateDestinations.type, "array");
    assert.deepEqual(placementDebt.properties.candidateDestinations.items.required, ["path"]);
    assert.equal(placementDebt.properties.candidateDestinations.items.additionalProperties, false);
  }
});

test("MCP resource and prompt registries derive workflow policy surfaces from one workflow source", () => {
  const surface = loadBuiltModule("mcp-surface.js");
  const resources = loadBuiltModule("mcp-resource-registry.js");
  const prompts = loadBuiltModule("mcp-prompt-registry.js");
  const workflowPolicy = loadBuiltModule("mcp-workflow-policy.js");

  assert.deepEqual(surface.MCP_RESOURCES, resources.listMcpResourceDefinitions());
  assert.deepEqual(surface.MCP_PROMPTS, prompts.listMcpPromptDefinitions());
  assert.deepEqual(workflowPolicy.WORKFLOW_POLICY_IDS, ["shared", "add", "capture", "import", "triage"]);
  assert.deepEqual(
    resources.listMcpResourceDefinitions().filter((resource) => resource.uri.startsWith("dreamers-note://workflow-policy/")),
    workflowPolicy.listWorkflowPolicyResourceDefinitions(),
  );
  assert.deepEqual(prompts.listMcpPromptDefinitions(), workflowPolicy.listWorkflowPromptDefinitions());

  for (const workflow of workflowPolicy.WORKFLOW_POLICY_IDS) {
    const uri = `dreamers-note://workflow-policy/${workflow}`;
    const definition = resources.getMcpResourceDefinition(uri);
    assert.equal(definition.uri, uri);
    assert.equal(definition.mimeType, "application/json");

    if (workflow !== "shared") {
      const prompt = prompts.getMcpPromptDefinition(workflow);
      assert.equal(prompt.name, workflow);
      assert.match(workflowPolicy.promptText(workflow), new RegExp(uri.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  }

  assert.match(workflowPolicy.promptText("retrieval"), /context_pack/);
  assert.match(workflowPolicy.promptText("review"), /review_queue/);
});

test("Copilot MCP allowlist is checked against registry metadata and excludes apply authorization tools", () => {
  const registry = loadBuiltModule("mcp-tool-registry.js");
  const allowlistPath = path.join(projectRoot, "config", "copilot-mcp-tools.json");
  const allowlist = JSON.parse(fs.readFileSync(allowlistPath, "utf8"));

  assert.deepEqual(allowlist, registry.COPILOT_MCP_TOOL_NAMES);
  assert.equal(allowlist.includes("proposal_authorize"), false);
  assert.equal(allowlist.includes("proposal_apply"), false);
  for (const toolName of allowlist) {
    const spec = registry.getMcpToolSpec(toolName);
    assert.equal(spec.copilotAllowlisted, true, toolName);
  }

  const result = spawnSync("node", ["scripts/check-copilot-mcp-tools.mjs"], {
    cwd: projectRoot,
    encoding: "utf8",
    text: true,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
