#!/usr/bin/env node
import path from "path";
import { loadVaultConfig, validateVaultConfig } from "./config";
import { startMcpServer } from "./mcp-server";
import {
  initializeRuntimeState,
  loadRuntimeConfig,
  resolveRuntimeDataDir,
} from "./runtime";

interface CliOptions {
  command: string;
  rootDir: string;
  initRuntime: boolean;
  writeEnabled: boolean;
}

export function main(argv = process.argv.slice(2)): number {
  const options = parseArgs(argv);
  if (!options) {
    return 2;
  }

  if (options.command === "mcp") {
    startMcpServer({ rootDir: options.rootDir, writeEnabled: options.writeEnabled });
    return 0;
  }

  if (options.command !== "doctor" && options.command !== "status") {
    process.stderr.write(`unknown command: ${options.command}\n`);
    return 2;
  }

  const vaultConfig = loadVaultConfig({ rootDir: options.rootDir });
  const runtimeConfig = loadRuntimeConfig({ rootDir: options.rootDir });

  process.stdout.write("dreamers-note package foundation\n");
  process.stdout.write(`root: ${options.rootDir}\n`);

  if (!runtimeConfig.ok) {
    process.stdout.write(`runtime_status: ${runtimeConfig.error.code}\n`);
    process.stdout.write(`runtime_error: ${runtimeConfig.error.message}\n`);
    return 1;
  }

  const runtimeDir = resolveRuntimeDataDir({ rootDir: options.rootDir, config: runtimeConfig.value });
  process.stdout.write(`runtime_dir: ${runtimeDir}\n`);

  if (!vaultConfig.ok) {
    process.stdout.write(`vault_status: ${vaultConfig.error.code}\n`);
    process.stdout.write(`vault_error: ${vaultConfig.error.message}\n`);
    return 1;
  }

  const validation = validateVaultConfig(vaultConfig.value);
  process.stdout.write(`vault_path: ${vaultConfig.value.vaultPath}\n`);
  process.stdout.write(`vault_status: ${validation.ok ? "ok" : validation.error.code}\n`);
  if (!validation.ok) {
    process.stdout.write(`vault_error: ${validation.error.message}\n`);
  }

  if (options.initRuntime) {
    const runtime = initializeRuntimeState({
      rootDir: options.rootDir,
      config: runtimeConfig.value,
    });
    process.stdout.write(`runtime_status: initialized\n`);
    process.stdout.write(`runtime_database: ${runtime.databasePath}\n`);
  } else {
    process.stdout.write("runtime_status: not-initialized\n");
  }

  return validation.ok ? 0 : 1;
}

function parseArgs(argv: string[]): CliOptions | undefined {
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "doctor";
  const rest = command === argv[0] ? argv.slice(1) : argv;
  let rootDir = process.cwd();
  let initRuntime = false;
  let writeEnabled = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--root") {
      const value = rest[index + 1];
      if (!value) {
        process.stderr.write("--root requires a path\n");
        return undefined;
      }
      rootDir = path.resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--init-runtime") {
      initRuntime = true;
      continue;
    }
    if (arg === "--write-enabled") {
      writeEnabled = true;
      continue;
    }
    process.stderr.write(`unknown option: ${arg}\n`);
    return undefined;
  }

  return {
    command,
    rootDir,
    initRuntime,
    writeEnabled,
  };
}

if (require.main === module) {
  process.exitCode = main();
}
