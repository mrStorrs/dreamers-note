import crypto from "crypto";
import fs from "fs";
import path from "path";
import { classifyVaultPath } from "./path-safety";

const O_PATH_LINUX = 0x200000;

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
  directories: string[];
}

export function listVaultFiles(options: ListVaultFilesOptions): string[] {
  return scanVaultEntries(options).files.map((file) => file.absolutePath);
}

export function scanVaultEntries(options: ListVaultFilesOptions): VaultScanResult {
  const vaultPath = path.resolve(options.vaultPath);
  const selectedPaths = options.selectedPaths && options.selectedPaths.length > 0 ? options.selectedPaths : ["."];
  const files = new Map<string, VaultEntry>();
  const exclusions = new Map<string, VaultExclusion>();
  const directories = new Set<string>();

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
    collectVaultEntries(vaultPath, absolute, files, exclusions, directories, options.privateGlobs ?? []);
  }

  return {
    files: [...files.values()].sort((left, right) => compareVaultPaths(left.relativePath, right.relativePath)),
    exclusions: [...exclusions.values()].sort((left, right) => compareVaultPaths(left.relativePath, right.relativePath)),
    directories: [...directories].sort(compareVaultPaths),
  };
}

export function fileHash(filePath: string): string {
  const digest = crypto.createHash("sha256");
  digest.update(fs.readFileSync(filePath));
  return digest.digest("hex");
}

export function readVaultRegularFile(vaultPath: string, relativePath: string): Buffer | undefined {
  if (process.platform !== "linux" || !fs.existsSync("/proc/self/fd")) {
    throw new Error("secure vault reads require Linux descriptor-anchored filesystem support");
  }
  const parts = relativePath.split("/").filter(Boolean);
  const leaf = parts.pop();
  if (!leaf || parts.some((part) => part === "." || part === "..")) {
    throw new Error("unsafe vault path");
  }
  let parentFd = fs.openSync(vaultPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | requireNoFollow());
  try {
    for (const part of parts) {
      let nextFd: number;
      try {
        nextFd = fs.openSync(
          fdPath(parentFd, part),
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | requireNoFollow(),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
      fs.closeSync(parentFd);
      parentFd = nextFd;
    }
    let fileFd: number;
    try {
      fileFd = fs.openSync(fdPath(parentFd, leaf), O_PATH_LINUX | requireNoFollow());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    try {
      const stat = fs.fstatSync(fileFd);
      if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error("vault path is not a regular file");
      }
      const readFd = fs.openSync(fdSelfPath(fileFd), fs.constants.O_RDONLY);
      try {
        return fs.readFileSync(readFd);
      } finally {
        fs.closeSync(readFd);
      }
    } finally {
      fs.closeSync(fileFd);
    }
  } finally {
    fs.closeSync(parentFd);
  }
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
  directories: Set<string>,
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
          collectVaultEntries(vaultPath, path.join(absolute, entry.name), files, exclusions, directories, privateGlobs);
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
      let content: Buffer | undefined;
      try {
        content = readVaultRegularFile(vaultPath, classified.value.normalizedRelativePath);
      } catch {
        exclusions.set(relative, {
          relativePath: relative,
          reason: "unsafe-read",
        });
        return;
      }
      if (content === undefined) {
        return;
      }
      files.set(classified.value.normalizedRelativePath, {
        relativePath: classified.value.normalizedRelativePath,
        absolutePath: classified.value.absolutePath,
        kind: isAssetPath(classified.value.normalizedRelativePath) ? "asset" : "note",
        hash: hashBuffer(content),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
      return;
    }
  }

  if (!stat.isDirectory()) {
    return;
  }
  if (relative) {
    directories.add(relative);
  }

  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    collectVaultEntries(vaultPath, path.join(absolute, entry.name), files, exclusions, directories, privateGlobs);
  }
}

function canDescendExcludedPath(code: string): boolean {
  return code === "excluded-root" || code === "private-path";
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function requireNoFollow(): number {
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    throw new Error("secure vault reads require O_NOFOLLOW support");
  }
  return fs.constants.O_NOFOLLOW;
}

function fdPath(fd: number, child: string): string {
  return `/proc/self/fd/${fd}/${child}`;
}

function fdSelfPath(fd: number): string {
  return `/proc/self/fd/${fd}`;
}

function hashBuffer(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}
