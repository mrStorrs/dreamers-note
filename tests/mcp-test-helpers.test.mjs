import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createMcpClient } from "./helpers/mcp-client.mjs";
import {
  buildFixtureIndex,
  createProjectFixture,
  makeFrameworkRoot,
  mkdirp,
  projectRoot,
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

test("shared project fixture helper builds an indexed git-backed scenario", () => {
  const fixture = createProjectFixture({
    git: true,
    index: true,
    approvedTags: ["ai", "obsidian", "search"],
    vaultFiles: {
      "01-projects/ai/obsidian/shared-fixture.md":
        "# Shared Fixture\n\nIndexed fixture helpers should hide framework setup. #ai #obsidian\n",
      "07-system/secrets/token.md": "SECRET-CANARY must stay private.\n",
    },
  });

  assert.equal(fixture.packageApi.searchVaultIndex instanceof Function, true);
  assert.equal(fs.existsSync(path.join(fixture.vaultPath, ".git")), true);
  assert.equal(fs.existsSync(fixture.runtime.databasePath), true);
  assert.equal(fixture.runtime.databasePath, runtimeDatabasePath(fixture.frameworkRoot));
  assert.equal(fixture.readVaultText("01-projects/ai/obsidian/shared-fixture.md").includes("Indexed fixture"), true);
  const gitStatus = fixture.git(["status", "--short"]);
  assert.equal(gitStatus.status, 0, gitStatus.stderr);
  assert.equal(gitStatus.stdout.trim(), "");
});

test("shared project fixture helper supports empty git-backed scenarios", () => {
  const fixture = createProjectFixture({ git: true });

  assert.equal(fs.existsSync(path.join(fixture.vaultPath, ".git")), true);
  const gitStatus = fixture.git(["status", "--short"]);
  assert.equal(gitStatus.status, 0, gitStatus.stderr);
  assert.equal(gitStatus.stdout.trim(), "");
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

test("shared helper modules expose behavior-level fixture primitives", async () => {
  const mcpClient = await import("./helpers/mcp-client.mjs");
  const fixtures = await import("./helpers/project-fixtures.mjs");

  assert.equal(mcpClient.createMcpClient instanceof Function, true);
  assert.equal(fixtures.createProjectFixture instanceof Function, true);
  assert.equal(fixtures.makeFrameworkRoot instanceof Function, true);
  assert.equal(fixtures.buildFixtureIndex instanceof Function, true);

  const tempRoot = tmpdir("dreamers-note-helper-api");
  mkdirp(path.join(tempRoot, "nested"));
  writeText(path.join(tempRoot, "nested", "note.md"), "# helper\n");
  assert.match(readText(path.join(tempRoot, "nested", "note.md")), /helper/);
});

test("Node integration suites use shared fixture primitives instead of local clones", () => {
  const suites = [
    "tests/package-foundation.test.mjs",
    "tests/index-search-core.test.mjs",
    "tests/mcp-read-tools.test.mjs",
    "tests/proposal-queue-safety.test.mjs",
    "tests/retrieval-hardening.test.mjs",
    "tests/note-add-capture-integration.test.mjs",
    "tests/import-triage-integration.test.mjs",
    "tests/graph-health-review.test.mjs",
  ];
  const forbiddenLocalFactories = [
    "tmpdir",
    "mkdirp",
    "writeText",
    "readText",
    "git",
    "makeFrameworkRoot",
    "buildFixtureIndex",
  ];

  for (const suite of suites) {
    const source = readText(path.join(projectRoot, suite));
    assert.match(source, /from "\.\/helpers\/project-fixtures\.mjs"/, suite);
    for (const factory of forbiddenLocalFactories) {
      assert.doesNotMatch(source, new RegExp(`function\\s+${factory}\\s*\\(`), `${suite} defines ${factory}`);
    }
  }
});
