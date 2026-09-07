import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createProjectFixture, loadBuiltPackage, projectRoot, readJsonEnvelope, runJsonCli } from "./helpers/project-fixtures.mjs";

test("package exports and doctor describe the skill-led cache/change foundation", () => {
  const api = loadBuiltPackage();
  for (const name of ["searchContext", "reviewContext", "createChange", "applyChange", "planDailyTriage", "planVaultNormalization"]) {
    assert.equal(typeof api[name], "function", name);
  }
  for (const name of ["callMcpTool", "startMcpServer", "recordHybridRetrievalFeedback"]) assert.equal(name in api, false);
  const fixture = createProjectFixture({ vaultFiles: { "00-inbox/seed.md": "seed\n" } });
  const result = runJsonCli(["doctor", "--root", fixture.frameworkRoot]);
  const doctor = readJsonEnvelope(result);
  assert.equal(result.status, 0);
  assert.equal(doctor.data.capabilities.jsonCli, true);
  assert.equal(doctor.data.capabilities.changeLifecycle, true);
  assert.equal(doctor.data.capabilities.legacyPendingChangesMigrated, false);
  assert.equal(fs.existsSync(path.join(projectRoot, "src", "mcp-server.ts")), false);
});
