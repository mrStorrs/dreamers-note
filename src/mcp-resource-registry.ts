import type { McpResourceDefinition } from "./mcp-contracts";
import { listWorkflowPolicyResourceDefinitions } from "./mcp-workflow-policy";

export const MCP_RESOURCES: McpResourceDefinition[] = [
  {
    uri: "dreamers-note://approved-tags",
    name: "approved-tags",
    title: "Approved Tags",
    description: "Approved topical tags for vault proposals and review.",
    mimeType: "text/markdown",
  },
  {
    uri: "dreamers-note://conventions",
    name: "conventions",
    title: "Vault Conventions",
    description: "Placement and note-shape conventions for the local Obsidian vault.",
    mimeType: "text/markdown",
  },
  {
    uri: "dreamers-note://guidance/codex",
    name: "codex-guidance",
    title: "Codex Guidance",
    description: "Project-local guidance for Codex when using the notes MCP server.",
    mimeType: "text/markdown",
  },
  ...listWorkflowPolicyResourceDefinitions(),
  {
    uri: "dreamers-note://runtime/index-status",
    name: "index-status",
    title: "Index Status",
    description: "Current runtime index health, freshness, and counts.",
    mimeType: "text/markdown",
  },
  {
    uri: "dreamers-note://runtime/recent-reports",
    name: "recent-reports",
    title: "Recent Runtime Reports",
    description: "Recent index operations, warnings, and tombstones from runtime state.",
    mimeType: "text/markdown",
  },
];

export const MCP_RESOURCE_URIS = MCP_RESOURCES.map((resource) => resource.uri);

export function listMcpResourceDefinitions(): McpResourceDefinition[] {
  return MCP_RESOURCES.slice();
}

export function getMcpResourceDefinition(uri: string): McpResourceDefinition {
  const definition = MCP_RESOURCES.find((resource) => resource.uri === uri);
  if (!definition) {
    throw new Error(`unknown MCP resource: ${uri}`);
  }
  return definition;
}

export function findMcpResourceDefinition(uri: string): McpResourceDefinition | undefined {
  return MCP_RESOURCES.find((resource) => resource.uri === uri);
}
