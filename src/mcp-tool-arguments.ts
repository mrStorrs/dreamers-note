import type { createStoredProposal } from "./proposal-queue";
import type { McpParseResult } from "./mcp-contracts";
import type { StructuredError } from "./types";
import { WORKFLOW_POLICY_IDS, type WorkflowPolicyId } from "./mcp-workflow-policy";

export const PROFILE_VALUES = ["answer", "brief", "place", "import", "triage", "review"] as const;
export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_SEARCH_LIMIT = 10;
export const MAX_DIAGNOSTIC_LIMIT = 20;
export const DEFAULT_READ_LIMIT = 3;
export const MAX_READ_LIMIT = 5;
export const DEFAULT_READ_CHARS = 400;
export const MIN_READ_CHARS = 80;
export const MAX_READ_CHARS = 2_000;

type ContextProfile = typeof PROFILE_VALUES[number];
type ProposalCreateInput = Parameters<typeof createStoredProposal>[1];
export type NoArguments = Record<string, never>;
export type SearchArguments = { query: string; limit: number };
export type ReadNoteArguments = { path: string; heading?: string; chunkId?: string; maxChars: number; limit: number };
export type ContextPackArguments = { query: string; profile: ContextProfile; limit: number };
export type RetrievalFeedbackArguments = {
  query: string;
  selectedPaths: string[];
  rejectedPaths: string[];
  reasonCodes: string[];
  proposalId?: string;
};
export type GraphContextPackArguments = { path?: string; query?: string; limit: number };
export type ReviewQueueArguments = { mode: "daily" | "weekly"; limit: number };
export type DiagnosticFeedbackArguments = {
  reportType: string;
  itemKey: string;
  evidenceHash: string;
  action: "dismiss" | "snooze" | "pin" | "intentional";
  reason: string;
  expiresAt?: string;
};
export type ProposalReadArguments = { proposalId: string };
export type ProposalRejectArguments = { proposalId: string; reason?: string };
export type ProposalApplyArguments = { proposalId: string; authorizationId?: string };
export type ProposalCreateArguments = ProposalCreateInput;

export function validateNoArguments(rawArguments: unknown): McpParseResult<Record<string, never>> {
  const args = objectArguments(rawArguments);
  if (!args.ok) {
    return args;
  }
  return {
    ok: true,
    value: {},
  };
}

export function validateSearchArguments(rawArguments: unknown): McpParseResult<{ query: string; limit: number }> {
  const args = objectArguments(rawArguments);
  if (!args.ok) {
    return args;
  }
  const query = stringArgument(args.value, "query");
  if (!query.ok) {
    return query;
  }
  const limit = integerArgument(args.value, "limit", DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
  if (!limit.ok) {
    return limit;
  }
  return {
    ok: true,
    value: {
      query: query.value,
      limit: limit.value,
    },
  };
}

export function validateWorkflowPolicyArguments(rawArguments: unknown): McpParseResult<WorkflowPolicyId> {
  const args = objectArguments(rawArguments);
  if (!args.ok) {
    return args;
  }
  const workflow = args.value.workflow;
  if (!WORKFLOW_POLICY_IDS.includes(workflow as WorkflowPolicyId)) {
    return {
      ok: false,
      error: {
        code: "invalid-arguments",
        message: "workflow must be shared, add, capture, import, or triage",
      },
    };
  }
  return {
    ok: true,
    value: workflow as WorkflowPolicyId,
  };
}

export function validateReadArguments(
  rawArguments: unknown,
): McpParseResult<{ path: string; heading?: string; chunkId?: string; maxChars: number; limit: number }> {
  const args = objectArguments(rawArguments);
  if (!args.ok) {
    return args;
  }

  const pathValue = optionalStringArgument(args.value, "path");
  if (!pathValue.ok) {
    return pathValue;
  }
  const headingValue = optionalStringArgument(args.value, "heading");
  if (!headingValue.ok) {
    return headingValue;
  }
  const chunkValue = optionalStringArgument(args.value, "chunkId");
  if (!chunkValue.ok) {
    return chunkValue;
  }
  if (!pathValue.value && !chunkValue.value) {
    return {
      ok: false,
      error: {
        code: "invalid-arguments",
        message: "read_note requires path or chunkId",
      },
    };
  }
  const maxChars = integerArgument(args.value, "maxChars", DEFAULT_READ_CHARS, MIN_READ_CHARS, MAX_READ_CHARS);
  if (!maxChars.ok) {
    return maxChars;
  }
  const limit = integerArgument(args.value, "limit", DEFAULT_READ_LIMIT, 1, MAX_READ_LIMIT);
  if (!limit.ok) {
    return limit;
  }

  return {
    ok: true,
    value: {
      path: pathValue.value ?? "",
      heading: headingValue.value,
      chunkId: chunkValue.value,
      maxChars: maxChars.value,
      limit: limit.value,
    },
  };
}

export function validateContextPackArguments(
  rawArguments: unknown,
): McpParseResult<{ query: string; profile: ContextProfile; limit: number }> {
  const args = objectArguments(rawArguments);
  if (!args.ok) {
    return args;
  }
  const query = stringArgument(args.value, "query");
  if (!query.ok) {
    return query;
  }
  const rawProfile = args.value.profile;
  if (typeof rawProfile !== "string" || !PROFILE_VALUES.includes(rawProfile as ContextProfile)) {
    return {
      ok: false,
      error: {
        code: "invalid-arguments",
        message: `profile must be one of: ${PROFILE_VALUES.join(", ")}`,
      },
    };
  }
  const limit = integerArgument(args.value, "limit", DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
  if (!limit.ok) {
    return limit;
  }
  return {
    ok: true,
    value: {
      query: query.value,
      profile: rawProfile as ContextProfile,
      limit: limit.value,
    },
  };
}

export function validateRetrievalFeedbackArguments(rawArguments: unknown): McpParseResult<{
  query: string;
  selectedPaths: string[];
  rejectedPaths: string[];
  reasonCodes: string[];
  proposalId?: string;
}> {
  const args = objectArguments(rawArguments);
  if (!args.ok) {
    return args;
  }
  const query = stringArgument(args.value, "query");
  if (!query.ok) {
    return query;
  }
  const selectedPaths = stringArrayArgument(args.value, "selectedPaths");
  if (!selectedPaths.ok) {
    return selectedPaths;
  }
  const rejectedPaths = stringArrayArgument(args.value, "rejectedPaths");
  if (!rejectedPaths.ok) {
    return rejectedPaths;
  }
  const reasonCodes = stringArrayArgument(args.value, "reasonCodes");
  if (!reasonCodes.ok) {
    return reasonCodes;
  }
  const proposalId = optionalStringArgument(args.value, "proposalId");
  if (!proposalId.ok) {
    return proposalId;
  }
  return {
    ok: true,
    value: {
      query: query.value,
      selectedPaths: selectedPaths.value,
      rejectedPaths: rejectedPaths.value,
      reasonCodes: reasonCodes.value,
      proposalId: proposalId.value,
    },
  };
}

export function validateOptionalLimit(rawArguments: unknown, defaultValue: number): McpParseResult<number> {
  const args = objectArguments(rawArguments);
  if (!args.ok) {
    return args;
  }
  return integerArgument(args.value, "limit", defaultValue, 1, MAX_DIAGNOSTIC_LIMIT);
}

export function validateGraphContextPackArguments(
  rawArguments: unknown,
): McpParseResult<{ path?: string; query?: string; limit: number }> {
  const args = objectArguments(rawArguments);
  if (!args.ok) {
    return args;
  }
  const pathValue = optionalStringArgument(args.value, "path");
  if (!pathValue.ok) {
    return pathValue;
  }
  const queryValue = optionalStringArgument(args.value, "query");
  if (!queryValue.ok) {
    return queryValue;
  }
  if (!pathValue.value && !queryValue.value) {
    return {
      ok: false,
      error: {
        code: "invalid-arguments",
        message: "graph_context_pack requires path or query",
      },
    };
  }
  const limit = integerArgument(args.value, "limit", 8, 1, MAX_DIAGNOSTIC_LIMIT);
  if (!limit.ok) {
    return limit;
  }
  return {
    ok: true,
    value: {
      path: pathValue.value ?? undefined,
      query: queryValue.value ?? undefined,
      limit: limit.value,
    },
  };
}

export function validateReviewQueueArguments(rawArguments: unknown): McpParseResult<{ mode: "daily" | "weekly"; limit: number }> {
  const args = objectArguments(rawArguments);
  if (!args.ok) {
    return args;
  }
  const rawMode = args.value.mode;
  if (rawMode !== undefined && rawMode !== "daily" && rawMode !== "weekly") {
    return {
      ok: false,
      error: {
        code: "invalid-arguments",
        message: "mode must be daily or weekly",
      },
    };
  }
  const limit = integerArgument(args.value, "limit", 12, 1, MAX_DIAGNOSTIC_LIMIT);
  if (!limit.ok) {
    return limit;
  }
  return {
    ok: true,
    value: {
      mode: rawMode === "daily" ? "daily" : "weekly",
      limit: limit.value,
    },
  };
}

export function validateDiagnosticFeedbackArguments(rawArguments: unknown): McpParseResult<{
  reportType: string;
  itemKey: string;
  evidenceHash: string;
  action: "dismiss" | "snooze" | "pin" | "intentional";
  reason: string;
  expiresAt?: string;
}> {
  const args = objectArguments(rawArguments);
  if (!args.ok) {
    return args;
  }
  const reportType = stringArgument(args.value, "reportType");
  if (!reportType.ok) {
    return reportType;
  }
  const itemKey = stringArgument(args.value, "itemKey");
  if (!itemKey.ok) {
    return itemKey;
  }
  const evidenceHash = stringArgument(args.value, "evidenceHash");
  if (!evidenceHash.ok) {
    return evidenceHash;
  }
  const action = args.value.action;
  if (action !== "dismiss" && action !== "snooze" && action !== "pin" && action !== "intentional") {
    return {
      ok: false,
      error: {
        code: "invalid-arguments",
        message: "action must be dismiss, snooze, pin, or intentional",
      },
    };
  }
  const reason = stringArgument(args.value, "reason");
  if (!reason.ok) {
    return reason;
  }
  const expiresAt = optionalStringArgument(args.value, "expiresAt");
  if (!expiresAt.ok) {
    return expiresAt;
  }
  if (expiresAt.value) {
    const parsed = Date.parse(expiresAt.value);
    if (!Number.isFinite(parsed)) {
      return {
        ok: false,
        error: {
          code: "invalid-arguments",
          message: "expiresAt must be a valid ISO timestamp",
        },
      };
    }
    if (action === "snooze" && parsed <= Date.now()) {
      return {
        ok: false,
        error: {
          code: "invalid-arguments",
          message: "expiresAt must be in the future for snooze actions",
        },
      };
    }
  }
  return {
    ok: true,
    value: {
      reportType: reportType.value,
      itemKey: itemKey.value,
      evidenceHash: evidenceHash.value,
      action,
      reason: reason.value,
      expiresAt: expiresAt.value ?? undefined,
    },
  };
}

export function validateProposalReadArguments(rawArguments: unknown): McpParseResult<{ proposalId: string }> {
  const args = objectArguments(rawArguments);
  if (!args.ok) {
    return args;
  }
  const proposalId = stringArgument(args.value, "proposalId");
  if (!proposalId.ok) {
    return proposalId;
  }
  return {
    ok: true,
    value: {
      proposalId: proposalId.value,
    },
  };
}

export function validateProposalRejectArguments(rawArguments: unknown): McpParseResult<{ proposalId: string; reason?: string }> {
  const args = objectArguments(rawArguments);
  if (!args.ok) {
    return args;
  }
  const proposalId = stringArgument(args.value, "proposalId");
  if (!proposalId.ok) {
    return proposalId;
  }
  const reason = optionalStringArgument(args.value, "reason");
  if (!reason.ok) {
    return reason;
  }
  return {
    ok: true,
    value: {
      proposalId: proposalId.value,
      reason: reason.value,
    },
  };
}

export function validateProposalAuthorizeArguments(rawArguments: unknown): McpParseResult<{ proposalId: string }> {
  return validateProposalReadArguments(rawArguments);
}

export function validateProposalApplyArguments(rawArguments: unknown): McpParseResult<{ proposalId: string; authorizationId?: string }> {
  const args = objectArguments(rawArguments);
  if (!args.ok) {
    return args;
  }
  const proposalId = stringArgument(args.value, "proposalId");
  if (!proposalId.ok) {
    return proposalId;
  }
  const authorizationId = optionalStringArgument(args.value, "authorizationId");
  if (!authorizationId.ok) {
    return authorizationId;
  }
  return {
    ok: true,
    value: {
      proposalId: proposalId.value,
      authorizationId: authorizationId.value,
    },
  };
}

export function validateProposalCreateNoteArguments(rawArguments: unknown): McpParseResult<ProposalCreateInput> {
  const args = objectArguments(rawArguments);
  if (!args.ok) {
    return args;
  }
  const operation = stringArgument(args.value, "operation");
  if (!operation.ok) {
    return operation;
  }
  const proposalPath = stringArgument(args.value, "path");
  if (!proposalPath.ok) {
    return proposalPath;
  }
  const mode = proposalTargetModeArgument(args.value, "mode");
  if (!mode.ok) {
    return mode;
  }
  const body = nonEmptyTextArgument(args.value, "body");
  if (!body.ok) {
    return body;
  }
  const rationale = stringArgument(args.value, "rationale");
  if (!rationale.ok) {
    return rationale;
  }
  const common = validateCommonProposalFields(args.value);
  if (!common.ok) {
    return common;
  }
  return {
    ok: true,
    value: {
      ...common.value,
      operation: operation.value,
      rationale: rationale.value,
      unresolvedQuestions: [],
      validationBlockers: [],
      pathActions: [],
      targets: [
        {
          path: proposalPath.value,
          mode: mode.value,
          body: body.value,
        },
      ],
    },
  };
}

export function validateProposalCreateArguments(rawArguments: unknown): McpParseResult<ProposalCreateInput> {
  const args = objectArguments(rawArguments);
  if (!args.ok) {
    return args;
  }
  const operation = stringArgument(args.value, "operation");
  if (!operation.ok) {
    return operation;
  }
  const rationale = stringArgument(args.value, "rationale");
  if (!rationale.ok) {
    return rationale;
  }
  const common = validateCommonProposalFields(args.value);
  if (!common.ok) {
    return common;
  }
  const unresolvedQuestions = stringArrayArgument(args.value, "unresolvedQuestions");
  if (!unresolvedQuestions.ok) {
    return unresolvedQuestions;
  }
  const validationBlockers = stringArrayArgument(args.value, "validationBlockers");
  if (!validationBlockers.ok) {
    return validationBlockers;
  }
  const pathActions = pathActionArrayArgument(args.value, "pathActions");
  if (!pathActions.ok) {
    return pathActions;
  }
  const targets = targetArrayArgument(args.value, "targets");
  if (!targets.ok) {
    return targets;
  }
  return {
    ok: true,
    value: {
      ...common.value,
      operation: operation.value,
      rationale: rationale.value,
      unresolvedQuestions: unresolvedQuestions.value,
      validationBlockers: validationBlockers.value,
      pathActions: pathActions.value,
      targets: targets.value,
    },
  };
}

function validateCommonProposalFields(args: Record<string, unknown>): McpParseResult<Omit<
  ProposalCreateInput,
  "operation" | "rationale" | "unresolvedQuestions" | "validationBlockers" | "pathActions" | "targets"
>> {
  const bundleId = optionalStringArgument(args, "bundleId");
  if (!bundleId.ok) {
    return bundleId;
  }
  const contextPackId = optionalStringArgument(args, "contextPackId");
  if (!contextPackId.ok) {
    return contextPackId;
  }
  const sourceChunkIds = stringArrayArgument(args, "sourceChunkIds");
  if (!sourceChunkIds.ok) {
    return sourceChunkIds;
  }
  const candidatePaths = stringArrayArgument(args, "candidatePaths");
  if (!candidatePaths.ok) {
    return candidatePaths;
  }
  const approvedTags = stringArrayArgument(args, "approvedTags");
  if (!approvedTags.ok) {
    return approvedTags;
  }
  const proposedTagGaps = stringArrayArgument(args, "proposedTagGaps");
  if (!proposedTagGaps.ok) {
    return proposedTagGaps;
  }
  const dependencies = stringArrayArgument(args, "dependencies");
  if (!dependencies.ok) {
    return dependencies;
  }
  const evidence = evidenceArrayArgument(args, "evidence");
  if (!evidence.ok) {
    return evidence;
  }
  const placementScorecard = objectArgument(args, "placementScorecard");
  if (!placementScorecard.ok) {
    return placementScorecard;
  }
  const placementDebt = objectArgument(args, "placementDebt");
  if (!placementDebt.ok) {
    return placementDebt;
  }
  return {
    ok: true,
    value: {
      bundleId: bundleId.value,
      contextPackId: contextPackId.value,
      sourceChunkIds: sourceChunkIds.value,
      candidatePaths: candidatePaths.value,
      approvedTags: approvedTags.value,
      proposedTagGaps: proposedTagGaps.value,
      dependencies: dependencies.value,
      placementScorecard: placementScorecard.value,
      placementDebt: placementDebt.value as ProposalCreateInput["placementDebt"],
      evidence: evidence.value,
    },
  };
}

function objectArguments(rawArguments: unknown): McpParseResult<Record<string, unknown>> {
  if (rawArguments === undefined) {
    return {
      ok: true,
      value: {},
    };
  }
  if (typeof rawArguments !== "object" || rawArguments === null || Array.isArray(rawArguments)) {
    return {
      ok: false,
      error: {
        code: "invalid-arguments",
        message: "arguments must be an object",
      },
    };
  }
  return {
    ok: true,
    value: rawArguments as Record<string, unknown>,
  };
}

function stringArgument(args: Record<string, unknown>, key: string): McpParseResult<string> {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    return {
      ok: false,
      error: {
        code: "invalid-arguments",
        message: `${key} must be a non-empty string`,
      },
    };
  }
  return {
    ok: true,
    value: value.trim(),
  };
}

function nonEmptyTextArgument(args: Record<string, unknown>, key: string): McpParseResult<string> {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    return {
      ok: false,
      error: {
        code: "invalid-arguments",
        message: `${key} must be a non-empty string`,
      },
    };
  }
  return {
    ok: true,
    value,
  };
}

function optionalStringArgument(args: Record<string, unknown>, key: string): McpParseResult<string | undefined> {
  const value = args[key];
  if (value === undefined) {
    return {
      ok: true,
      value: undefined,
    };
  }
  if (typeof value !== "string" || value.trim() === "") {
    return {
      ok: false,
      error: {
        code: "invalid-arguments",
        message: `${key} must be a non-empty string when provided`,
      },
    };
  }
  return {
    ok: true,
    value: value.trim(),
  };
}

function proposalTargetModeArgument(args: Record<string, unknown>, key: string): McpParseResult<"create" | "replace"> {
  const value = args[key];
  if (value !== "create" && value !== "replace") {
    return {
      ok: false,
      error: {
        code: "invalid-arguments",
        message: `${key} must be create or replace`,
      },
    };
  }
  return {
    ok: true,
    value,
  };
}

function integerArgument(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): McpParseResult<number> {
  const value = args[key];
  if (value === undefined) {
    return {
      ok: true,
      value: fallback,
    };
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    return {
      ok: false,
      error: {
        code: "invalid-arguments",
        message: `${key} must be an integer between ${minimum} and ${maximum}`,
      },
    };
  }
  return {
    ok: true,
    value,
  };
}

function stringArrayArgument(args: Record<string, unknown>, key: string): McpParseResult<string[]> {
  const value = args[key];
  if (value === undefined) {
    return {
      ok: true,
      value: [],
    };
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return {
      ok: false,
      error: {
        code: "invalid-arguments",
        message: `${key} must be an array of strings`,
      },
    };
  }
  return {
    ok: true,
    value: [...new Set(value.map((item) => item.trim()).filter(Boolean))],
  };
}

function objectArgument(args: Record<string, unknown>, key: string): McpParseResult<Record<string, unknown> | undefined> {
  const value = args[key];
  if (value === undefined) {
    return {
      ok: true,
      value: undefined,
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error: {
        code: "invalid-arguments",
        message: `${key} must be an object when provided`,
      },
    };
  }
  return {
    ok: true,
    value: value as Record<string, unknown>,
  };
}

function evidenceArrayArgument(args: Record<string, unknown>, key: string): McpParseResult<Array<{
  path: string;
  chunkId?: string;
  headingPath?: string;
  excerpt?: string;
}>> {
  const value = args[key];
  if (value === undefined) {
    return {
      ok: true,
      value: [],
    };
  }
  if (!Array.isArray(value)) {
    return {
      ok: false,
      error: {
        code: "invalid-arguments",
        message: `${key} must be an array`,
      },
    };
  }
  const entries: Array<{ path: string; chunkId?: string; headingPath?: string; excerpt?: string }> = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return {
        ok: false,
        error: {
          code: "invalid-arguments",
          message: `${key} entries must be objects`,
        },
      };
    }
    const itemRecord = item as Record<string, unknown>;
    const pathValue = itemRecord.path;
    if (typeof pathValue !== "string" || !pathValue.trim()) {
      return {
        ok: false,
        error: {
          code: "invalid-arguments",
          message: `${key} entries must include a non-empty path`,
        },
      };
    }
    entries.push({
      path: pathValue.trim(),
      chunkId: typeof itemRecord.chunkId === "string" && itemRecord.chunkId.trim() ? itemRecord.chunkId.trim() : undefined,
      headingPath: typeof itemRecord.headingPath === "string" && itemRecord.headingPath.trim() ? itemRecord.headingPath.trim() : undefined,
      excerpt: typeof itemRecord.excerpt === "string" && itemRecord.excerpt.trim() ? itemRecord.excerpt.trim() : undefined,
    });
  }
  return {
    ok: true,
    value: entries,
  };
}

function targetArrayArgument(args: Record<string, unknown>, key: string): McpParseResult<Array<{
  path: string;
  mode?: "create" | "replace";
  body: string;
}>> {
  const value = args[key];
  if (value === undefined) {
    return {
      ok: true,
      value: [],
    };
  }
  if (!Array.isArray(value)) {
    return {
      ok: false,
      error: {
        code: "invalid-arguments",
        message: `${key} must be an array`,
      },
    };
  }
  const entries: Array<{ path: string; mode?: "create" | "replace"; body: string }> = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return {
        ok: false,
        error: {
          code: "invalid-arguments",
          message: `${key} entries must be objects`,
        },
      };
    }
    const itemRecord = item as Record<string, unknown>;
    if (typeof itemRecord.path !== "string" || !itemRecord.path.trim()) {
      return {
        ok: false,
        error: {
          code: "invalid-arguments",
          message: `${key} entries must include a non-empty path`,
        },
      };
    }
    if (typeof itemRecord.body !== "string" || !itemRecord.body.length) {
      return {
        ok: false,
        error: {
          code: "invalid-arguments",
          message: `${key} entries must include a non-empty body`,
        },
      };
    }
    const mode: "create" | "replace" | undefined = itemRecord.mode === "create"
      ? "create"
      : itemRecord.mode === "replace"
      ? "replace"
      : undefined;
    entries.push({
      path: itemRecord.path.trim(),
      mode,
      body: itemRecord.body,
    });
  }
  return {
    ok: true,
    value: entries,
  };
}

function pathActionArrayArgument(args: Record<string, unknown>, key: string): McpParseResult<Array<{
  type: "move" | "delete-file";
  scope?: "vault" | "external";
  path: string;
  destinationPath?: string;
}>> {
  const value = args[key];
  if (value === undefined) {
    return {
      ok: true,
      value: [],
    };
  }
  if (!Array.isArray(value)) {
    return {
      ok: false,
      error: {
        code: "invalid-arguments",
        message: `${key} must be an array`,
      },
    };
  }
  const entries: Array<{
    type: "move" | "delete-file";
    scope?: "vault" | "external";
    path: string;
    destinationPath?: string;
  }> = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return {
        ok: false,
        error: {
          code: "invalid-arguments",
          message: `${key} entries must be objects`,
        },
      };
    }
    const itemRecord = item as Record<string, unknown>;
    const type: "move" | "delete-file" | undefined = itemRecord.type === "move"
      ? "move"
      : itemRecord.type === "delete-file"
      ? "delete-file"
      : undefined;
    if (!type) {
      return {
        ok: false,
        error: {
          code: "invalid-arguments",
          message: `${key} entries must include a supported type`,
        },
      };
    }
    if (typeof itemRecord.path !== "string" || !itemRecord.path.trim()) {
      return {
        ok: false,
        error: {
          code: "invalid-arguments",
          message: `${key} entries must include a non-empty path`,
        },
      };
    }
    const scope: "vault" | "external" | undefined = itemRecord.scope === "external"
      ? "external"
      : itemRecord.scope === "vault"
      ? "vault"
      : undefined;
    const destinationPath = typeof itemRecord.destinationPath === "string" && itemRecord.destinationPath.trim()
      ? itemRecord.destinationPath.trim()
      : undefined;
    entries.push({
      type,
      scope,
      path: itemRecord.path.trim(),
      destinationPath,
    });
  }
  return {
    ok: true,
    value: entries,
  };
}
