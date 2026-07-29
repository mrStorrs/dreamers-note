import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  git,
  readText,
  tmpdir,
  writeText,
} from "./helpers/project-fixtures.mjs";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(projectRoot, "dist");
const conventionPolicy = {
  classifiedNoteRoots: ["01-projects", "02-knowledge", "04-people"],
  disallowedRoots: ["02-areas", "03-knowledge"],
  classifiedNotePattern: "<root>/<main>/<sub>/<note-name>.md",
  directoryIndex: {
    filenamePattern: "_<folder-name>.md",
    protectedSection: "Notes",
  },
};

function loadDirectoryIndex() {
  return require(path.join(distDir, "directory-index.js"));
}

function environment(vaultPath, privateGlobs = ["07-system/secrets/**"]) {
  return {
    vaultPath,
    privateGlobs,
    conventionPolicy,
  };
}

function targetByPath(result, relativePath) {
  return result.value.targets.find((target) => target.path === relativePath);
}

test("canonical directory rendering preserves Notes, generated sections, exclusions, and migration parity", () => {
  const vault = tmpdir("dreamers-note-directory-index");
  const protectedContent = [
    "",
    "",
    "Keep this human-owned context byte-for-byte.",
    "",
    "Second paragraph stays intact.",
    "  ",
    "",
  ].join("\n");
  writeText(
    path.join(vault, "02-knowledge", "ai", "search", "alpha.md"),
    "# Alpha\n\nAlpha explains deterministic search ranking.\n",
  );
  writeText(
    path.join(vault, "02-knowledge", "ai", "search", "deep", "topic.md"),
    "# Deep Topic\n\nDeep topic detail.\n",
  );
  writeText(
    path.join(vault, "02-knowledge", "ai", "search", "private", "hidden.md"),
    "# Hidden\n\nCLASSIFIED-PRIVATE-CANARY\n",
  );
  writeText(
    path.join(vault, "02-knowledge", "ai", "search", "_search.md"),
    `Stale generated lead.\n\n## Notes${protectedContent}## Pages\n\n- stale\n`,
  );
  writeText(
    path.join(vault, "07-system", "secrets", "canary.md"),
    "DIRECTORY-INDEX-SECRET-CANARY",
  );

  const { planDirectoryIndexRepairs } = loadDirectoryIndex();
  const planned = planDirectoryIndexRepairs(
    environment(vault, [
      "07-system/secrets/**",
      "02-knowledge/ai/search/private/**",
    ]),
    {
    paths: ["02-knowledge/ai/search/_search.md"],
    },
  );
  assert.equal(planned.ok, true, JSON.stringify(planned.error));
  const target = targetByPath(planned, "02-knowledge/ai/search/_search.md");
  assert.ok(target);
  assert.equal(target.mode, "replace");
  assert.match(target.body, /^Keep this human-owned context byte-for-byte\./m);
  assert.equal(target.body.includes(`## Notes${protectedContent}`), true);
  assert.match(target.body, /\[\[02-knowledge\/ai\/search\/deep\/_deep\|Deep\]\]/);
  assert.match(target.body, /## Pages/);
  assert.match(target.body, /\[\[02-knowledge\/ai\/search\/alpha\|Alpha\]\] - Alpha explains deterministic search ranking\./);
  assert.doesNotMatch(target.body, /DIRECTORY-INDEX-SECRET-CANARY/);
  assert.doesNotMatch(target.body, /CLASSIFIED-PRIVATE-CANARY|\|Hidden\]\]/);
  assert.doesNotMatch(target.body, /\[\[02-knowledge\/ai\/search\/_search/);
  assert.equal((target.body.match(/## Notes/g) ?? []).length, 1);

  const parityVault = tmpdir("dreamers-note-directory-index-parity");
  writeText(
    path.join(parityVault, "02-knowledge", "ai", "search", "alpha.md"),
    "# Alpha\n\nAlpha explains deterministic search ranking.\n",
  );
  git(parityVault, ["init", "-q"]);
  git(parityVault, ["branch", "-M", "main"]);
  git(parityVault, ["add", "."]);
  git(parityVault, [
    "-c",
    "user.name=dreamers-test",
    "-c",
    "user.email=dreamers-test@example.invalid",
    "commit",
    "-qm",
    "baseline",
  ]);
  const parityPlan = planDirectoryIndexRepairs(environment(parityVault), {
    paths: ["02-knowledge/ai/search/_search.md"],
  });
  assert.equal(parityPlan.ok, true, JSON.stringify(parityPlan.error));
  const parityTarget = targetByPath(parityPlan, "02-knowledge/ai/search/_search.md");
  const migrated = spawnSync(
    process.execPath,
    ["dist/cli.js", "migrate-directory-indexes", "--vault", parityVault, "--write"],
    { cwd: projectRoot, encoding: "utf8" },
  );
  assert.equal(migrated.status, 0, `${migrated.stdout}\n${migrated.stderr}`);
  assert.equal(
    readText(path.join(parityVault, "02-knowledge", "ai", "search", "_search.md")),
    parityTarget.body,
  );
});

test("projected note changes derive homepages only when canonical output changes", () => {
  const vault = tmpdir("dreamers-note-directory-index-significance");
  const notePath = "02-knowledge/ai/search/alpha.md";
  const indexPath = "02-knowledge/ai/search/_search.md";
  const before = "# Alpha\n\nAlpha explains deterministic search ranking.\n\n## Detail\n\nVersion one.\n";
  writeText(path.join(vault, notePath), before);

  const { planDirectoryIndexChanges, planDirectoryIndexRepairs } = loadDirectoryIndex();
  const initial = planDirectoryIndexRepairs(environment(vault), { paths: [indexPath] });
  assert.equal(initial.ok, true, JSON.stringify(initial.error));
  writeText(path.join(vault, indexPath), targetByPath(initial, indexPath).body);

  const nonSignificant = planDirectoryIndexChanges(environment(vault), {
    targets: [{
      path: notePath,
      mode: "replace",
      body: before.replace("Version one.", "Version two."),
    }],
    pathActions: [],
  });
  assert.equal(nonSignificant.ok, true, JSON.stringify(nonSignificant.error));
  assert.equal(targetByPath(nonSignificant, indexPath), undefined);

  const significant = planDirectoryIndexChanges(environment(vault), {
    targets: [{
      path: notePath,
      mode: "replace",
      body: before.replace(
        "Alpha explains deterministic search ranking.",
        "Alpha now explains bounded hybrid retrieval.",
      ),
    }],
    pathActions: [],
  });
  assert.equal(significant.ok, true, JSON.stringify(significant.error));
  assert.match(targetByPath(significant, indexPath).body, /Alpha now explains bounded hybrid retrieval\./);

  const titleChange = planDirectoryIndexChanges(environment(vault), {
    targets: [{
      path: notePath,
      mode: "replace",
      body: before.replace("# Alpha", "# Alpha Renamed"),
    }],
    pathActions: [],
  });
  assert.equal(titleChange.ok, true, JSON.stringify(titleChange.error));
  assert.match(targetByPath(titleChange, indexPath).body, /\|Alpha Renamed\]\]/);
});

test("projected creates and moves compose old, new, and ancestor homepages deterministically", () => {
  const vault = tmpdir("dreamers-note-directory-index-overlay");
  writeText(
    path.join(vault, "02-knowledge", "ai", "search", "alpha.md"),
    "# Alpha\n\nAlpha explains search.\n",
  );
  writeText(
    path.join(vault, "02-knowledge", "ai", "pkm", "beta.md"),
    "# Beta\n\nBeta explains personal knowledge systems.\n",
  );

  const { planDirectoryIndexChanges } = loadDirectoryIndex();
  const planned = planDirectoryIndexChanges(environment(vault), {
    targets: [{
      path: "02-knowledge/ai/search/gamma.md",
      mode: "create",
      body: "# Gamma\n\nGamma explains local retrieval.\n",
    }],
    pathActions: [{
      type: "move",
      scope: "vault",
      path: "02-knowledge/ai/search/alpha.md",
      destinationPath: "02-knowledge/ai/pkm/alpha.md",
    }],
  });
  assert.equal(planned.ok, true, JSON.stringify(planned.error));
  assert.deepEqual(
    planned.value.targets.map((target) => target.path),
    [
      "02-knowledge/ai/pkm/_pkm.md",
      "02-knowledge/ai/search/_search.md",
    ],
  );
  assert.doesNotMatch(targetByPath(planned, "02-knowledge/ai/search/_search.md").body, /\|Alpha\]\]/);
  assert.match(targetByPath(planned, "02-knowledge/ai/search/_search.md").body, /\|Gamma\]\]/);
  assert.match(targetByPath(planned, "02-knowledge/ai/pkm/_pkm.md").body, /\|Alpha\]\]/);
});

test("drift inspection is read-only, bounded, and blocks ambiguous protected content", () => {
  const vault = tmpdir("dreamers-note-directory-index-drift");
  const notePath = "01-projects/ai/obsidian/project.md";
  const malformedPath = "01-projects/ai/obsidian/_obsidian.md";
  writeText(path.join(vault, notePath), "# Project\n\nProject context.\n");
  writeText(path.join(vault, malformedPath), "Generated text without a protected section.\n");
  const before = readText(path.join(vault, malformedPath));

  const { inspectDirectoryIndexDrift, planDirectoryIndexRepairs } = loadDirectoryIndex();
  const drift = inspectDirectoryIndexDrift(environment(vault));
  assert.equal(drift.ok, true, JSON.stringify(drift.error));
  const item = drift.value.items.find((candidate) => candidate.path === malformedPath);
  assert.equal(item.kind, "malformed");
  assert.equal(item.evidencePaths.includes(notePath), true);
  assert.equal(JSON.stringify(item).length < 2_000, true);
  assert.equal(readText(path.join(vault, malformedPath)), before);

  const repair = planDirectoryIndexRepairs(environment(vault), { paths: [malformedPath] });
  assert.equal(repair.ok, false);
  assert.equal(repair.error.code, "directory-index-protected-section-missing");
  assert.equal(readText(path.join(vault, malformedPath)), before);

  writeText(
    path.join(vault, malformedPath),
    "Lead.\n\n## Notes\n\nFirst.\n\n## Notes\n\nSecond.\n",
  );
  const ambiguous = planDirectoryIndexRepairs(environment(vault), { paths: [malformedPath] });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error.code, "directory-index-protected-section-ambiguous");
});
