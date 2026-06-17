import type { StructuredError } from "./types";

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpResourceDefinition {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
}

export interface McpPromptDefinition {
  name: string;
  title: string;
  description: string;
  arguments?: Array<{
    name: string;
    description: string;
    required: boolean;
  }>;
}

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: unknown;
  isError: boolean;
}

export interface SurfaceOptions {
  writeEnabled?: boolean;
}

export type McpParseResult<T> = { ok: true; value: T } | { ok: false; error: StructuredError };

export interface McpToolSpec<TArguments = unknown> {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  writePolicy: "read-only" | "write-enabled";
  copilotAllowlisted: boolean;
  parseArguments: (rawArguments: unknown) => McpParseResult<TArguments>;
}

export type McpToolHandler<TArguments = unknown> = (
  rootDir: string,
  parsedArguments: TArguments,
  options: SurfaceOptions,
) => McpToolResult;

export interface McpToolEntry<TArguments = unknown> extends McpToolSpec<TArguments> {
  handler: McpToolHandler<TArguments>;
}

export type McpResourceReadResult =
  | { ok: true; value: { contents: Array<{ uri: string; mimeType: string; text: string }> } }
  | { ok: false; error: StructuredError };

export type McpPromptResult =
  | { ok: true; value: { description: string; messages: Array<{ role: "user"; content: { type: "text"; text: string } }> } }
  | { ok: false; error: StructuredError };
