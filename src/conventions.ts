import fs from "fs";
import path from "path";
import { readJsonObjectConfig } from "./config";
import { Result, StructuredError } from "./types";

export interface ConventionPolicy {
  classifiedNoteRoots: string[];
  disallowedRoots: string[];
  classifiedNotePattern: string;
  directoryIndex: DirectoryIndexPolicy;
}

export interface DirectoryIndexPolicy {
  filenamePattern: string;
  protectedSection: string;
}

export interface ConventionPath {
  relativePath: string;
}

export interface LoadConventionPolicyOptions {
  rootDir?: string;
  configPath?: string;
}

const DEFAULT_DIRECTORY_INDEX_POLICY: DirectoryIndexPolicy = {
  filenamePattern: "_<folder-name>.md",
  protectedSection: "Notes",
};

export function loadApprovedTagList(tagsPath: string): Result<string[]> {
  let raw: string;
  try {
    raw = fs.readFileSync(tagsPath, "utf8");
  } catch (error) {
    return failConvention<string[]>("approved-tags-missing", "approved tags could not be read", tagsPath, error);
  }
  return {
    ok: true,
    value: parseApprovedTags(raw),
  };
}

function parseApprovedTags(raw: string): string[] {
  const tags = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) {
      continue;
    }
    const tag = trimmed.slice(2).trim();
    if (tag && !tag.startsWith("**")) {
      tags.add(tag);
    }
  }
  return [...tags].sort();
}

export function validateConventionPath(
  relativePath: string,
  tags: string[],
  approvedTags: Set<string>,
  policy: ConventionPolicy,
): Result<ConventionPath> {
  const normalizedPath = toPosix(relativePath);
  const parts = normalizedPath.split("/").filter(Boolean);
  const errors: StructuredError[] = [];
  const root = parts[0] ?? "";

  if (policy.disallowedRoots.includes(root)) {
    errors.push({
      code: "disallowed-root",
      message: "path targets a disallowed legacy root",
      path: normalizedPath,
    });
  }

  if (policy.classifiedNoteRoots.includes(root) && !isValidClassifiedNotePath(parts, policy)) {
    errors.push({
      code: "classification-depth",
      message: `${root} notes must use ${policy.classifiedNotePattern}`,
      path: normalizedPath,
    });
  }

  for (const tag of tags) {
    if (!approvedTags.has(tag)) {
      errors.push({
        code: "unapproved-tag",
        message: "tag is not in the approved topical tag list",
        tag,
      });
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      error: {
        ...errors[0],
        causes: errors,
      },
    };
  }

  return {
    ok: true,
    value: {
      relativePath: normalizedPath,
    },
  };
}

export function loadConventionPolicy(options: LoadConventionPolicyOptions = {}): Result<ConventionPolicy> {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const configPath = path.resolve(options.configPath ?? path.join(rootDir, "config", "conventions.json"));

  const config = readJsonObjectConfig({
    configPath,
    missingCode: "convention-config-missing",
    invalidJsonCode: "convention-config-invalid-json",
    invalidCode: "convention-config-invalid",
    missingMessage: "convention config could not be read",
    invalidJsonMessage: "convention config is not valid JSON",
    invalidMessage: "convention config must be a JSON object",
  });
  if (!config.ok) {
    return config as Result<ConventionPolicy>;
  }
  const parsed = config.value;
  const classifiedNoteRoots = readStringList(parsed.classified_note_roots);
  const disallowedRoots = readStringList(parsed.disallowed_roots);
  if (!classifiedNoteRoots || !disallowedRoots) {
    return failConvention(
      "convention-config-invalid",
      "convention config roots must be non-empty string arrays",
      configPath,
    );
  }
  if (typeof parsed.classified_note_pattern !== "string" || parsed.classified_note_pattern.trim() === "") {
    return failConvention(
      "convention-config-invalid",
      "convention config must contain a non-empty classified_note_pattern string",
      configPath,
    );
  }
  const directoryIndex = parsed.directory_index === undefined
    ? { ...DEFAULT_DIRECTORY_INDEX_POLICY }
    : readDirectoryIndexPolicy(parsed.directory_index);
  if (!directoryIndex) {
    return failConvention(
      "convention-config-invalid",
      "directory_index must contain a valid filename_pattern and protected_section",
      configPath,
    );
  }

  return {
    ok: true,
    value: {
      classifiedNoteRoots,
      disallowedRoots,
      classifiedNotePattern: parsed.classified_note_pattern,
      directoryIndex,
    },
  };
}

function isValidClassifiedNotePath(parts: string[], policy: ConventionPolicy): boolean {
  const fileName = parts[parts.length - 1] ?? "";
  const isNormalLeafNote = parts.length === 4 && path.posix.extname(fileName) === ".md" && !fileName.startsWith("_");
  return isNormalLeafNote || isDirectoryIndexPath(parts, policy);
}

function isDirectoryIndexPath(parts: string[], policy: ConventionPolicy): boolean {
  if (parts.length < 3) {
    return false;
  }
  const fileName = parts[parts.length - 1] ?? "";
  const folderName = parts[parts.length - 2] ?? "";
  const expectedFileName = policy.directoryIndex.filenamePattern.replace("<folder-name>", folderName);
  return fileName === expectedFileName && path.posix.extname(fileName) === ".md";
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function readStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.length === 0)) {
    return undefined;
  }
  return value;
}

function readDirectoryIndexPolicy(value: unknown): DirectoryIndexPolicy | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const parsed = value as Record<string, unknown>;
  const filenamePattern = parsed.filename_pattern;
  const protectedSection = parsed.protected_section;
  if (
    typeof filenamePattern !== "string" ||
    filenamePattern.split("<folder-name>").length !== 2 ||
    !filenamePattern.endsWith(".md") ||
    filenamePattern.includes("/") ||
    filenamePattern.includes("\\") ||
    typeof protectedSection !== "string" ||
    protectedSection.trim() === "" ||
    protectedSection.includes("\n") ||
    protectedSection.includes("\r")
  ) {
    return undefined;
  }
  return {
    filenamePattern,
    protectedSection,
  };
}

function failConvention<T = ConventionPolicy>(
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
