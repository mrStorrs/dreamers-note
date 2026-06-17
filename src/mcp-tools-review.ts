import type { McpToolSpec } from "./mcp-contracts";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_DIAGNOSTIC_LIMIT,
  validateDiagnosticFeedbackArguments,
  validateGraphContextPackArguments,
  validateOptionalLimit,
  validateReviewQueueArguments,
} from "./mcp-tool-arguments";
import {
  limitProperty,
  objectSchema,
  stringProperty,
} from "./mcp-tool-schema";

export const REVIEW_MCP_TOOL_SPECS: McpToolSpec[] = [
  {
    name: "graph_diagnostics",
    title: "Graph Diagnostics",
    description: "Report bounded graph structure signals, weak areas, and excluded secret counts from runtime state.",
    inputSchema: objectSchema({
      limit: limitProperty(MAX_DIAGNOSTIC_LIMIT, DEFAULT_SEARCH_LIMIT, "Maximum items to include per diagnostic section."),
    }),
    writePolicy: "read-only",
    copilotAllowlisted: true,
    parseArguments: (rawArguments) => validateOptionalLimit(rawArguments, DEFAULT_SEARCH_LIMIT),
  },
  {
    name: "graph_context_pack",
    title: "Graph Context Pack",
    description: "Return a bounded note neighborhood grouped by edge type, evidence, confidence, and suggested use.",
    inputSchema: objectSchema({
      path: stringProperty("Vault-relative note path to inspect."),
      query: stringProperty("Search query used to choose the graph context subject note.", { minLength: 1 }),
      limit: limitProperty(MAX_DIAGNOSTIC_LIMIT, 8, "Maximum items per neighborhood group."),
    }),
    writePolicy: "read-only",
    copilotAllowlisted: true,
    parseArguments: validateGraphContextPackArguments,
  },
  {
    name: "health_report",
    title: "Health Report",
    description: "Return bounded note-quality and workflow-health diagnostics with evidence and proposal hints.",
    inputSchema: objectSchema({
      limit: limitProperty(MAX_DIAGNOSTIC_LIMIT, 12, "Maximum diagnostic items to return."),
    }),
    writePolicy: "read-only",
    copilotAllowlisted: true,
    parseArguments: (rawArguments) => validateOptionalLimit(rawArguments, 12),
  },
  {
    name: "duplicate_candidates",
    title: "Duplicate Candidates",
    description: "Suggest merge-review, link, ignore, or keep-both duplicate decisions without mutating notes.",
    inputSchema: objectSchema({
      limit: limitProperty(MAX_DIAGNOSTIC_LIMIT, 10, "Maximum duplicate candidates to return."),
    }),
    writePolicy: "read-only",
    copilotAllowlisted: true,
    parseArguments: (rawArguments) => validateOptionalLimit(rawArguments, 10),
  },
  {
    name: "resurfacing_report",
    title: "Resurfacing Report",
    description: "Return stale but relevant notes, placement debt, and older context worth reviewing again.",
    inputSchema: objectSchema({
      limit: limitProperty(MAX_DIAGNOSTIC_LIMIT, 12, "Maximum resurfacing items to return."),
    }),
    writePolicy: "read-only",
    copilotAllowlisted: true,
    parseArguments: (rawArguments) => validateOptionalLimit(rawArguments, 12),
  },
  {
    name: "review_queue",
    title: "Review Queue",
    description: "Build a compact daily or weekly action queue from placement debt, captures, proposals, note health, and resurfacing.",
    inputSchema: objectSchema({
      mode: {
        type: "string",
        enum: ["daily", "weekly"],
        description: "Review cadence that controls how the queue is framed.",
      },
      limit: limitProperty(MAX_DIAGNOSTIC_LIMIT, 12, "Maximum total review items to consider before grouping."),
    }),
    writePolicy: "read-only",
    copilotAllowlisted: true,
    parseArguments: validateReviewQueueArguments,
  },
  {
    name: "diagnostic_feedback",
    title: "Diagnostic Feedback",
    description: "Record dismiss, snooze, pin, or intentional decisions for diagnostic items without touching vault notes.",
    inputSchema: objectSchema(
      {
        reportType: stringProperty("Diagnostic tool name such as health_report or duplicate_candidates.", { minLength: 1 }),
        itemKey: stringProperty("Stable item key returned by a diagnostic tool.", { minLength: 1 }),
        evidenceHash: stringProperty("Evidence hash returned by a diagnostic tool item.", { minLength: 1 }),
        action: {
          type: "string",
          enum: ["dismiss", "snooze", "pin", "intentional"],
          description: "How the repeated diagnostic should be treated until evidence changes.",
        },
        reason: stringProperty("Short user-facing reason for the decision.", { minLength: 1 }),
        expiresAt: stringProperty("Optional ISO timestamp for snooze expiry."),
      },
      ["reportType", "itemKey", "evidenceHash", "action", "reason"],
    ),
    writePolicy: "read-only",
    copilotAllowlisted: true,
    parseArguments: validateDiagnosticFeedbackArguments,
  },
];
