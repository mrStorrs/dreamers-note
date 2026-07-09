import fs from "fs";
import path from "path";
import { readJsonObjectConfig } from "./config";
import type { EmbeddingConfig } from "./embeddings";
import { openIndexDatabase } from "./index-db";
import { Result } from "./types";

export interface RuntimeConfig {
  dataDir: string;
  privateGlobs: string[];
  configPath: string;
  embeddings?: EmbeddingConfig;
}

export interface LoadRuntimeConfigOptions {
  rootDir?: string;
  configPath?: string;
}

export interface RuntimeState {
  dataDir: string;
  databasePath: string;
  walPath: string;
  logPath: string;
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
  if (!config.ok) {
    return config as Result<RuntimeConfig>;
  }
  const parsed = config.value;
  if (typeof parsed.data_dir !== "string" || parsed.data_dir.trim() === "") {
    return failRuntimeConfig("runtime-config-invalid", "runtime config must contain a non-empty data_dir string", configPath);
  }
  if (
    !Array.isArray(parsed.private_globs)
    || parsed.private_globs.some((value) => typeof value !== "string" || value.trim() === "")
  ) {
    return failRuntimeConfig("runtime-config-invalid", "runtime config private_globs must be a string array", configPath);
  }
  const embeddings = parseEmbeddingsConfig(parsed.embeddings, configPath);
  if (!embeddings.ok) {
    return {
      ok: false,
      error: embeddings.error,
    };
  }

  return {
    ok: true,
    value: {
      dataDir: parsed.data_dir,
      privateGlobs: parsed.private_globs,
      configPath,
      embeddings: embeddings.value,
    },
  };
}

export function initializeRuntimeState(options: {
  rootDir?: string;
  config: RuntimeConfig;
}): RuntimeState {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const config = options.config;
  const dataDir = path.resolve(rootDir, config.dataDir);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);

  const runtime = {
    dataDir,
    databasePath: path.join(dataDir, "notes.db"),
    walPath: path.join(dataDir, "notes.db-wal"),
    logPath: path.join(dataDir, "dreamers-note.log"),
  };

  const db = openIndexDatabase(runtime.databasePath);
  db.close();

  for (const filePath of [runtime.databasePath, runtime.walPath, runtime.logPath]) {
    const handle = fs.openSync(filePath, "a", 0o600);
    fs.closeSync(handle);
    fs.chmodSync(filePath, 0o600);
  }

  return runtime;
}

export function resolveRuntimeDataDir(options: { rootDir?: string; config: RuntimeConfig }): string {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const config = options.config;
  return path.resolve(rootDir, config.dataDir);
}

function parseEmbeddingsConfig(raw: unknown, configPath: string): Result<EmbeddingConfig | undefined> {
  if (raw === undefined || raw === null) {
    return { ok: true, value: undefined };
  }
  if (!isObject(raw)) {
    return failRuntimeConfig("runtime-config-invalid", "runtime config embeddings must be an object", configPath);
  }
  if (raw.enabled !== true) {
    return { ok: true, value: undefined };
  }
  const provider = raw.provider === "command" ? "command" : "builtin";
  const dimensions = typeof raw.dimensions === "number" && raw.dimensions > 0
    ? Math.floor(raw.dimensions)
    : 48;
  const command = Array.isArray(raw.command)
    ? raw.command.filter((value): value is string => typeof value === "string" && value.length > 0)
    : undefined;
  return {
    ok: true,
    value: {
      enabled: true,
      provider,
      model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : "dreamers-local-semantic",
      modelVersion: typeof raw.model_version === "string" && raw.model_version.trim() ? raw.model_version.trim() : "1",
      dimensions,
      command,
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failRuntimeConfig<T = RuntimeConfig>(
  code: string,
  message: string,
  configPath: string,
  error?: unknown,
): Result<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      path: configPath,
      detail: error
        ? {
            cause: error instanceof Error ? error.message : String(error),
          }
        : undefined,
    },
  };
}
