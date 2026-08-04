import { callMcpTool } from "./mcp-surface";
import { listMcpToolSpecs } from "./mcp-tool-registry";
import type { McpToolResult, McpToolSpec } from "./mcp-contracts";

export const COPILOT_CLI_TOOL_PREFIX = "dreamers_note_";

export interface CopilotCliToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  writePolicy: McpToolSpec["writePolicy"];
}

/** Native Copilot CLI tools mirror the complete MCP tool registry. */
export function listCopilotCliToolDefinitions(): CopilotCliToolDefinition[] {
  return listMcpToolSpecs()
    .map((spec) => ({
      name: `${COPILOT_CLI_TOOL_PREFIX}${spec.name}`,
      description: `${spec.description} This operates only on the configured local vault; it never directly changes vault files.`,
      parameters: spec.inputSchema,
      writePolicy: spec.writePolicy,
    }));
}

export function callCopilotCliTool(
  rootDir: string,
  extensionToolName: string,
  rawArguments: unknown,
): McpToolResult {
  const toolName = extensionToolName.startsWith(COPILOT_CLI_TOOL_PREFIX)
    ? extensionToolName.slice(COPILOT_CLI_TOOL_PREFIX.length)
    : "";
  const spec = listMcpToolSpecs().find((candidate) => candidate.name === toolName);
  if (!spec) {
    return {
      content: [{ type: "text", text: "Error [unknown-tool]: this Copilot CLI tool is not available." }],
      structuredContent: {
        error: {
          code: "unknown-tool",
          message: "this Copilot CLI tool is not available",
        },
      },
      isError: true,
    };
  }

  // The underlying surface validates each tool's arguments and all vault-path,
  // exclusion, authorization, lock, rollback, and post-write refresh rules.
  // The extension does not set skipPermission, so Copilot CLI keeps its normal
  // approval prompt for every tool invocation, including apply.
  return callMcpTool(rootDir, toolName, rawArguments, { writeEnabled: true });
}

export function formatCopilotCliToolResult(result: McpToolResult): string {
  return JSON.stringify({
    summary: result.content.map((item) => item.text).join("\n"),
    result: result.structuredContent,
    isError: result.isError,
  });
}
