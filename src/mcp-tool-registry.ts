import type {
  McpToolDefinition,
  McpToolEntry,
  McpToolHandler,
  McpToolSpec,
} from "./mcp-contracts";
import { PROPOSAL_MCP_TOOL_SPECS } from "./mcp-tools-proposal";
import { RETRIEVAL_MCP_TOOL_SPECS } from "./mcp-tools-retrieval";
import { REVIEW_MCP_TOOL_SPECS } from "./mcp-tools-review";
import { RUNTIME_MCP_TOOL_SPECS } from "./mcp-tools-runtime";

export {
  DEFAULT_READ_CHARS,
  DEFAULT_READ_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  MAX_DIAGNOSTIC_LIMIT,
  MAX_READ_CHARS,
  MAX_READ_LIMIT,
  MAX_SEARCH_LIMIT,
  MIN_READ_CHARS,
  PROFILE_VALUES,
  validateContextPackArguments,
  validateDirectoryIndexRefreshArguments,
  validateDiagnosticFeedbackArguments,
  validateGraphContextPackArguments,
  validateNoArguments,
  validateOptionalLimit,
  validateProposalApplyArguments,
  validateProposalAuthorizeArguments,
  validateProposalCreateArguments,
  validateProposalCreateNoteArguments,
  validateProposalReadArguments,
  validateProposalRejectArguments,
  validateReadArguments,
  validateRetrievalFeedbackArguments,
  validateReviewQueueArguments,
  validateSearchArguments,
  validateWorkflowPolicyArguments,
} from "./mcp-tool-arguments";
export type {
  ContextPackArguments,
  DirectoryIndexRefreshArguments,
  DiagnosticFeedbackArguments,
  GraphContextPackArguments,
  NoArguments,
  ProposalApplyArguments,
  ProposalCreateArguments,
  ProposalReadArguments,
  ProposalRejectArguments,
  ReadNoteArguments,
  RetrievalFeedbackArguments,
  ReviewQueueArguments,
  SearchArguments,
} from "./mcp-tool-arguments";

export const MCP_TOOL_SPECS: McpToolSpec[] = [
  ...RUNTIME_MCP_TOOL_SPECS,
  ...withoutTools(RETRIEVAL_MCP_TOOL_SPECS, ["retrieval_feedback"]),
  ...withoutTools(REVIEW_MCP_TOOL_SPECS, ["diagnostic_feedback"]),
  ...onlyTools(RETRIEVAL_MCP_TOOL_SPECS, ["retrieval_feedback"]),
  ...onlyTools(REVIEW_MCP_TOOL_SPECS, ["diagnostic_feedback"]),
  ...PROPOSAL_MCP_TOOL_SPECS,
];

export const MCP_TOOL_NAMES = MCP_TOOL_SPECS.map((tool) => tool.name);
export const COPILOT_MCP_TOOL_NAMES = MCP_TOOL_SPECS
  .filter((tool) => tool.copilotAllowlisted)
  .map((tool) => tool.name);
export const MCP_TOOLS = listMcpToolDefinitions();

export function listMcpToolDefinitions(): McpToolDefinition[] {
  return MCP_TOOL_SPECS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

export function listMcpToolSpecs(): McpToolSpec[] {
  return MCP_TOOL_SPECS.slice();
}

export function findMcpToolSpec(name: string): McpToolSpec | undefined {
  return MCP_TOOL_SPECS.find((tool) => tool.name === name);
}

export function getMcpToolSpec(name: string): McpToolSpec {
  const spec = findMcpToolSpec(name);
  if (!spec) {
    throw new Error(`unknown MCP tool: ${name}`);
  }
  return spec;
}

export function buildMcpToolRegistry(handlers: Record<string, McpToolHandler>): Map<string, McpToolEntry> {
  const entries = new Map<string, McpToolEntry>();
  for (const spec of MCP_TOOL_SPECS) {
    const handler = handlers[spec.name];
    if (!handler) {
      throw new Error(`missing MCP handler for ${spec.name}`);
    }
    entries.set(spec.name, {
      ...spec,
      handler,
    });
  }
  return entries;
}

function onlyTools(specs: McpToolSpec[], names: string[]): McpToolSpec[] {
  const selected = new Set(names);
  return specs.filter((spec) => selected.has(spec.name));
}

function withoutTools(specs: McpToolSpec[], names: string[]): McpToolSpec[] {
  const excluded = new Set(names);
  return specs.filter((spec) => !excluded.has(spec.name));
}
