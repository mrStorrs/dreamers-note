import type { McpToolSpec } from "./mcp-contracts";
import { validateNoArguments } from "./mcp-tool-arguments";
import { objectSchema } from "./mcp-tool-schema";

export const RUNTIME_MCP_TOOL_SPECS: McpToolSpec[] = [
  {
    name: "server_status",
    title: "Server Status",
    description: "Report local vault, runtime, and index freshness state for the notes MCP server.",
    inputSchema: objectSchema(),
    writePolicy: "read-only",
    copilotAllowlisted: true,
    parseArguments: validateNoArguments,
  },
  {
    name: "workflow_ready",
    title: "Workflow Ready",
    description: "Initialize runtime state if needed, refresh the local index, and return a compact workflow-readiness report.",
    inputSchema: objectSchema(),
    writePolicy: "read-only",
    copilotAllowlisted: true,
    parseArguments: validateNoArguments,
  },
  {
    name: "index_refresh",
    title: "Index Refresh",
    description: "Refresh the local runtime index from vault files without mutating vault content.",
    inputSchema: objectSchema(),
    writePolicy: "read-only",
    copilotAllowlisted: true,
    parseArguments: validateNoArguments,
  },
];
