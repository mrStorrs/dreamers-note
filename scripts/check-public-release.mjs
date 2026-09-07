#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const positionalArgs = args.filter((arg) => !arg.startsWith("--"));
const rootArg = positionalArgs[0];
if (positionalArgs.length > 1 || args.some((arg) => arg !== "--history" && arg.startsWith("--"))) {
  throw new Error("usage: node scripts/check-public-release.mjs [--history] [repository-root]");
}
const root = path.resolve(rootArg ?? process.cwd());
const checkHistory = args.includes("--history");
const prohibitedPaths = [
  /^config\/vault(?:\.local)?\.json$/,
  /^indexes\/.*\.(?:jsonl|sqlite|db)$/,
  /^\.dreamers-note-runtime\//,
];
const prohibitedContent = [
  /"(?:vault_path|data_dir)"\s*:\s*"(?:\/|[A-Za-z]:[\\/]|~[\\/])/,
  /\/(?:home|tmp|Users)\/[A-Za-z0-9_.-]+\//,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9_]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]+/,
];
const exampleVaultPath = "/absolute/path/to/your/vault";

const tracked = gitText(["ls-files", "-z"]).split("\0").filter(Boolean);
const failures = [];

for (const relativePath of tracked) {
  if (prohibitedPaths.some((pattern) => pattern.test(relativePath))) {
    failures.push(`prohibited tracked path: ${relativePath}`);
    continue;
  }
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    continue;
  }
  const stat = fs.lstatSync(absolutePath);
  if (stat.isSymbolicLink()) {
    failures.push(`tracked symlink: ${relativePath}`);
    continue;
  }
  if (!stat.isFile()) {
    continue;
  }
  const content = fs.readFileSync(absolutePath, "utf8");
  if (stat.size > 2_000_000 || !isPublicSafeFile(relativePath, content)) {
    failures.push(`prohibited content in: ${relativePath}`);
  }
}

checkArchive(gitText(["write-tree"]).trim());

if (checkHistory) {
  const emails = gitText(["log", "--all", "--format=%ae%n%ce"])
    .split(/\r?\n/)
    .filter(Boolean);
  if (emails.some((email) => !email.endsWith("@users.noreply.github.com"))) {
    failures.push("history contains a non-noreply author email");
  }
  const objects = gitText(["rev-list", "--objects", "--all"]).split(/\r?\n/).filter(Boolean);
  for (const entry of objects) {
    const separator = entry.indexOf(" ");
    if (separator === -1) continue;
    const objectId = entry.slice(0, separator);
    const relativePath = entry.slice(separator + 1);
    if (!relativePath) continue;
    if (prohibitedPaths.some((pattern) => pattern.test(relativePath))) {
      failures.push(`prohibited history path: ${relativePath}`);
      continue;
    }
    if (gitText(["cat-file", "-t", objectId]).trim() !== "blob") continue;
    const size = Number(gitText(["cat-file", "-s", objectId]));
    const content = size > 2_000_000 ? "" : gitText(["cat-file", "-p", objectId]);
    if (size > 2_000_000 || !isPublicSafeFile(relativePath, content)) {
      failures.push(`prohibited history content in: ${relativePath}`);
    }
  }
}

const uniqueFailures = [...new Set(failures)];
if (uniqueFailures.length > 0) {
  for (const failure of uniqueFailures) {
    process.stderr.write(`public-release check failed: ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(`public-release check passed (${tracked.length} tracked files)\n`);

function gitText(args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "buffer" }).toString("utf8");
}

function gitBuffer(args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
}

function checkArchive(treeId) {
  try {
    for (const entry of tarEntries(gitBuffer(["archive", "--format=tar", treeId]))) {
      if (entry.type === "5") continue;
      if (entry.type !== "0" && entry.type !== "\0") {
        failures.push(`non-regular archive entry: ${entry.path}`);
        continue;
      }
      if (prohibitedPaths.some((pattern) => pattern.test(entry.path))) {
        failures.push(`prohibited archive path: ${entry.path}`);
        continue;
      }
      const content = entry.content.toString("utf8");
      if (entry.content.length > 2_000_000 || !isPublicSafeFile(entry.path, content)) {
        failures.push(`prohibited archive content in: ${entry.path}`);
      }
    }
  } catch (error) {
    failures.push(`could not inspect candidate Git archive: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function* tarEntries(archive) {
  let offset = 0;
  for (; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return;
    const sizeText = readTarString(header.subarray(124, 136)).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid tar entry size");
    const name = readTarString(header.subarray(0, 100));
    const prefix = readTarString(header.subarray(345, 500));
    const pathInArchive = prefix ? `${prefix}/${name}` : name;
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (!pathInArchive || contentEnd > archive.length) throw new Error("invalid tar entry");
    yield { path: pathInArchive, type: String.fromCharCode(header[156]), content: archive.subarray(contentStart, contentEnd) };
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  if (offset !== archive.length && !archive.subarray(offset).every((byte) => byte === 0)) {
    throw new Error("truncated tar archive");
  }
}

function readTarString(buffer) {
  const terminator = buffer.indexOf(0);
  return buffer.subarray(0, terminator === -1 ? buffer.length : terminator).toString("utf8");
}

function hasProhibitedContent(content) {
  return prohibitedContent.some((pattern) => pattern.test(content));
}

function isPublicSafeFile(relativePath, content) {
  if (relativePath !== "config/vault.example.json") {
    return !hasProhibitedContent(content);
  }
  try {
    const parsed = JSON.parse(content);
    return Object.keys(parsed).length === 1
      && parsed.vault_path === exampleVaultPath
      && !prohibitedContent.slice(2).some((pattern) => pattern.test(content));
  } catch {
    return false;
  }
}
