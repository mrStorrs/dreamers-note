import fs from "fs";
import path from "path";
import { Result, StructuredError } from "./types";

export const EXCLUDED_PATH_PARTS = new Set([".git", ".obsidian", ".codex"]);

export interface PathClassificationOptions {
  vaultPath: string;
  input: string;
  privateGlobs?: string[];
}

export interface VaultPath {
  normalizedRelativePath: string;
  absolutePath: string;
}

export interface PathPolicyInspectionOptions {
  vaultPath: string;
  input: string;
  privateGlobs?: string[];
  allowExternal?: boolean;
}

export interface PathPolicyInspection {
  absolutePath: string;
  inVault: boolean;
  normalizedRelativePath?: string;
}

export function classifyVaultPath(options: PathClassificationOptions): Result<VaultPath> {
  const vaultPath = path.resolve(options.vaultPath);
  const input = options.input;
  const privateGlobs = options.privateGlobs ?? [];

  if (input.length === 0) {
    return reject("empty-path", "path cannot be empty");
  }

  if (/[\x00-\x1F\x7F]/.test(input)) {
    return reject("control-character", "path contains a control character", input);
  }

  if (/%2f|%5c|\\/i.test(input)) {
    return reject("encoded-separator", "path contains encoded or platform-ambiguous separators", input);
  }

  const rawParts = input.split("/").filter(Boolean);
  if (rawParts.includes("..")) {
    return reject("path-traversal", "path contains parent-directory traversal", input);
  }

  if (rawParts.some((part) => part !== part.trim())) {
    return reject("ambiguous-whitespace", "path segment has leading or trailing spaces", input);
  }

  const absolutePath = path.isAbsolute(input) ? path.resolve(input) : path.resolve(vaultPath, input);
  const relative = path.relative(vaultPath, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return reject("outside-vault", "path resolves outside the vault", input);
  }

  const relativeParts = relative.split(path.sep).filter(Boolean);
  if (relativeParts.some((part) => EXCLUDED_PATH_PARTS.has(part))) {
    return reject("excluded-root", "path points at excluded vault internals", toPosix(relative));
  }

  const normalizedParts = relativeParts.map((part) => part.normalize("NFC"));
  const normalizedRelativePath = normalizedParts.join("/");

  if (privateGlobs.some((glob) => privateGlobMatches(normalizedRelativePath, glob))) {
    return reject("private-path", "path matches a configured private glob", normalizedRelativePath);
  }

  const symlinkPath = findSymlinkPath(vaultPath, normalizedParts);
  if (symlinkPath) {
    return reject("symlink", "path includes a symlink", symlinkPath);
  }

  const collision = findNormalizationCollision(vaultPath, relativeParts, normalizedParts);
  if (collision) {
    return reject(collision.code, collision.message, collision.path);
  }

  return {
    ok: true,
    value: {
      normalizedRelativePath,
      absolutePath: path.join(vaultPath, ...normalizedParts),
    },
  };
}

export function inspectPathPolicy(options: PathPolicyInspectionOptions): Result<PathPolicyInspection> {
  const vaultPath = path.resolve(options.vaultPath);
  const input = options.input;
  const privateGlobs = options.privateGlobs ?? [];
  const classified = classifyVaultPath({ vaultPath, input, privateGlobs });
  if (classified.ok) {
    return {
      ok: true,
      value: {
        absolutePath: classified.value.absolutePath,
        inVault: true,
        normalizedRelativePath: classified.value.normalizedRelativePath,
      },
    };
  }

  if (!options.allowExternal || classified.error.code !== "outside-vault") {
    return {
      ok: false,
      error: classified.error,
    };
  }

  const absolutePath = path.resolve(input);
  const symlinkPath = findSymlinkInPath(absolutePath);
  if (symlinkPath) {
    return reject<PathPolicyInspection>("symlink", "path includes a symlink", symlinkPath);
  }
  if (containsExcludedPathPart(absolutePath)) {
    return reject<PathPolicyInspection>("excluded-root", "path points at excluded vault internals", absolutePath);
  }
  if (matchesPrivatePath(absolutePath, privateGlobs)) {
    return reject<PathPolicyInspection>("private-path", "path matches a configured private glob", absolutePath);
  }

  return {
    ok: true,
    value: {
      absolutePath,
      inVault: false,
    },
  };
}

function containsExcludedPathPart(targetPath: string): boolean {
  return targetPath
    .split(/[\\/]+/)
    .filter(Boolean)
    .some((part) => EXCLUDED_PATH_PARTS.has(part));
}

function matchesPrivatePath(targetPath: string, privateGlobs: string[]): boolean {
  const normalized = targetPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const parts = normalized.split("/").filter(Boolean);
  return privateGlobs.some((glob) => {
    if (privateGlobMatches(normalized, glob)) {
      return true;
    }
    for (let index = 0; index < parts.length; index += 1) {
      if (privateGlobMatches(parts.slice(index).join("/"), glob)) {
        return true;
      }
    }
    return false;
  });
}

function findSymlinkInPath(targetPath: string): string | undefined {
  const resolved = path.resolve(targetPath);
  const root = path.parse(resolved).root;
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = lstatIfPresent(current);
    if (!stat) {
      return undefined;
    }
    if (stat.isSymbolicLink()) {
      return current;
    }
  }
  return undefined;
}

export function privateGlobMatches(relativePath: string, glob: string): boolean {
  const normalizedGlob = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  const normalizedPath = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalizedGlob.endsWith("/**")) {
    const prefix = normalizedGlob.slice(0, -3);
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
  }
  return normalizedPath === normalizedGlob;
}

function reject<T = VaultPath>(code: string, message: string, rejectedPath?: string): Result<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      path: rejectedPath,
    },
  };
}

function findNormalizationCollision(
  vaultPath: string,
  relativeParts: string[],
  normalizedParts: string[],
): { code: string; message: string; path: string } | undefined {
  let currentDir = vaultPath;

  for (let index = 0; index < normalizedParts.length; index += 1) {
    if (!fs.existsSync(currentDir)) {
      return undefined;
    }
    const currentStat = fs.lstatSync(currentDir);
    if (currentStat.isSymbolicLink()) {
      return {
        code: "symlink",
        message: "path includes a symlink",
        path: currentDir,
      };
    }
    if (!currentStat.isDirectory()) {
      return undefined;
    }

    const rawPart = relativeParts[index];
    const normalizedPart = normalizedParts[index];
    const lowerNormalizedPart = normalizedPart.toLocaleLowerCase();
    const entries = fs.readdirSync(currentDir);
    const matchingEntry = entries.find((entry) => {
      if (entry === rawPart) {
        return false;
      }
      return entry.normalize("NFC").toLocaleLowerCase() === lowerNormalizedPart;
    });

    if (matchingEntry) {
      const matchingPath = path.join(currentDir, matchingEntry);
      if (matchingEntry.normalize("NFC") === normalizedPart) {
        return {
          code: "normalization-collision",
          message: "path collides after Unicode normalization",
          path: matchingPath,
        };
      }
      return {
        code: "case-collision",
        message: "path collides by case-insensitive comparison",
        path: matchingPath,
      };
    }

    currentDir = path.join(currentDir, normalizedPart);
  }

  return undefined;
}

function findSymlinkPath(vaultPath: string, normalizedParts: string[]): string | undefined {
  let current = vaultPath;
  for (const part of normalizedParts) {
    current = path.join(current, part);
    const stat = lstatIfPresent(current);
    if (!stat) {
      return undefined;
    }
    if (stat.isSymbolicLink()) {
      return current;
    }
  }
  return undefined;
}

function lstatIfPresent(targetPath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
