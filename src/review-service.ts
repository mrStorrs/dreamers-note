import {
  buildEphemeralDuplicateCandidates,
  buildEphemeralGraphDiagnostics,
  buildEphemeralHealthReport,
  buildDuplicateCandidates,
  buildGraphDiagnostics,
  buildHealthReport,
} from "./graph-review";
import { ensureRuntimeReady, type RuntimeReadiness } from "./runtime-readiness";
import type { Result, StructuredError } from "./types";
import type { VaultEnvironment } from "./vault-environment";

const DEFAULT_REVIEW_LIMIT = 10;
const MAX_REVIEW_LIMIT = 50;

export type ReviewKind = "graph" | "health" | "duplicates";

export interface ReviewContextInput {
  kind: ReviewKind;
  limit?: number;
}

export interface ReviewContextResult {
  kind: ReviewKind;
  readiness: RuntimeReadiness;
  result: unknown;
}

export function reviewContext(
  environment: VaultEnvironment,
  input: ReviewContextInput,
): Result<ReviewContextResult> {
  const readiness = ensureRuntimeReady(environment);
  if (!readiness.ok) {
    return readiness;
  }
  const review = executeReview(environment, input, false);
  if (!review.ok) {
    return review as Result<ReviewContextResult>;
  }
  return {
    ok: true,
    value: {
      kind: input.kind,
      readiness: readiness.value,
      result: review.value,
    },
  };
}

export function reviewContextForAdapter(
  environment: VaultEnvironment,
  input: ReviewContextInput,
) {
  return executeReview(environment, input, true);
}

function executeReview(
  environment: VaultEnvironment,
  input: ReviewContextInput,
  persistReport: boolean,
) {
  if (!isReviewKind(input.kind)) {
    return fail("review-kind-invalid", "review kind must be graph, health, or duplicates");
  }
  const limit = input.limit ?? DEFAULT_REVIEW_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REVIEW_LIMIT) {
    return fail("review-limit-invalid", "review limit is outside the safe range");
  }
  const result = persistReport
    ? legacyReview(environment, input.kind, limit)
    : ephemeralReview(environment, input.kind, limit);
  if (!result.ok) {
    return {
      ok: false as const,
      error: normalizeError(result.error),
    };
  }
  return result;
}

function ephemeralReview(environment: VaultEnvironment, kind: ReviewKind, limit: number) {
  switch (kind) {
    case "graph":
      return buildEphemeralGraphDiagnostics(environment, { limit });
    case "health":
      return buildEphemeralHealthReport(environment, { limit });
    case "duplicates":
      return buildEphemeralDuplicateCandidates(environment, { limit });
  }
}

function legacyReview(environment: VaultEnvironment, kind: ReviewKind, limit: number) {
  switch (kind) {
    case "graph":
      return buildGraphDiagnostics(environment, { limit, persistReport: true });
    case "health":
      return buildHealthReport(environment, { limit, persistReport: true });
    case "duplicates":
      return buildDuplicateCandidates(environment, { limit, persistReport: true });
  }
}

function isReviewKind(value: string): value is ReviewKind {
  return value === "graph" || value === "health" || value === "duplicates";
}

function normalizeError(error: StructuredError): StructuredError {
  const busy = /SQLITE_BUSY|database is locked/i.test(error.message);
  return {
    code: busy ? "index-busy" : error.code,
    message: busy ? "runtime index is busy" : error.message,
  };
}

function fail<T>(code: string, message: string): Result<T> {
  return {
    ok: false,
    error: { code, message },
  };
}
