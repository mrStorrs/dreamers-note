import fs from "fs";
import path from "path";
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

export function loadApprovedTags(tagsPath: string): Set<string> {
  const tags = new Set<string>();
  for (const line of fs.readFileSync(tagsPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) {
      continue;
    }
    const tag = trimmed.slice(2).trim();
    if (tag && !tag.startsWith("**")) {
      tags.add(tag);
    }
  }
  return tags;
}

export function validateConventionPath(
  relativePath: string,
  tags: string[],
  approvedTags: Set<string>,
  policy = loadConventionPolicy(),
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

export function loadConventionPolicy(options: LoadConventionPolicyOptions = {}): ConventionPolicy {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const configPath = path.resolve(options.configPath ?? path.join(rootDir, "config", "conventions.json"));
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    classified_note_roots?: unknown;
    disallowed_roots?: unknown;
    classified_note_pattern?: unknown;
  };

  return {
    classifiedNoteRoots: readStringList(parsed.classified_note_roots, "classified_note_roots"),
    disallowedRoots: readStringList(parsed.disallowed_roots, "disallowed_roots"),
    classifiedNotePattern:
      typeof parsed.classified_note_pattern === "string" && parsed.classified_note_pattern
        ? parsed.classified_note_pattern
        : "<root>/<main>/<sub>/<note-name>.md",
  };
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function readStringList(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`config/conventions.json ${fieldName} must be a non-empty string array`);
  }
  return value;
}
