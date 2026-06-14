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
  protocolVersion: string;
  writeEnabled: boolean;
  transport: "unknown" | "framed" | "line";
}

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface HeaderTerminator {
  index: number;
  length: number;
}

export function startMcpServer(options: {
  rootDir: string;
  writeEnabled?: boolean;
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
    protocolVersion: LATEST_PROTOCOL_VERSION,
    writeEnabled: options.writeEnabled === true,
    transport: "unknown",
  };

  let buffer = Buffer.alloc(0);

  stdin.on("data", (chunk) => {
    const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = Buffer.concat([buffer, nextChunk]);
    buffer = consumeFrames(state, buffer, stdout, stderr);
  });
}

function consumeFrames(
  state: ServerState,
  initialBuffer: Buffer,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Buffer {
  let buffer = initialBuffer;

  while (buffer.length > 0) {
    if (state.transport === "unknown") {
      const detected = detectTransport(buffer);
      if (!detected) {
        return buffer;
      }
      state.transport = detected;
    }

    if (state.transport === "line") {
      const newlineIndex = buffer.indexOf(0x0a);
      if (newlineIndex < 0) {
        return buffer;
      }
      const line = buffer.slice(0, newlineIndex).toString("utf8").trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      handleIncomingBody(state, line, stdout, stderr);
      continue;
    }

    const terminator = findHeaderTerminator(buffer);
    if (!terminator) {
      return buffer;
    }

    const headerText = buffer.slice(0, terminator.index).toString("utf8");
    const contentLength = readContentLength(headerText);
    if (contentLength === undefined) {
      writeError(state, stdout, null, -32700, "Parse error", { code: "malformed-frame" });
      log(stderr, "warn", "malformed-frame");
      buffer = buffer.slice(terminator.index + terminator.length);
      continue;
    }

    const bodyStart = terminator.index + terminator.length;
    const bodyEnd = bodyStart + contentLength;
    if (buffer.length < bodyEnd) {
      return buffer;
    }

    const bodyText = buffer.slice(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.slice(bodyEnd);
    handleIncomingBody(state, bodyText, stdout, stderr);
  }

  return buffer;
}

function handleIncomingBody(
  state: ServerState,
  bodyText: string,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    writeError(state, stdout, null, -32700, "Parse error", { code: "malformed-json" });
    log(stderr, "warn", "malformed-json");
    return;
  }

  if (!isRequest(parsed)) {
    writeError(state, stdout, null, -32600, "Invalid Request");
    return;
  }

  handleRequest(state, parsed, stdout, stderr);
}

function handleRequest(
  state: ServerState,
  request: JsonRpcRequest,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): void {
  if (request.method === "notifications/initialized") {
    state.ready = true;
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
    state.protocolVersion = protocolVersion;
    state.ready = true;
    writeResult(state, stdout, request.id, {
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
    writeResult(state, stdout, request.id, {});
    return;
  }

  if (!state.ready) {
    writeError(state, stdout, request.id ?? null, NOT_INITIALIZED_ERROR, "Server not initialized");
    return;
  }

  switch (request.method) {
    case "tools/list":
      writeResult(state, stdout, request.id, {
        tools: MCP_TOOLS,
      });
      return;
    case "tools/call":
      handleToolCall(state, request, stdout);
      return;
    case "resources/list":
      writeResult(state, stdout, request.id, {
        resources: MCP_RESOURCES,
      });
      return;
    case "resources/read":
      handleResourceRead(state, request, stdout);
      return;
    case "resources/templates/list":
      writeResult(state, stdout, request.id, {
        resourceTemplates: [],
      });
      return;
    case "prompts/list":
      writeResult(state, stdout, request.id, {
        prompts: MCP_PROMPTS,
      });
      return;
    case "prompts/get":
      handlePromptGet(state, request, stdout);
      return;
    default:
      log(stderr, "warn", `unknown-method:${request.method}`);
      writeError(state, stdout, request.id ?? null, -32601, `Method not found: ${request.method}`);
  }
}

function handleToolCall(state: ServerState, request: JsonRpcRequest, stdout: NodeJS.WritableStream): void {
  const params = objectValue(request.params);
  if (!params || typeof params.name !== "string") {
    writeError(state, stdout, request.id ?? null, -32602, "Invalid params");
    return;
  }
  const result = callMcpTool(state.rootDir, params.name, params.arguments, {
    writeEnabled: state.writeEnabled,
  });
  writeResult(state, stdout, request.id, result);
}

function handleResourceRead(state: ServerState, request: JsonRpcRequest, stdout: NodeJS.WritableStream): void {
  const params = objectValue(request.params);
  if (!params || typeof params.uri !== "string") {
    writeError(state, stdout, request.id ?? null, -32602, "Invalid params");
    return;
  }
  const result = readMcpResource(state.rootDir, params.uri);
  if (!result.ok) {
    writeError(state, stdout, request.id ?? null, -32602, result.error.message, result.error);
    return;
  }
  writeResult(state, stdout, request.id, result.value);
}

function handlePromptGet(state: ServerState, request: JsonRpcRequest, stdout: NodeJS.WritableStream): void {
  const params = objectValue(request.params);
  if (!params || typeof params.name !== "string") {
    writeError(state, stdout, request.id ?? null, -32602, "Invalid params");
    return;
  }
  const result = getMcpPrompt(state.rootDir, params.name);
  if (!result.ok) {
    writeError(state, stdout, request.id ?? null, -32602, result.error.message, result.error);
    return;
  }
  writeResult(state, stdout, request.id, result.value);
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

function writeResult(
  state: ServerState,
  stdout: NodeJS.WritableStream,
  id: JsonRpcRequest["id"],
  result: unknown,
): void {
  writeMessage(state, stdout, {
    jsonrpc: JSONRPC_VERSION,
    id: id ?? null,
    result,
  });
}

function writeError(
  state: ServerState,
  stdout: NodeJS.WritableStream,
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  data?: unknown,
): void {
  writeMessage(state, stdout, {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  });
}

function writeMessage(state: ServerState, stdout: NodeJS.WritableStream, message: unknown): void {
  const body = JSON.stringify(message);
  if (state.transport === "line") {
    stdout.write(`${body}\n`);
    return;
  }
  const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
  stdout.write(header);
  stdout.write(body);
}

function detectTransport(buffer: Buffer): "line" | "framed" | undefined {
  let index = 0;
  while (index < buffer.length) {
    const byte = buffer[index];
    if (byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a) {
      index += 1;
      continue;
    }
    if (byte === 0x7b || byte === 0x5b) {
      return "line";
    }
    const preview = buffer.slice(index, Math.min(buffer.length, index + 14)).toString("utf8");
    if (/^Content-Length/i.test(preview)) {
      return "framed";
    }
    return undefined;
  }
  return undefined;
}

function findHeaderTerminator(buffer: Buffer): HeaderTerminator | undefined {
  const crlfIndex = buffer.indexOf("\r\n\r\n");
  if (crlfIndex >= 0) {
    return { index: crlfIndex, length: 4 };
  }
  const lfIndex = buffer.indexOf("\n\n");
  if (lfIndex >= 0) {
    return { index: lfIndex, length: 2 };
  }
  return undefined;
}

function readContentLength(headers: string): number | undefined {
  const lines = headers.split(/\r?\n/);
  for (const line of lines) {
    const match = /^Content-Length:\s*(\d+)\s*$/i.exec(line);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }
  return undefined;
}

function log(stderr: NodeJS.WritableStream, level: "warn" | "info", code: string): void {
  stderr.write(`${JSON.stringify({ level, code })}\n`);
}
