import crypto from "crypto";
import fs from "fs";
import path from "path";
import { classifyVaultPath } from "./path-safety";

export interface ListVaultFilesOptions {
  vaultPath: string;
  selectedPaths?: string[];
  privateGlobs?: string[];
}

export interface VaultEntry {
  relativePath: string;
  absolutePath: string;
  kind: "note" | "asset";
  hash: string;
  size: number;
  mtimeMs: number;
}

export interface VaultExclusion {
  relativePath: string;
  reason: string;
}

export interface VaultScanResult {
  files: VaultEntry[];
  exclusions: VaultExclusion[];
}

export function listVaultFiles(options: ListVaultFilesOptions): string[] {
  return scanVaultEntries(options).files.map((file) => file.absolutePath);
}

export function scanVaultEntries(options: ListVaultFilesOptions): VaultScanResult {
  const vaultPath = path.resolve(options.vaultPath);
  const selectedPaths = options.selectedPaths && options.selectedPaths.length > 0 ? options.selectedPaths : ["."];
  const files = new Map<string, VaultEntry>();
  const exclusions = new Map<string, VaultExclusion>();

  for (const selectedPath of selectedPaths) {
    const classified = classifyVaultPath({
      vaultPath,
      input: selectedPath,
      privateGlobs: options.privateGlobs,
    });
    if (!classified.ok && ["outside-vault", "path-traversal", "encoded-separator"].includes(classified.error.code)) {
      throw new Error(`selected path outside vault: ${selectedPath}`);
    }
    if (!classified.ok) {
      continue;
    }
    const absolute = classified.value.absolutePath;
    if (!fs.existsSync(absolute) || fs.lstatSync(absolute).isSymbolicLink()) {
      continue;
    }
    collectVaultEntries(vaultPath, absolute, files, exclusions, options.privateGlobs ?? []);
  }

  return {
    files: [...files.values()].sort((left, right) => compareVaultPaths(left.relativePath, right.relativePath)),
    exclusions: [...exclusions.values()].sort((left, right) => compareVaultPaths(left.relativePath, right.relativePath)),
  };
}

export function fileHash(filePath: string): string {
  const digest = crypto.createHash("sha256");
  digest.update(fs.readFileSync(filePath));
  return digest.digest("hex");
}

export function isAssetPath(relativePath: string): boolean {
  return path.posix.extname(relativePath).toLocaleLowerCase() !== ".md";
}

export function compareVaultPaths(left: string, right: string): number {
  return left.replace(/ /g, "~").localeCompare(right.replace(/ /g, "~"));
}

function collectVaultEntries(
  vaultPath: string,
  absolute: string,
  files: Map<string, VaultEntry>,
  exclusions: Map<string, VaultExclusion>,
  privateGlobs: string[],
): void {
  const relative = toPosix(path.relative(vaultPath, absolute));
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    if (relative) {
      exclusions.set(relative, { relativePath: relative, reason: "symlink" });
    }
    return;
  }

  if (relative) {
    const classified = classifyVaultPath({
      vaultPath,
      input: relative,
      privateGlobs,
    });
    if (!classified.ok) {
      if (stat.isDirectory() && canDescendExcludedPath(classified.error.code)) {
        for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
          collectVaultEntries(vaultPath, path.join(absolute, entry.name), files, exclusions, privateGlobs);
        }
        return;
      }
      exclusions.set(relative, {
        relativePath: relative,
        reason: classified.error.code,
      });
      return;
    }

    if (stat.isFile()) {
      files.set(classified.value.normalizedRelativePath, {
        relativePath: classified.value.normalizedRelativePath,
        absolutePath: classified.value.absolutePath,
        kind: isAssetPath(classified.value.normalizedRelativePath) ? "asset" : "note",
        hash: fileHash(classified.value.absolutePath),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
      return;
    }
  }

  if (!stat.isDirectory()) {
    return;
  }

  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    collectVaultEntries(vaultPath, path.join(absolute, entry.name), files, exclusions, privateGlobs);
  }
}

function canDescendExcludedPath(code: string): boolean {
  return code === "excluded-root" || code === "private-path";
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
