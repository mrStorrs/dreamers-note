import crypto from "crypto";
import { EXCLUDED_PATH_PARTS } from "./path-safety";
import { Result, StructuredError } from "./types";

export const PROPOSAL_EXCERPT_LIMIT = 240;
export const DEFAULT_PROPOSAL_EXPIRY_DAYS = 7;

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function approvedTagsHash(tags: string[]): string {
  return sha256(JSON.stringify([...new Set(tags)].sort()));
}

export function exclusionConfigHashFor(privateGlobs: string[]): string {
  return sha256(
    JSON.stringify({
      privateGlobs: [...new Set(privateGlobs)].sort(),
      excludedRoots: [...EXCLUDED_PATH_PARTS].sort(),
    }),
  );
}

export function boundExcerpt(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, maxChars - 3).trimEnd()}...`;
}

export function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return [...new Set(values.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))];
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

export function fail(
  code: string,
  message: string,
  extra: Partial<StructuredError> = {},
): Result<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...extra,
    },
  };
}

export function structured(code: string, message: string, pathValue?: string): StructuredError {
  return {
    code,
    message,
    path: pathValue,
  };
}

export function asStructuredResult(error: unknown): Result<never> {
  if (isStructuredError(error)) {
    return {
      ok: false,
      error,
    };
  }
  return unexpected("proposal-unexpected-error", error);
}

export function unexpected(code: string, error: unknown): Result<never> {
  return {
    ok: false,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStructuredError(error: unknown): error is StructuredError {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && "message" in error;
}
