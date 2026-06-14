import fs from "fs";
import path from "path";
import type { EmbeddingConfig } from "./embeddings";
import { openIndexDatabase } from "./index-db";

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

export function loadRuntimeConfig(options: LoadRuntimeConfigOptions = {}): RuntimeConfig {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const configPath = path.resolve(options.configPath ?? path.join(rootDir, "config", "runtime.json"));
  const defaults = {
    data_dir: ".dreamers-note-runtime",
    private_globs: ["07-system/secrets/**"],
  };

  if (!fs.existsSync(configPath)) {
    return {
      dataDir: defaults.data_dir,
      privateGlobs: defaults.private_globs,
      configPath,
    };
  }

  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    data_dir?: unknown;
    private_globs?: unknown;
    embeddings?: unknown;
  };

  return {
    dataDir: typeof parsed.data_dir === "string" && parsed.data_dir ? parsed.data_dir : defaults.data_dir,
    privateGlobs: Array.isArray(parsed.private_globs)
      ? parsed.private_globs.filter((value): value is string => typeof value === "string" && value.length > 0)
      : defaults.private_globs,
    configPath,
    embeddings: parseEmbeddingsConfig(parsed.embeddings),
  };
}

export function initializeRuntimeState(options: {
  rootDir?: string;
  config?: RuntimeConfig;
} = {}): RuntimeState {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const config = options.config ?? loadRuntimeConfig({ rootDir });
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

export function resolveRuntimeDataDir(options: { rootDir?: string; config?: RuntimeConfig } = {}): string {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const config = options.config ?? loadRuntimeConfig({ rootDir });
  return path.resolve(rootDir, config.dataDir);
}

export function isRuntimeGitIgnored(options: { rootDir?: string; dataDir: string }): boolean {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const relative = toPosix(path.relative(rootDir, path.resolve(options.dataDir))).replace(/\/$/, "");
  const gitignorePath = path.join(rootDir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    return false;
  }
  const entries = fs
    .readFileSync(gitignorePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.replace(/\/$/, ""));

  return entries.includes(relative) || entries.includes(path.basename(relative));
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function parseEmbeddingsConfig(raw: unknown): EmbeddingConfig | undefined {
  if (!isObject(raw) || raw.enabled !== true) {
    return undefined;
  }
  const provider = raw.provider === "command" ? "command" : "builtin";
  const dimensions = typeof raw.dimensions === "number" && raw.dimensions > 0
    ? Math.floor(raw.dimensions)
    : 48;
  const command = Array.isArray(raw.command)
    ? raw.command.filter((value): value is string => typeof value === "string" && value.length > 0)
    : undefined;
  return {
    enabled: true,
    provider,
    model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : "dreamers-local-semantic",
    modelVersion: typeof raw.model_version === "string" && raw.model_version.trim() ? raw.model_version.trim() : "1",
    dimensions,
    command,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
