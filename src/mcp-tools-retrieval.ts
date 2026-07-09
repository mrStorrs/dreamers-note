import type { McpToolSpec } from "./mcp-contracts";
import {
  DEFAULT_READ_CHARS,
  DEFAULT_READ_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  MAX_READ_CHARS,
  MAX_READ_LIMIT,
  MAX_SEARCH_LIMIT,
  MIN_READ_CHARS,
  PROFILE_VALUES,
  validateContextPackArguments,
  validateReadArguments,
  validateRetrievalFeedbackArguments,
  validateSearchArguments,
  validateWorkflowPolicyArguments,
} from "./mcp-tool-arguments";
import {
  integerProperty,
  limitProperty,
  objectSchema,
  stringArrayProperty,
  stringProperty,
} from "./mcp-tool-schema";
import { WORKFLOW_POLICY_IDS } from "./mcp-workflow-policy";

export const RETRIEVAL_MCP_TOOL_SPECS: McpToolSpec[] = [
  {
    name: "search_hybrid",
    title: "Search Hybrid",
    description: "Run deterministic lexical search over the local vault index and return bounded cited evidence.",
    inputSchema: objectSchema(
      {
        query: stringProperty("User query to search across indexed notes and assets.", { minLength: 1 }),
        limit: limitProperty(MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT, "Maximum number of ranked results to return."),
      },
      ["query"],
    ),
    writePolicy: "read-only",
    copilotAllowlisted: true,
    parseArguments: validateSearchArguments,
  },
  {
    name: "read_note",
    title: "Read Note",
    description: "Read bounded note excerpts by vault-relative path, heading, or chunk identifier.",
    inputSchema: objectSchema({
      path: stringProperty("Vault-relative Markdown note path."),
      heading: stringProperty("Heading text or full heading path within the note."),
      chunkId: stringProperty("Indexed chunk identifier returned by search results."),
      maxChars: integerProperty(MIN_READ_CHARS, MAX_READ_CHARS, DEFAULT_READ_CHARS, "Maximum characters per excerpt."),
      limit: limitProperty(MAX_READ_LIMIT, DEFAULT_READ_LIMIT, "Maximum excerpts to return when reading by path or heading."),
    }),
    writePolicy: "read-only",
    copilotAllowlisted: true,
    parseArguments: validateReadArguments,
  },
  {
    name: "workflow_policy",
    title: "Workflow Policy",
    description: "Return structured workflow policy for add, capture, import, triage, or shared placement and tagging rules.",
    inputSchema: objectSchema(
      {
        workflow: {
          type: "string",
          enum: [...WORKFLOW_POLICY_IDS],
          description: "Workflow policy document to return.",
        },
      },
      ["workflow"],
    ),
    writePolicy: "read-only",
    copilotAllowlisted: true,
    parseArguments: validateWorkflowPolicyArguments,
  },
  {
    name: "context_pack",
    title: "Context Pack",
    description: "Build a task-profiled pack of cited evidence, gaps, and candidate next actions for Codex workflows.",
    inputSchema: objectSchema(
      {
        query: stringProperty("Task or question to ground in indexed vault evidence.", { minLength: 1 }),
        profile: {
          type: "string",
          enum: [...PROFILE_VALUES],
          description: "Workflow profile for how the evidence should be shaped.",
        },
        limit: limitProperty(MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT, "Maximum evidence items to include."),
      },
      ["query", "profile"],
    ),
    writePolicy: "read-only",
    copilotAllowlisted: true,
    parseArguments: validateContextPackArguments,
  },
  {
    name: "retrieval_feedback",
    title: "Retrieval Feedback",
    description: "Record lightweight retrieval feedback in runtime state without storing note bodies.",
    inputSchema: objectSchema(
      {
        query: stringProperty("Original retrieval query or workflow question.", { minLength: 1 }),
        selectedPaths: stringArrayProperty("Vault-relative paths the user accepted or corrected to."),
        rejectedPaths: stringArrayProperty("Vault-relative paths the user rejected."),
        reasonCodes: stringArrayProperty("Short workflow reason codes such as accepted, corrected, or stale."),
        proposalId: stringProperty("Optional proposal identifier related to the retrieval workflow."),
      },
      ["query"],
    ),
    writePolicy: "read-only",
    copilotAllowlisted: true,
    parseArguments: validateRetrievalFeedbackArguments,
  },
];
