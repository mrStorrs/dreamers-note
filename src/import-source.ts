import fs from "fs";
import os from "os";
import path from "path";
import { fileHash } from "./files";
import { inspectPathPolicy } from "./path-safety";
import { Result } from "./types";

const DEFAULT_IMPORT_SOURCE_MAX_BYTES = 512 * 1024;
const ALLOWED_EXTENSIONS = new Set([".md", ".markdown", ".txt", ""]);

export interface InspectImportSourceOptions {
  rootDir: string;
  vaultPath: string;
  privateGlobs: string[];
  inputPath: string;
  explicitPathProvided?: boolean;
  maxBytes?: number;
}

export interface ImportSourceInspection {
  absolutePath: string;
  hash: string;
  size: number;
  preview: string;
  contentType: "text/markdown" | "text/plain";
  vaultRelativePath?: string;
}

export function inspectImportSource(options: InspectImportSourceOptions): Result<ImportSourceInspection> {
  if (!options.explicitPathProvided || !options.inputPath.trim()) {
    return fail("import-source-explicit-path-required", "an explicit import source path is required");
  }
  if (/[\x00-\x1F\x7F]/.test(options.inputPath)) {
    return fail("import-source-invalid-path", "import source path contains control characters");
  }

  const rootDir = path.resolve(options.rootDir);
  const expanded = expandHome(options.inputPath.trim());
  const absolutePath = path.resolve(rootDir, expanded);
  const vaultPath = path.resolve(options.vaultPath);
  const privateGlobs = options.privateGlobs;
  const maxBytes = options.maxBytes ?? DEFAULT_IMPORT_SOURCE_MAX_BYTES;

  const pathPolicy = inspectPathPolicy({
    vaultPath,
    input: absolutePath,
    privateGlobs,
    allowExternal: true,
  });
  if (!pathPolicy.ok) {
    if (pathPolicy.error.code === "symlink") {
      return fail("import-source-symlink", "import source path includes a symlink", pathPolicy.error.path);
    }
    return fail(pathPolicy.error.code, pathPolicy.error.message, pathPolicy.error.path);
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return fail("import-source-missing", "import source file does not exist", absolutePath);
    }
    return fail("import-source-unreadable", "import source file could not be inspected", absolutePath);
  }

  if (stat.isSymbolicLink()) {
    return fail("import-source-symlink", "import source path must not be a symlink", absolutePath);
  }
  if (!stat.isFile()) {
    return fail("import-source-not-regular-file", "import source path must be a regular file", absolutePath);
  }
  if ((stat.mode & 0o444) === 0) {
    return fail("import-source-unreadable", "import source file is not readable", absolutePath);
  }
  try {
    fs.accessSync(absolutePath, fs.constants.R_OK);
  } catch {
    return fail("import-source-unreadable", "import source file is not readable", absolutePath);
  }
  if (stat.size > maxBytes) {
    return fail("import-source-too-large", "import source file exceeds the safe size limit", absolutePath);
  }

  const vaultRelativePath = pathPolicy.value.inVault ? pathPolicy.value.normalizedRelativePath : undefined;

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return fail("import-source-unreadable", "import source file could not be read", absolutePath);
  }
  if (buffer.includes(0)) {
    return fail("import-source-binary", "import source appears to be binary", absolutePath);
  }

  const extension = path.extname(absolutePath).toLocaleLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    return fail("import-source-unsupported-type", "import source must be Markdown or text", absolutePath);
  }

  const text = buffer.toString("utf8");
  const preview = text.slice(0, 400);
  return {
    ok: true,
    value: {
      absolutePath,
      hash: fileHash(absolutePath),
      size: stat.size,
      preview,
      contentType: extension === ".txt" ? "text/plain" : "text/markdown",
      vaultRelativePath,
    },
  };
}

function fail(code: string, message: string, pathValue?: string): Result<ImportSourceInspection> {
  return {
    ok: false,
    error: {
      code,
      message,
      path: pathValue,
    },
  };
}

function expandHome(inputPath: string): string {
  if (!inputPath.startsWith("~")) {
    return inputPath;
  }
  if (inputPath === "~") {
    return os.homedir();
  }
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}
