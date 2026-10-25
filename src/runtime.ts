import fs from "fs";
import path from "path";
import { readJsonObjectConfig } from "./config";
import { openIndexDatabase } from "./index-db";
import { Result } from "./types";

export interface RuntimeConfig {
  dataDir: string;
  privateGlobs: string[];
  configPath: string;
}

export interface LoadRuntimeConfigOptions {
  rootDir?: string;
  configPath?: string;
}

export interface RuntimeState {
  dataDir: string;
  databasePath: string;
  walPath: string;
}

export function loadRuntimeConfig(options: LoadRuntimeConfigOptions = {}): Result<RuntimeConfig> {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const configPath = path.resolve(options.configPath ?? path.join(rootDir, "config", "runtime.json"));
  const config = readJsonObjectConfig({
    configPath,
    missingCode: "runtime-config-missing",
    invalidJsonCode: "runtime-config-invalid-json",
    invalidCode: "runtime-config-invalid",
    missingMessage: "runtime config could not be read",
    invalidJsonMessage: "runtime config is not valid JSON",
    invalidMessage: "runtime config must be a JSON object",
  });
  if (!config.ok) return config as Result<RuntimeConfig>;
  const parsed = config.value;
  if (typeof parsed.data_dir !== "string" || !parsed.data_dir.trim()) {
    return failRuntimeConfig("runtime-config-invalid", "runtime config must contain a non-empty data_dir string", configPath);
  }
  if (!Array.isArray(parsed.private_globs) || parsed.private_globs.some((item) => typeof item !== "string" || !item.trim())) {
    return failRuntimeConfig("runtime-config-invalid", "runtime config private_globs must be a string array", configPath);
  }
  return { ok: true, value: { dataDir: parsed.data_dir, privateGlobs: parsed.private_globs, configPath } };
}

export function initializeRuntimeState(options: { rootDir?: string; config: RuntimeConfig }): RuntimeState {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const dataDir = path.resolve(rootDir, options.config.dataDir);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);
  const runtime = {
    dataDir,
    databasePath: path.join(dataDir, "notes.db"),
    walPath: path.join(dataDir, "notes.db-wal"),
  };
  const db = openIndexDatabase(runtime.databasePath);
  db.close();
  for (const filePath of [runtime.databasePath, runtime.walPath]) {
    const handle = fs.openSync(filePath, "a", 0o600);
    fs.closeSync(handle);
    fs.chmodSync(filePath, 0o600);
  }
  return runtime;
}

export function resolveRuntimeDataDir(options: { rootDir?: string; config: RuntimeConfig }): string {
  return path.resolve(options.rootDir ?? process.cwd(), options.config.dataDir);
}

function failRuntimeConfig<T = RuntimeConfig>(code: string, message: string, configPath: string): Result<T> {
  return { ok: false, error: { code, message, path: configPath } };
}
