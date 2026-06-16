import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import test from "node:test";
import {
  loadBuiltPackage,
  makeFrameworkRoot,
  mkdirp,
  projectRoot,
  readText,
  runtimeDatabasePath,
  tmpdir,
  writeText,
} from "./helpers/project-fixtures.mjs";

const require = createRequire(import.meta.url);
const root = projectRoot;
const Database = require("better-sqlite3");

function loadPackage() {
  return loadBuiltPackage();
}

function unwrapResult(result) {
  assert.equal(result.ok, true, JSON.stringify(result.error ?? result));
  return result.value;
}

function listRegularFiles(base) {
  const results = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (entry.isFile()) {
        results.push(absolute);
      }
    }
  };
  visit(base);
  return results.sort();
}

function toRel(base, target) {
  return path.relative(base, target).split(path.sep).join("/");
}

function makeIndexFixture() {
  const vault = tmpdir("dreamers-note-index-vault");
  writeText(
    path.join(vault, "01-projects", "ai", "obsidian", "retrieval-core.md"),
    [
      "---",
      "tags: [ai, obsidian]",
      "---",
      "# Retrieval Core",
      "",
      "This note explains lexical retrieval and exact title matching.",
      "It links to [[Duplicate Topic|the shared topic]] and [[Broken Target#Missing Anchor]].",
      "It embeds ![[assets/diagram one.png]] and references [paper](03-assets/assets/paper.pdf).",
      "",
      "## Ranking",
      "Backlinks and tags should explain why matched.",
      "",
    ].join("\n"),
  );
  writeText(
    path.join(vault, "02-knowledge", "ai", "search", "duplicate-topic.md"),
    "# Duplicate Topic\n\nFirst duplicate has precise ranking language and #search.\n",
  );
  writeText(
    path.join(vault, "02-knowledge", "ai", "search", "duplicate topic.md"),
    "# Duplicate Topic\n\nSecond duplicate is intentionally ambiguous.\n",
  );
  writeText(
    path.join(vault, "02-knowledge", "unicode", "cafe", "Café Notes.md"),
    "# Cafe Unicode\n\nUnicode path content stays searchable.\n",
  );
  writeText(path.join(vault, "03-assets", "assets", "diagram one.png"), "fake image bytes\n");
  writeText(path.join(vault, "03-assets", "assets", "paper.pdf"), "fake pdf bytes\n");
  writeText(path.join(vault, "03-assets", "archive", "paper.pdf"), "duplicate filename bytes\n");
  writeText(path.join(vault, "02-knowledge", "empty", "notes", "empty.md"), "");
  writeText(
    path.join(vault, "02-knowledge", "ai", "search", "malformed.md"),
    "---\ntags: [ai\n---\n# Malformed Frontmatter\n\nBody text still matters for lexical search.\n",
  );
  writeText(path.join(vault, ".git", "config"), "git internals\n");
  writeText(path.join(vault, ".obsidian", "workspace.json"), "{}\n");
  writeText(path.join(vault, ".codex", "skills", "secret.md"), "codex internals\n");
  writeText(
    path.join(vault, "07-system", "secrets", "token.md"),
    "PLAN02-SECRET-CANARY should never be indexed or logged\n",
  );
  const outside = tmpdir("dreamers-note-index-outside");
  writeText(path.join(outside, "outside.md"), "outside\n");
  fs.symlinkSync(
    path.join(outside, "outside.md"),
    path.join(vault, "01-projects", "ai", "obsidian", "outside.md"),
  );
  return vault;
}

function allSqliteTextValues(databasePath) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const values = [];
    const tables = db
      .prepare("select name from sqlite_schema where type in ('table', 'view') and name not like 'sqlite_%'")
      .all()
      .map((row) => row.name);
    for (const table of tables) {
      const quoted = table.replace(/"/g, '""');
      const columns = db
        .prepare(`pragma table_info("${quoted}")`)
        .all()
        .filter((column) => String(column.type).toUpperCase().includes("TEXT"))
        .map((column) => column.name);
      if (columns.length === 0) {
        continue;
      }
      const selectList = columns.map((column) => `"${String(column).replace(/"/g, '""')}"`).join(", ");
      for (const row of db.prepare(`select ${selectList} from "${quoted}"`).all()) {
        for (const value of Object.values(row)) {
          if (typeof value === "string") {
            values.push(value);
          }
        }
      }
    }
    return values.join("\n");
  } finally {
    db.close();
  }
}

function readRows(databasePath, sql, ...params) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

function countRowsForPath(databasePath, table, relativePath, column = "relative_path") {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(`select count(*) as count from ${table} where ${column} = ?`)
      .get(relativePath);
    return row.count;
  } finally {
    db.close();
  }
}

function benchmarkIndexFixture({
  rebuildVaultIndex,
  refreshVaultIndex,
  searchVaultIndex,
  vaultPath,
  databasePath,
  benchmarkPath,
  privateGlobs,
  approvedTags,
  searchQuery,
  refreshPath,
  budgetsMs,
}) {
  const coldStart = performance.now();
  const rebuild = rebuildVaultIndex({ vaultPath, databasePath, privateGlobs, approvedTags });
  assert.equal(rebuild.ok, true);
  const coldRebuild = measurement(performance.now() - coldStart, budgetsMs.coldRebuild);

  const warmStart = performance.now();
  const search = searchVaultIndex({ databasePath, query: searchQuery, limit: 5 });
  assert.equal(search.ok, true);
  const warmSearch = measurement(performance.now() - warmStart, budgetsMs.warmSearch);

  const refreshAbsolutePath = path.join(vaultPath, refreshPath);
  const originalText = readText(refreshAbsolutePath);
  let oneNoteRefresh;
  try {
    writeText(refreshAbsolutePath, `${originalText}\nBenchmark refresh marker.\n`);
    const refreshStart = performance.now();
    const refresh = refreshVaultIndex({ vaultPath, databasePath, privateGlobs, approvedTags });
    assert.equal(refresh.ok, true);
    oneNoteRefresh = measurement(performance.now() - refreshStart, budgetsMs.oneNoteRefresh);
  } finally {
    writeText(refreshAbsolutePath, originalText);
  }

  const result = {
    totalMarkdownNotes: rebuild.value.indexedFiles.filter((file) => file.kind === "note").length,
    totalFiles: rebuild.value.indexedFiles.length,
    coldRebuild,
    warmSearch,
    oneNoteRefresh,
  };
  writeBenchmarkRows(benchmarkPath, result);
  return result;
}

function measurement(durationMs, budgetMs) {
  return {
    durationMs: Math.round(durationMs),
    budgetMs,
    passed: durationMs <= budgetMs,
  };
}

function writeBenchmarkRows(benchmarkPath, result) {
  const lines = [
    "# test-benchmarks",
    "",
    "| Command | Last run | Recommended timeout | Notes |",
    "|---|---:|---:|---|",
    benchmarkRow("package:index:rebuild", result.coldRebuild, "Cold rebuild without embeddings."),
    benchmarkRow("package:search:warm", result.warmSearch, "Warm lexical search against the local SQLite index."),
    benchmarkRow("package:index:refresh-one", result.oneNoteRefresh, "One-note refresh against an existing index."),
    "",
  ];
  writeText(benchmarkPath, lines.join("\n"));
}

function benchmarkRow(command, measurementValue, notes) {
  return `| \`${command}\` | ${measurementValue.durationMs}ms | 30s | ${measurementValue.passed ? "PASS" : "FAIL"}: ${notes} Budget ${measurementValue.budgetMs}ms. |`;
}

test("full rebuild indexes eligible vault files, records exclusions, and preserves fixture bytes", () => {
  const { rebuildVaultIndex, loadApprovedTagList } = loadPackage();
  const vault = makeIndexFixture();
  const frameworkRoot = makeFrameworkRoot(vault);
  const approvedTags = unwrapResult(loadApprovedTagList(path.join(frameworkRoot, "taxonomy", "approved-tags.md")));
  const trackedFiles = listRegularFiles(vault);
  const before = new Map(trackedFiles.map((file) => [toRel(vault, file), readText(file)]));

  const result = rebuildVaultIndex({
    vaultPath: vault,
    databasePath: runtimeDatabasePath(frameworkRoot),
    privateGlobs: ["07-system/secrets/**"],
    approvedTags,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.value.indexedFiles.map((file) => file.relativePath).sort(),
    [
      "01-projects/ai/obsidian/retrieval-core.md",
      "02-knowledge/ai/search/duplicate topic.md",
      "02-knowledge/ai/search/duplicate-topic.md",
      "02-knowledge/ai/search/malformed.md",
      "02-knowledge/empty/notes/empty.md",
      "02-knowledge/unicode/cafe/Café Notes.md",
      "03-assets/archive/paper.pdf",
      "03-assets/assets/diagram one.png",
      "03-assets/assets/paper.pdf",
    ],
  );

  const exclusions = new Map(result.value.excludedFiles.map((file) => [file.relativePath, file.reason]));
  assert.equal(exclusions.get(".git/config"), "excluded-root");
  assert.equal(exclusions.get(".obsidian/workspace.json"), "excluded-root");
  assert.equal(exclusions.get(".codex/skills/secret.md"), "excluded-root");
  assert.equal(exclusions.get("07-system/secrets/token.md"), "private-path");
  assert.equal(exclusions.get("01-projects/ai/obsidian/outside.md"), "symlink");

  for (const [relativePath, text] of before) {
    assert.equal(readText(path.join(vault, relativePath)), text, relativePath);
  }
});

test("refresh updates changed, deleted, renamed, and newly excluded records without a full rebuild", () => {
  const { rebuildVaultIndex, refreshVaultIndex, searchVaultIndex, loadApprovedTagList } = loadPackage();
  const vault = makeIndexFixture();
  const frameworkRoot = makeFrameworkRoot(vault);
  const approvedTags = unwrapResult(loadApprovedTagList(path.join(frameworkRoot, "taxonomy", "approved-tags.md")));
  const databasePath = runtimeDatabasePath(frameworkRoot);

  assert.equal(
    rebuildVaultIndex({ vaultPath: vault, databasePath, privateGlobs: ["07-system/secrets/**"], approvedTags }).ok,
    true,
  );

  writeText(
    path.join(vault, "01-projects", "ai", "obsidian", "retrieval-core.md"),
    "# Retrieval Core\n\nUpdated refresh phrase for one note refresh.\n",
  );
  fs.rmSync(path.join(vault, "02-knowledge", "empty", "notes", "empty.md"));
  const oldDuplicate = path.join(vault, "02-knowledge", "ai", "search", "duplicate-topic.md");
  const renamedDuplicate = path.join(vault, "02-knowledge", "ai", "search", "renamed-duplicate.md");
  fs.renameSync(oldDuplicate, renamedDuplicate);

  const result = refreshVaultIndex({
    vaultPath: vault,
    databasePath,
    privateGlobs: ["07-system/secrets/**", "02-knowledge/ai/search/malformed.md"],
    approvedTags,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value.updatedPaths.sort(), [
    "01-projects/ai/obsidian/retrieval-core.md",
    "02-knowledge/ai/search/renamed-duplicate.md",
  ]);
  assert.deepEqual(result.value.deletedPaths, ["02-knowledge/empty/notes/empty.md"]);
  assert.deepEqual(result.value.excludedPaths, ["02-knowledge/ai/search/malformed.md"]);
  assert.deepEqual(
    result.value.tombstones.map((tombstone) => [tombstone.relativePath, tombstone.reason, tombstone.newPath ?? ""]).sort(),
    [
      ["02-knowledge/ai/search/duplicate-topic.md", "renamed", "02-knowledge/ai/search/renamed-duplicate.md"],
      ["02-knowledge/ai/search/malformed.md", "excluded", ""],
      ["02-knowledge/empty/notes/empty.md", "deleted", ""],
    ],
  );

  for (const table of ["files", "chunks", "graph_edges", "asset_references", "parse_warnings"]) {
    assert.equal(countRowsForPath(databasePath, table, "02-knowledge/empty/notes/empty.md"), 0, table);
    assert.equal(countRowsForPath(databasePath, table, "02-knowledge/ai/search/malformed.md"), 0, table);
    assert.equal(countRowsForPath(databasePath, table, "02-knowledge/ai/search/duplicate-topic.md"), 0, table);
  }
  assert.equal(countRowsForPath(databasePath, "chunks_fts", "02-knowledge/empty/notes/empty.md"), 0);
  assert.equal(countRowsForPath(databasePath, "chunks_fts", "02-knowledge/ai/search/malformed.md"), 0);
  assert.equal(countRowsForPath(databasePath, "chunks_fts", "02-knowledge/ai/search/duplicate-topic.md"), 0);
  assert.equal(countRowsForPath(databasePath, "files", "02-knowledge/ai/search/renamed-duplicate.md"), 1);
  assert.equal(countRowsForPath(databasePath, "chunks", "02-knowledge/ai/search/renamed-duplicate.md") > 0, true);
  assert.equal(countRowsForPath(databasePath, "tombstones", "02-knowledge/empty/notes/empty.md"), 1);
  assert.equal(countRowsForPath(databasePath, "tombstones", "02-knowledge/ai/search/malformed.md"), 1);

  assert.equal(searchVaultIndex({ databasePath, query: "Body text still matters" }).value.results.length, 0);
  assert.equal(
    searchVaultIndex({ databasePath, query: "duplicate-topic.md", limit: 5 }).value.results.some(
      (result) => result.path === "02-knowledge/ai/search/duplicate-topic.md",
    ),
    false,
  );

  const refreshedResult = searchVaultIndex({ databasePath, query: "Updated refresh phrase", limit: 1 }).value.results[0];
  assert.equal(refreshedResult.path, "01-projects/ai/obsidian/retrieval-core.md");
  assert.equal(refreshedResult.freshness.state, "fresh");

  writeText(
    path.join(vault, "01-projects", "ai", "obsidian", "retrieval-core.md"),
    "# Retrieval Core\n\nChanged outside the refreshed index.\n",
  );
  const staleResult = searchVaultIndex({ databasePath, query: "Updated refresh phrase", limit: 1 }).value.results[0];
  assert.equal(staleResult.freshness.state, "stale");

  const scopedRefresh = refreshVaultIndex({
    vaultPath: vault,
    databasePath,
    privateGlobs: ["07-system/secrets/**"],
    approvedTags,
    selectedPaths: ["01-projects/ai/obsidian/retrieval-core.md"],
  });
  assert.equal(scopedRefresh.ok, false);
  assert.equal(scopedRefresh.error.code, "index-refresh-unsupported-scope");
});

test("Markdown parsing records Obsidian semantics, tags, assets, note embeds, and warnings", () => {
  const { parseMarkdownNote } = loadPackage();
  const text = [
    "---",
    "tags: [ai, unknown-tag]",
    "---",
    "# Root Heading",
    "Text with [[Known Note|alias]], [[Known Note#Deep Heading]], [[Missing Note]], and ![[Known Note#Embed Heading]].",
    "Markdown [asset](03-assets/assets/paper.pdf), [Known Markdown](../reference/known-note.md#Section Heading), and [web](https://example.com).",
    "![[assets/photo.png]]",
    "#recipes",
    "",
    "## Deep Heading",
    "Chunk text.",
    "",
  ].join("\n");

  const parsed = parseMarkdownNote({
    relativePath: "01-projects/ai/obsidian/source.md",
    text,
    approvedTags: new Set(["ai", "recipes"]),
    knownNotePaths: [
      "01-projects/ai/reference/known-note.md",
      "02-knowledge/ai/search/known-note.md",
    ],
    knownAssetPaths: [
      "03-assets/assets/paper.pdf",
      "03-assets/archive/paper.pdf",
      "03-assets/assets/photo.png",
    ],
  });

  assert.equal(parsed.title, "Root Heading");
  assert.deepEqual(parsed.headingPaths.map((heading) => heading.path), ["Root Heading", "Root Heading > Deep Heading"]);
  assert.deepEqual(parsed.approvedTags, ["ai", "recipes"]);
  assert.deepEqual(parsed.unapprovedTagCandidates, ["unknown-tag"]);
  assert.equal(
    parsed.links.some((link) => link.kind === "wikilink" && link.alias === "alias" && link.resolved === true),
    true,
  );
  assert.equal(
    parsed.links.some((link) => link.kind === "wikilink" && link.targetHeading === "Deep Heading" && link.resolved === true),
    true,
  );
  assert.equal(
    parsed.links.some((link) => link.kind === "wikilink" && link.isEmbed === true && link.targetHeading === "Embed Heading"),
    true,
  );
  assert.equal(
    parsed.links.some(
      (link) =>
        link.kind === "markdown" &&
        link.targetPath === "01-projects/ai/reference/known-note.md" &&
        link.targetHeading === "Section Heading" &&
        link.resolved === true,
    ),
    true,
  );
  assert.equal(parsed.links.some((link) => link.rawTarget === "Missing Note" && link.resolved === false), true);
  assert.deepEqual(parsed.assetReferences.map((asset) => asset.target).sort(), ["03-assets/assets/paper.pdf", "assets/photo.png"]);
  assert.equal(
    parsed.assetReferences.some(
      (asset) => asset.target === "03-assets/assets/paper.pdf" && asset.resolvedTargetPath === "03-assets/assets/paper.pdf",
    ),
    true,
  );
});

test("malformed frontmatter records a warning while preserving lexical body chunks", () => {
  const { parseMarkdownNote } = loadPackage();
  const parsed = parseMarkdownNote({
    relativePath: "02-knowledge/ai/search/malformed.md",
    text: "---\ntags: [ai\n---\n# Malformed Frontmatter\n\nRecoverable body phrase.\n",
    approvedTags: new Set(["ai"]),
    knownNotePaths: [],
  });

  assert.equal(parsed.warnings.some((warning) => warning.code === "malformed-frontmatter"), true);
  assert.equal(parsed.chunks.some((chunk) => chunk.text.includes("Recoverable body phrase")), true);
});

test("frontmatter parsing is newline agnostic for CRLF notes", () => {
  const { parseMarkdownNote } = loadPackage();
  const parsed = parseMarkdownNote({
    relativePath: "02-knowledge/ai/search/crlf.md",
    text: "---\r\ntags:\r\n  - ai\r\n---\r\n# CRLF Heading\r\n\r\nCRLF body phrase.\r\n",
    approvedTags: new Set(["ai"]),
    knownNotePaths: [],
  });

  assert.deepEqual(parsed.approvedTags, ["ai"]);
  assert.equal(parsed.title, "CRLF Heading");
  assert.equal(parsed.warnings.length, 0);
  assert.equal(parsed.chunks.some((chunk) => chunk.text.includes("CRLF body phrase")), true);
});

test("FTS search returns explainable, bounded, fresh results across exact, path, heading, tag, lexical, backlink, and asset signals", () => {
  const { rebuildVaultIndex, searchVaultIndex, loadApprovedTagList } = loadPackage();
  const vault = makeIndexFixture();
  const frameworkRoot = makeFrameworkRoot(vault);
  const databasePath = runtimeDatabasePath(frameworkRoot);
  const approvedTags = unwrapResult(loadApprovedTagList(path.join(frameworkRoot, "taxonomy", "approved-tags.md")));
  assert.equal(
    rebuildVaultIndex({ vaultPath: vault, databasePath, privateGlobs: ["07-system/secrets/**"], approvedTags }).ok,
    true,
  );

  const titleResult = searchVaultIndex({ databasePath, query: "Retrieval Core", limit: 5 }).value.results[0];
  assert.equal(titleResult.path, "01-projects/ai/obsidian/retrieval-core.md");
  assert.equal(titleResult.chunkId.length > 0, true);
  assert.equal(titleResult.headingPath.length > 0, true);
  assert.equal(titleResult.freshness.state, "fresh");
  assert.equal(titleResult.scoreComponents.title > 0, true);
  assert.equal(titleResult.why_matched.includes("title"), true);
  assert.equal(titleResult.snippet.length <= 240, true);

  const pathResult = searchVaultIndex({
    databasePath,
    query: "01-projects/ai/obsidian/retrieval-core.md",
    limit: 5,
  }).value.results[0];
  assert.equal(pathResult.path, "01-projects/ai/obsidian/retrieval-core.md");
  assert.equal(pathResult.scoreComponents.path > 0, true);
  assert.equal(pathResult.why_matched.includes("path"), true);

  const chunklessPathResult = searchVaultIndex({
    databasePath,
    query: "02-knowledge/empty/notes/empty.md",
    limit: 5,
  }).value.results[0];
  assert.equal(chunklessPathResult.path, "02-knowledge/empty/notes/empty.md");
  assert.equal(chunklessPathResult.scoreComponents.path > 0, true);

  const chunklessTitleResult = searchVaultIndex({ databasePath, query: "Empty", limit: 5 }).value.results[0];
  assert.equal(chunklessTitleResult.path, "02-knowledge/empty/notes/empty.md");
  assert.equal(chunklessTitleResult.scoreComponents.title > 0, true);

  const headingResult = searchVaultIndex({ databasePath, query: "Ranking", limit: 5 }).value.results[0];
  assert.equal(headingResult.headingPath, "Retrieval Core > Ranking");
  assert.equal(headingResult.scoreComponents.heading > 0, true);
  assert.equal(headingResult.why_matched.includes("heading"), true);

  const tagResult = searchVaultIndex({ databasePath, query: "search", limit: 5 }).value.results.find(
    (result) => result.path === "02-knowledge/ai/search/duplicate-topic.md",
  );
  assert.equal(Boolean(tagResult), true);
  assert.equal(tagResult.scoreComponents.tag > 0, true);
  assert.equal(tagResult.why_matched.includes("tag"), true);

  const lexicalResult = searchVaultIndex({ databasePath, query: "exact title matching", limit: 5 }).value.results[0];
  assert.equal(lexicalResult.path, "01-projects/ai/obsidian/retrieval-core.md");
  assert.equal(lexicalResult.scoreComponents.lexical > 0, true);
  assert.equal(lexicalResult.why_matched.includes("lexical"), true);

  const backlinkResult = searchVaultIndex({ databasePath, query: "Retrieval Core", limit: 5 }).value.results.find(
    (result) => result.path === "02-knowledge/ai/search/duplicate-topic.md",
  );
  assert.equal(Boolean(backlinkResult), true);
  assert.equal(backlinkResult.scoreComponents.backlink > 0, true);
  assert.equal(backlinkResult.why_matched.includes("backlink"), true);

  const assetResult = searchVaultIndex({ databasePath, query: "03-assets/assets/paper.pdf", limit: 5 }).value.results[0];
  assert.equal(assetResult.path, "03-assets/assets/paper.pdf");
  assert.equal(assetResult.scoreComponents.path > 0 || assetResult.scoreComponents.lexical > 0, true);
  assert.equal(assetResult.freshness.state, "fresh");
  const inboundAssetResult = searchVaultIndex({ databasePath, query: "Retrieval Core", limit: 10 }).value.results.find(
    (result) => result.path === "03-assets/assets/paper.pdf",
  );
  assert.equal(Boolean(inboundAssetResult), true);
  assert.equal(inboundAssetResult.scoreComponents.backlink > 0, true);
  assert.equal(
    searchVaultIndex({ databasePath, query: "Retrieval Core", limit: 10 }).value.results.some(
      (result) => result.path === "03-assets/archive/paper.pdf",
    ),
    false,
  );

  writeText(
    path.join(vault, "01-projects", "ai", "obsidian", "retrieval-core.md"),
    "# Retrieval Core\n\nChanged outside index.\n",
  );
  const staleResult = searchVaultIndex({ databasePath, query: "Retrieval Core", limit: 1 }).value.results[0];
  assert.equal(staleResult.freshness.state, "stale");
});

test("golden lexical retrieval is deterministic, cites no-source gaps, and keeps the winning signal explicit", () => {
  const { rebuildVaultIndex, evaluateLexicalRetrieval, searchVaultIndex, loadApprovedTagList } = loadPackage();
  const vault = makeIndexFixture();
  const frameworkRoot = makeFrameworkRoot(vault);
  const databasePath = runtimeDatabasePath(frameworkRoot);
  const approvedTags = unwrapResult(loadApprovedTagList(path.join(frameworkRoot, "taxonomy", "approved-tags.md")));
  assert.equal(
    rebuildVaultIndex({ vaultPath: vault, databasePath, privateGlobs: ["07-system/secrets/**"], approvedTags }).ok,
    true,
  );

  const cases = [
    { name: "no match", query: "term that has no source", expectNoSourceGap: true },
    { name: "duplicate title", query: "Duplicate Topic", expectedPaths: ["02-knowledge/ai/search/duplicate-topic.md"] },
    { name: "prompt injection text", query: "ignore previous instructions Retrieval Core", expectedPaths: ["01-projects/ai/obsidian/retrieval-core.md"] },
    { name: "excluded path canary", query: "PLAN02-SECRET-CANARY", expectNoSourceGap: true },
    { name: "exact beats lexical", query: "Duplicate Topic lexical retrieval", expectedPaths: ["02-knowledge/ai/search/duplicate-topic.md"] },
    { name: "lexical match", query: "precise ranking language", expectedPaths: ["02-knowledge/ai/search/duplicate-topic.md"] },
  ];

  const first = evaluateLexicalRetrieval({ databasePath, cases });
  const second = evaluateLexicalRetrieval({ databasePath, cases });

  assert.deepEqual(second, first);
  assert.equal(first.ok, true);
  assert.equal(first.value.results.every((result) => result.deterministic === true), true);
  assert.equal(first.value.results.every((result) => result.passed === true), true);
  assert.equal(first.value.results.find((result) => result.name === "no match").noSourceGap, true);
  assert.equal(first.value.results.find((result) => result.name === "excluded path canary").noSourceGap, true);
  assert.equal(first.value.results.find((result) => result.name === "duplicate title").topPath, "02-knowledge/ai/search/duplicate-topic.md");
  assert.equal(first.value.results.find((result) => result.name === "duplicate title").whyMatched.includes("title"), true);
  assert.equal(first.value.results.find((result) => result.name === "exact beats lexical").whyMatched.includes("title"), true);
  assert.equal(first.value.results.find((result) => result.name === "lexical match").whyMatched.includes("lexical"), true);
  assert.equal(searchVaultIndex({ databasePath, query: "PLAN02-SECRET-CANARY" }).value.results.length, 0);
});

test("secret canaries never appear in SQLite text tables, search responses, parser warnings, refresh paths, or logs", () => {
  const { rebuildVaultIndex, refreshVaultIndex, searchVaultIndex, loadApprovedTagList } = loadPackage();
  const vault = makeIndexFixture();
  const frameworkRoot = makeFrameworkRoot(vault);
  const databasePath = runtimeDatabasePath(frameworkRoot);
  const approvedTags = unwrapResult(loadApprovedTagList(path.join(frameworkRoot, "taxonomy", "approved-tags.md")));

  const rebuild = rebuildVaultIndex({
    vaultPath: vault,
    databasePath,
    privateGlobs: ["07-system/secrets/**"],
    approvedTags,
  });
  assert.equal(rebuild.ok, true);

  writeText(
    path.join(vault, "07-system", "secrets", "new-token.md"),
    "PLAN02-SECRET-CANARY refresh path should stay hidden\n",
  );
  const refresh = refreshVaultIndex({
    vaultPath: vault,
    databasePath,
    privateGlobs: ["07-system/secrets/**"],
    approvedTags,
  });

  assert.equal(refresh.ok, true);
  assert.equal(JSON.stringify(rebuild).includes("PLAN02-SECRET-CANARY"), false);
  assert.equal(JSON.stringify(refresh).includes("PLAN02-SECRET-CANARY"), false);
  assert.equal(allSqliteTextValues(databasePath).includes("PLAN02-SECRET-CANARY"), false);
  assert.equal(JSON.stringify(searchVaultIndex({ databasePath, query: "PLAN02-SECRET-CANARY" })).includes("PLAN02-SECRET-CANARY"), false);
  const logPath = path.join(frameworkRoot, ".dreamers-note-runtime", "dreamers-note.log");
  assert.equal(fs.existsSync(logPath) ? readText(logPath).includes("PLAN02-SECRET-CANARY") : false, false);
});

test("benchmarking records cold rebuild, warm search, and one-note refresh budgets for current scale fixtures", () => {
  const { rebuildVaultIndex, refreshVaultIndex, searchVaultIndex, loadApprovedTagList } = loadPackage();
  const vault = tmpdir("dreamers-note-scale-vault");
  for (let index = 0; index < 150; index += 1) {
    writeText(
      path.join(vault, "02-knowledge", "scale", "notes", `scale-note-${String(index).padStart(3, "0")}.md`),
      `# Scale Note ${index}\n\nLexical benchmark phrase ${index % 10} with #search.\n`,
    );
  }
  for (let index = 0; index < 250; index += 1) {
    writeText(path.join(vault, "03-assets", "scale", `asset-${String(index).padStart(3, "0")}.txt`), `asset ${index}\n`);
  }

  const frameworkRoot = makeFrameworkRoot(vault);
  const benchmarkPath = path.join(frameworkRoot, "test-benchmarks.md");
  const approvedTags = unwrapResult(loadApprovedTagList(path.join(frameworkRoot, "taxonomy", "approved-tags.md")));
  const result = benchmarkIndexFixture({
    rebuildVaultIndex,
    refreshVaultIndex,
    searchVaultIndex,
    vaultPath: vault,
    databasePath: runtimeDatabasePath(frameworkRoot),
    benchmarkPath,
    privateGlobs: ["07-system/secrets/**"],
    approvedTags,
    searchQuery: "Lexical benchmark phrase 7",
    refreshPath: "02-knowledge/scale/notes/scale-note-007.md",
    budgetsMs: {
      coldRebuild: 10_000,
      warmSearch: 1_000,
      oneNoteRefresh: 2_000,
    },
  });

  assert.equal(result.totalMarkdownNotes >= 150, true);
  assert.equal(result.totalFiles >= 400, true);
  assert.equal(result.coldRebuild.passed, true);
  assert.equal(result.warmSearch.passed, true);
  assert.equal(result.oneNoteRefresh.passed, true);
  assert.match(readText(benchmarkPath), /package:index:rebuild/);
  assert.match(readText(benchmarkPath), /package:search:warm/);
  assert.match(readText(benchmarkPath), /package:index:refresh-one/);
});
