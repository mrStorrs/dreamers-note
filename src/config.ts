import fs from "fs";
import path from "path";
import { Result, StructuredError } from "./types";

export interface VaultConfig {
  vaultPath: string;
  configPath: string;
}

export interface LoadVaultConfigOptions {
  rootDir?: string;
  configPath?: string;
}

export interface ValidateVaultConfigOptions {
  expectedVaultRoot?: string;
}

export function loadVaultConfig(options: LoadVaultConfigOptions = {}): Result<VaultConfig> {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const configPath = path.resolve(options.configPath ?? path.join(rootDir, "config", "vault.json"));

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    return structuredConfigError("vault-config-missing", "vault config could not be read", configPath, error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return structuredConfigError("vault-config-invalid-json", "vault config is not valid JSON", configPath, error);
  }

  if (!isObject(parsed) || typeof parsed.vault_path !== "string" || parsed.vault_path.trim() === "") {
    return {
      ok: false,
      error: {
        code: "vault-config-invalid",
        message: "vault config must contain a non-empty vault_path string",
        path: configPath,
      },
    };
  }

  const vaultPath = path.resolve(rootDir, parsed.vault_path);
  return {
    ok: true,
    value: {
      vaultPath,
      configPath,
    },
  };
}

export function validateVaultConfig(
  config: VaultConfig,
  options: ValidateVaultConfigOptions = {},
): Result<VaultConfig> {
  const vaultPath = path.resolve(config.vaultPath);
  const expectedVaultRoot = options.expectedVaultRoot
    ? path.resolve(options.expectedVaultRoot)
    : undefined;

  if (expectedVaultRoot && !isInside(vaultPath, expectedVaultRoot)) {
    return {
      ok: false,
      error: {
        code: "vault-outside-boundary",
        message: "configured vault path is outside the expected boundary",
        path: vaultPath,
        detail: {
          expectedVaultRoot,
        },
      },
    };
  }

  if (!fs.existsSync(vaultPath)) {
    return {
      ok: false,
      error: {
        code: "vault-missing",
        message: "configured vault path does not exist",
        path: vaultPath,
      },
    };
  }

  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(vaultPath);
  } catch (error) {
    return structuredValidationError("vault-unreadable", "configured vault path could not be inspected", vaultPath, error);
  }

  if (lstat.isSymbolicLink()) {
    return {
      ok: false,
      error: {
        code: "vault-symlink",
        message: "configured vault path must not be a symlink",
        path: vaultPath,
      },
    };
  }

  if (expectedVaultRoot) {
    const realVaultPath = fs.realpathSync(vaultPath);
    const realExpectedRoot = fs.existsSync(expectedVaultRoot)
      ? fs.realpathSync(expectedVaultRoot)
      : expectedVaultRoot;
    if (!isInside(realVaultPath, realExpectedRoot)) {
      return {
        ok: false,
        error: {
          code: "vault-outside-boundary",
          message: "configured vault real path is outside the expected real boundary",
          path: realVaultPath,
          detail: {
            expectedVaultRoot: realExpectedRoot,
          },
        },
      };
    }
  }

  const stat = fs.statSync(vaultPath);
  if (!stat.isDirectory()) {
    return {
      ok: false,
      error: {
        code: "vault-not-directory",
        message: "configured vault path is not a directory",
        path: vaultPath,
      },
    };
  }

  if ((stat.mode & 0o444) === 0) {
    return {
      ok: false,
      error: {
        code: "vault-unreadable",
        message: "configured vault path has no read permissions",
        path: vaultPath,
      },
    };
  }

  try {
    fs.accessSync(vaultPath, fs.constants.R_OK);
  } catch (error) {
    return structuredValidationError("vault-unreadable", "configured vault path is not readable", vaultPath, error);
  }

  return {
    ok: true,
    value: {
      vaultPath,
      configPath: config.configPath,
    },
  };
}

export function isInside(candidatePath: string, boundaryPath: string): boolean {
  const relative = path.relative(path.resolve(boundaryPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function structuredConfigError(
  code: string,
  message: string,
  configPath: string,
  error: unknown,
): Result<VaultConfig> {
  return {
    ok: false,
    error: {
      code,
      message,
      path: configPath,
      detail: {
        cause: error instanceof Error ? error.message : String(error),
      },
    },
  };
}

function structuredValidationError(
  code: string,
  message: string,
  vaultPath: string,
  error: unknown,
): Result<VaultConfig> {
  return {
    ok: false,
    error: {
      code,
      message,
      path: vaultPath,
      detail: {
        cause: error instanceof Error ? error.message : String(error),
      },
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
