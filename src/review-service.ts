import { buildDuplicateReview, buildGraphReview, buildHealthReview } from "./graph-review";
import { ensureRuntimeReady, type RuntimeReadiness } from "./runtime-readiness";
import type { Result } from "./types";
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

export function reviewContext(environment: VaultEnvironment, input: ReviewContextInput): Result<ReviewContextResult> {
  if (!isReviewKind(input.kind)) return fail("review-kind-invalid", "review kind must be graph, health, or duplicates");
  const limit = input.limit ?? DEFAULT_REVIEW_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REVIEW_LIMIT) return fail("review-limit-invalid", "review limit is outside the safe range");
  const readiness = ensureRuntimeReady(environment);
  if (!readiness.ok) return readiness;
  const options = { limit };
  const result = input.kind === "graph"
    ? buildGraphReview(environment, options)
    : input.kind === "health"
      ? buildHealthReview(environment, options)
      : buildDuplicateReview(environment, options);
  if (!result.ok) return result as Result<ReviewContextResult>;
  return { ok: true, value: { kind: input.kind, readiness: readiness.value, result: result.value } };
}

function isReviewKind(value: string): value is ReviewKind {
  return value === "graph" || value === "health" || value === "duplicates";
}

function fail<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message } };
}
