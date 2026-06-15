import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createMcpClient } from "./helpers/mcp-client.mjs";
import {
  buildFixtureIndex,
  makeFrameworkRoot,
  mkdirp,
  readText,
  runtimeDatabasePath,
  tmpdir,
  writeText,
} from "./helpers/project-fixtures.mjs";

function makeTinyVault() {
  const vault = tmpdir("dreamers-note-helper-vault");
  writeText(
    path.join(vault, "01-projects", "ai", "obsidian", "retrieval-core.md"),
    "# Retrieval Core\n\nHelper fixtures should be indexed through the shared runtime setup.\n",
  );
  writeText(
    path.join(vault, "07-system", "secrets", "token.md"),
    "HELPER-SECRET-CANARY must stay excluded.\n",
  );
  return vault;
}

async function waitForOrphanedMessages(client) {
  const startedAt = Date.now();
  for (;;) {
    const messages = client.orphanedMessages();
    if (messages.length > 0) {
      return messages;
    }
    if (Date.now() - startedAt > 1_000) {
      throw new Error("timed out waiting for queued orphaned MCP message");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("shared project fixture helper writes loader-compatible runtime config", () => {
  const vault = makeTinyVault();
  const frameworkRoot = makeFrameworkRoot(vault, {
    approvedTags: ["ai", "obsidian", "search"],
    embeddings: {
      enabled: true,
      provider: "builtin",
      model: "dreamers-local-semantic",
      modelVersion: "test-version",
      dimensions: 48,
    },
  });

  const runtimeConfig = JSON.parse(readText(path.join(frameworkRoot, "config", "runtime.json")));
  assert.equal(runtimeConfig.data_dir, ".dreamers-note-runtime");
  assert.deepEqual(runtimeConfig.private_globs, ["07-system/secrets/**"]);
  assert.equal(runtimeConfig.embeddings.model_version, "test-version");
  assert.equal("modelVersion" in runtimeConfig.embeddings, false);
  assert.equal(fs.existsSync(runtimeDatabasePath(frameworkRoot)), false);

  const { runtime } = buildFixtureIndex(frameworkRoot, vault, {
    approvedTags: ["ai", "obsidian", "search"],
  });
  assert.equal(runtime.databasePath, runtimeDatabasePath(frameworkRoot));
  assert.equal(fs.existsSync(runtime.databasePath), true);
});

test("shared MCP client supports framed and line-delimited transports", async () => {
  const vault = makeTinyVault();
  const frameworkRoot = makeFrameworkRoot(vault);
  buildFixtureIndex(frameworkRoot, vault);

  for (const transport of ["framed", "line"]) {
    const client = createMcpClient(frameworkRoot, { transport });
    try {
      const initialize = await client.initialize();
      assert.equal(initialize.result.protocolVersion, "2025-11-25");
      const tools = await client.request("tools/list");
      assert.equal(tools.result.tools.some((tool) => tool.name === "workflow_ready"), true);
    } finally {
      await client.close();
    }
  }
});

test("shared MCP client exposes malformed-input recovery and notification hooks", async () => {
  const vault = makeTinyVault();
  const frameworkRoot = makeFrameworkRoot(vault);
  buildFixtureIndex(frameworkRoot, vault);
  const client = createMcpClient(frameworkRoot);

  try {
    client.sendRawBody("{\"jsonrpc\":");
    const queuedMessages = await waitForOrphanedMessages(client);
    assert.equal(queuedMessages.length, 1);
    assert.equal(queuedMessages[0].error.code, -32700);

    const parseError = await client.nextMessage();
    assert.equal(parseError.error.code, -32700);
    assert.equal(parseError.error.data.code, "malformed-json");
    assert.deepEqual(client.orphanedMessages(), []);

    const initialize = await client.initialize();
    assert.equal(initialize.result.protocolVersion, "2025-11-25");
    assert.deepEqual(client.orphanedMessages(), []);
  } finally {
    await client.close();
  }
});

test("shared helper modules expose a narrow test-only API", async () => {
  const mcpClient = await import("./helpers/mcp-client.mjs");
  const fixtures = await import("./helpers/project-fixtures.mjs");

  assert.deepEqual(Object.keys(mcpClient).sort(), ["createMcpClient"]);
  assert.deepEqual(
    Object.keys(fixtures).sort(),
    [
      "buildFixtureIndex",
      "distDir",
      "loadBuiltPackage",
      "makeFrameworkRoot",
      "mkdirp",
      "projectRoot",
      "readText",
      "runtimeDatabasePath",
      "tmpdir",
      "writeJson",
      "writeRuntimeConfig",
      "writeText",
    ],
  );

  const tempRoot = tmpdir("dreamers-note-helper-api");
  mkdirp(path.join(tempRoot, "nested"));
  writeText(path.join(tempRoot, "nested", "note.md"), "# helper\n");
  assert.match(readText(path.join(tempRoot, "nested", "note.md")), /helper/);
});
