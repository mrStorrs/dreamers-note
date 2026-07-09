import fs from "fs";
import path from "path";
import { readJsonObjectConfig } from "./config";
import { Result, StructuredError } from "./types";

export interface ConventionPolicy {
  classifiedNoteRoots: string[];
  disallowedRoots: string[];
  classifiedNotePattern: string;
}

export interface ConventionPath {
  relativePath: string;
}

export interface LoadConventionPolicyOptions {
  rootDir?: string;
  configPath?: string;
}

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

  if (
    policy.classifiedNoteRoots.includes(root) &&
    (parts.length !== 4 || path.posix.extname(parts[3]) !== ".md")
  ) {
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

  return {
    ok: true,
    value: {
      classifiedNoteRoots,
      disallowedRoots,
      classifiedNotePattern: parsed.classified_note_pattern,
    },
  };
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
