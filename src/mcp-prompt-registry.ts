import type { McpPromptDefinition } from "./mcp-contracts";
import { listWorkflowPromptDefinitions } from "./mcp-workflow-policy";

export const MCP_PROMPTS: McpPromptDefinition[] = listWorkflowPromptDefinitions();

export const MCP_PROMPT_NAMES = MCP_PROMPTS.map((prompt) => prompt.name);

export function listMcpPromptDefinitions(): McpPromptDefinition[] {
  return MCP_PROMPTS.slice();
}

export function getMcpPromptDefinition(name: string): McpPromptDefinition {
  const definition = MCP_PROMPTS.find((prompt) => prompt.name === name);
  if (!definition) {
    throw new Error(`unknown MCP prompt: ${name}`);
  }
  return definition;
}

export function findMcpPromptDefinition(name: string): McpPromptDefinition | undefined {
  return MCP_PROMPTS.find((prompt) => prompt.name === name);
}
