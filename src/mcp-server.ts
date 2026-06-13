import readline from "readline";
import {
  callMcpTool,
  getMcpPrompt,
  MCP_PROMPTS,
  MCP_RESOURCES,
  MCP_SERVER_INSTRUCTIONS,
  MCP_TOOLS,
  readMcpResource,
} from "./mcp-surface";

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18"] as const;
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const JSONRPC_VERSION = "2.0";
const NOT_INITIALIZED_ERROR = -32002;

interface ServerState {
  rootDir: string;
  ready: boolean;
  initializeSeen: boolean;
  protocolVersion: string;
}

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export function startMcpServer(options: {
  rootDir: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}): void {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const state: ServerState = {
    rootDir: options.rootDir,
    ready: false,
    initializeSeen: false,
    protocolVersion: LATEST_PROTOCOL_VERSION,
  };

  const lines = readline.createInterface({
    input: stdin,
    crlfDelay: Infinity,
  });

  lines.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      writeError(stdout, null, -32700, "Parse error", { code: "malformed-json" });
      log(stderr, "warn", "malformed-json");
      return;
    }

    if (!isRequest(parsed)) {
      writeError(stdout, null, -32600, "Invalid Request");
      return;
    }

    handleRequest(state, parsed, stdout, stderr);
  });
}

function handleRequest(
  state: ServerState,
  request: JsonRpcRequest,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): void {
  if (request.method === "notifications/initialized") {
    if (state.initializeSeen) {
      state.ready = true;
    }
    return;
  }

  if (request.method === "notifications/cancelled") {
    return;
  }

  if (request.method === "initialize") {
    const requestedVersion = readRequestedProtocolVersion(request.params);
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion as typeof SUPPORTED_PROTOCOL_VERSIONS[number])
      ? requestedVersion
      : LATEST_PROTOCOL_VERSION;
    state.initializeSeen = true;
    state.protocolVersion = protocolVersion;
    writeResult(stdout, request.id, {
      protocolVersion,
      capabilities: {
        prompts: {},
        resources: {},
        tools: {},
      },
      serverInfo: {
        name: "dreamers-note",
        title: "Dreamers Note MCP",
        version: "0.1.0",
        description: "Local read-only vault retrieval and context-pack server for dreamers-note.",
      },
      instructions: MCP_SERVER_INSTRUCTIONS,
    });
    return;
  }

  if (request.method === "ping") {
    writeResult(stdout, request.id, {});
    return;
  }

  if (!state.ready) {
    writeError(stdout, request.id ?? null, NOT_INITIALIZED_ERROR, "Server not initialized");
    return;
  }

  switch (request.method) {
    case "tools/list":
      writeResult(stdout, request.id, {
        tools: MCP_TOOLS,
      });
      return;
    case "tools/call":
      handleToolCall(state, request, stdout);
      return;
    case "resources/list":
      writeResult(stdout, request.id, {
        resources: MCP_RESOURCES,
      });
      return;
    case "resources/read":
      handleResourceRead(state, request, stdout);
      return;
    case "resources/templates/list":
      writeResult(stdout, request.id, {
        resourceTemplates: [],
      });
      return;
    case "prompts/list":
      writeResult(stdout, request.id, {
        prompts: MCP_PROMPTS,
      });
      return;
    case "prompts/get":
      handlePromptGet(state, request, stdout);
      return;
    default:
      log(stderr, "warn", `unknown-method:${request.method}`);
      writeError(stdout, request.id ?? null, -32601, `Method not found: ${request.method}`);
  }
}

function handleToolCall(state: ServerState, request: JsonRpcRequest, stdout: NodeJS.WritableStream): void {
  const params = objectValue(request.params);
  if (!params || typeof params.name !== "string") {
    writeError(stdout, request.id ?? null, -32602, "Invalid params");
    return;
  }
  const result = callMcpTool(state.rootDir, params.name, params.arguments);
  writeResult(stdout, request.id, result);
}

function handleResourceRead(state: ServerState, request: JsonRpcRequest, stdout: NodeJS.WritableStream): void {
  const params = objectValue(request.params);
  if (!params || typeof params.uri !== "string") {
    writeError(stdout, request.id ?? null, -32602, "Invalid params");
    return;
  }
  const result = readMcpResource(state.rootDir, params.uri);
  if (!result.ok) {
    writeError(stdout, request.id ?? null, -32602, result.error.message, result.error);
    return;
  }
  writeResult(stdout, request.id, result.value);
}

function handlePromptGet(state: ServerState, request: JsonRpcRequest, stdout: NodeJS.WritableStream): void {
  const params = objectValue(request.params);
  if (!params || typeof params.name !== "string") {
    writeError(stdout, request.id ?? null, -32602, "Invalid params");
    return;
  }
  const result = getMcpPrompt(state.rootDir, params.name);
  if (!result.ok) {
    writeError(stdout, request.id ?? null, -32602, result.error.message, result.error);
    return;
  }
  writeResult(stdout, request.id, result.value);
}

function readRequestedProtocolVersion(params: unknown): string {
  const value = objectValue(params)?.protocolVersion;
  return typeof value === "string" ? value : LATEST_PROTOCOL_VERSION;
}

function isRequest(value: unknown): value is JsonRpcRequest {
  const object = objectValue(value);
  return Boolean(object && object.jsonrpc === JSONRPC_VERSION && typeof object.method === "string");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function writeResult(stdout: NodeJS.WritableStream, id: JsonRpcRequest["id"], result: unknown): void {
  writeMessage(stdout, {
    jsonrpc: JSONRPC_VERSION,
    id: id ?? null,
    result,
  });
}

function writeError(
  stdout: NodeJS.WritableStream,
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  data?: unknown,
): void {
  writeMessage(stdout, {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  });
}

function writeMessage(stdout: NodeJS.WritableStream, message: unknown): void {
  stdout.write(`${JSON.stringify(message)}\n`);
}

function log(stderr: NodeJS.WritableStream, level: "warn" | "info", code: string): void {
  stderr.write(`${JSON.stringify({ level, code })}\n`);
}
