import fs from "fs";
import path from "path";
import { loadVaultConfig, validateVaultConfig } from "./config";
import { ConventionPolicy, loadApprovedTagList, loadConventionPolicy } from "./conventions";
import type { EmbeddingConfig } from "./embeddings";
import { loadRuntimeConfig, resolveRuntimeDataDir, RuntimeConfig } from "./runtime";
import type { Result } from "./types";

const MANAGED_RUNTIME_DIRECTORY = ".dreamers-note-runtime";

export interface VaultEnvironment {
  rootDir: string;
  vaultPath: string;
  runtimeDir: string;
  databasePath: string;
  runtimeLogPath: string;
  privateGlobs: string[];
  approvedTags: string[];
  runtimeConfig: RuntimeConfig;
  conventionPolicy: ConventionPolicy;
  embeddingConfig?: EmbeddingConfig;
}

export interface LoadVaultEnvironmentOptions {
  rootDir?: string;
}

export function loadVaultEnvironment(
  options: LoadVaultEnvironmentOptions = {},
): Result<VaultEnvironment> {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const vaultConfig = loadVaultConfig({ rootDir });
  if (!vaultConfig.ok) {
    return vaultConfig;
  }

  const validatedVault = validateVaultConfig(vaultConfig.value);
  if (!validatedVault.ok) {
    return validatedVault;
  }

  const runtimeConfig = loadRuntimeConfig({ rootDir });
  if (!runtimeConfig.ok) {
    return runtimeConfig;
  }

  const conventionPolicy = loadConventionPolicy({ rootDir });
  if (!conventionPolicy.ok) {
    return conventionPolicy;
  }

  const approvedTags = loadApprovedTagList(path.join(rootDir, "taxonomy", "approved-tags.md"));
  if (!approvedTags.ok) {
    return approvedTags;
  }

  const runtimeDir = validateManagedRuntimeDirectory(rootDir, validatedVault.value.vaultPath, runtimeConfig.value);
  if (!runtimeDir.ok) {
    return runtimeDir;
  }
  return {
    ok: true,
    value: {
      rootDir,
      vaultPath: validatedVault.value.vaultPath,
      runtimeDir: runtimeDir.value,
      databasePath: path.join(runtimeDir.value, "notes.db"),
      runtimeLogPath: path.join(runtimeDir.value, "dreamers-note.log"),
      privateGlobs: runtimeConfig.value.privateGlobs,
      approvedTags: approvedTags.value,
      runtimeConfig: runtimeConfig.value,
      conventionPolicy: conventionPolicy.value,
      embeddingConfig: runtimeConfig.value.embeddings,
    },
  };
}

function validateManagedRuntimeDirectory(
  rootDir: string,
  vaultPath: string,
  runtimeConfig: RuntimeConfig,
): Result<string> {
  if (path.isAbsolute(runtimeConfig.dataDir)) {
    return unsafeRuntimeDirectory(runtimeConfig);
  }
  const runtimeDir = resolveRuntimeDataDir({ rootDir, config: runtimeConfig });
  const relativePath = path.relative(rootDir, runtimeDir).split(path.sep).join("/");
  if (relativePath !== MANAGED_RUNTIME_DIRECTORY || pathsOverlap(runtimeDir, vaultPath)) {
    return unsafeRuntimeDirectory(runtimeConfig);
  }
  if (!hasManagedRuntimeIgnore(rootDir)) {
    return unsafeRuntimeDirectory(runtimeConfig);
  }
  try {
    const stat = fs.lstatSync(runtimeDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return unsafeRuntimeDirectory(runtimeConfig);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return unsafeRuntimeDirectory(runtimeConfig);
    }
  }
  return { ok: true, value: runtimeDir };
}

function hasManagedRuntimeIgnore(rootDir: string): boolean {
  try {
    return fs.readFileSync(path.join(rootDir, ".gitignore"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^\//, "").replace(/\/+$/, ""))
      .some((line) => line === MANAGED_RUNTIME_DIRECTORY);
  } catch {
    return false;
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

function isWithin(candidate: string, parent: string): boolean {
  const relativePath = path.relative(parent, candidate);
  return relativePath === ""
    || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath));
}

function unsafeRuntimeDirectory(runtimeConfig: RuntimeConfig): Result<string> {
  return {
    ok: false,
    error: {
      code: "runtime-config-unsafe-data-dir",
      message: "runtime config must use the managed ignored runtime directory",
      path: runtimeConfig.configPath,
    },
  };
}
