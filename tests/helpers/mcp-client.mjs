import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { distDir, projectRoot } from "./project-fixtures.mjs";

export function createMcpClient(frameworkRoot, options = {}) {
  const transport = options.transport ?? "framed";
  const args = [path.join(distDir, "cli.js"), "mcp", "--root", frameworkRoot];
  if (options.writeEnabled === true) {
    args.push("--write-enabled");
  }
  const child = spawn("node", args, {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const orphanedMessages = [];
  const messageWaiters = [];
  let nextId = 1;
  let stdoutBuffer = Buffer.alloc(0);
  let stderrText = "";
  let exitCode = null;
  let exitSignal = null;
  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      const error = new Error(`MCP process exited with ${code ?? signal}`);
      for (const request of pending.values()) {
        request.reject(error);
      }
      pending.clear();
      while (messageWaiters.length > 0) {
        messageWaiters.shift().reject(error);
      }
      resolve();
    });
  });

  child.stdout.on("data", (chunk) => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    for (;;) {
      const message = transport === "line" ? readLineMessage() : readFramedMessage();
      if (!message) {
        break;
      }
      const pendingRequest = Object.prototype.hasOwnProperty.call(message, "id")
        ? pending.get(message.id)
        : undefined;
      if (pendingRequest) {
        pending.delete(message.id);
        pendingRequest.resolve(message);
      } else if (messageWaiters.length > 0) {
        messageWaiters.shift().resolve(message);
      } else {
        orphanedMessages.push(message);
      }
    }
  });

  function readFramedMessage() {
    const separator = stdoutBuffer.indexOf("\r\n\r\n");
    if (separator < 0) {
      return undefined;
    }
    const headerText = stdoutBuffer.slice(0, separator).toString("utf8");
    const lengthMatch = /^Content-Length:\s*(\d+)\s*$/im.exec(headerText);
    assert.ok(lengthMatch, `missing content-length header: ${headerText}`);
    const contentLength = Number.parseInt(lengthMatch[1], 10);
    const bodyStart = separator + 4;
    const bodyEnd = bodyStart + contentLength;
    if (stdoutBuffer.length < bodyEnd) {
      return undefined;
    }
    const message = JSON.parse(stdoutBuffer.slice(bodyStart, bodyEnd).toString("utf8"));
    stdoutBuffer = stdoutBuffer.slice(bodyEnd);
    return message;
  }

  function readLineMessage() {
    const newlineIndex = stdoutBuffer.indexOf(0x0a);
    if (newlineIndex < 0) {
      return undefined;
    }
    const line = stdoutBuffer.slice(0, newlineIndex).toString("utf8").trim();
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    if (!line) {
      return undefined;
    }
    return JSON.parse(line);
  }

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrText += chunk;
  });

  child.once("error", (error) => {
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
    while (messageWaiters.length > 0) {
      messageWaiters.shift().reject(error);
    }
  });

  function send(message) {
    const body = JSON.stringify(message);
    sendRawBody(body);
  }

  function sendRawBody(body) {
    if (transport === "line") {
      child.stdin.write(`${body}\n`);
      return;
    }
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }

  async function request(method, params) {
    const id = nextId;
    nextId += 1;
    const response = await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });
    });
    return response;
  }

  function notify(method, params) {
    send({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  async function nextMessage(timeoutMs = 2_000) {
    if (orphanedMessages.length > 0) {
      return orphanedMessages.shift();
    }
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("timed out waiting for unsolicited MCP message"));
      }, timeoutMs);
      messageWaiters.push({
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  async function initialize() {
    const response = await request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: {
        name: options.clientName ?? "dreamers-note-tests",
        version: "0.1.0",
      },
    });
    notify("notifications/initialized");
    return response;
  }

  async function close() {
    child.stdin.end();
    await Promise.race([
      exitPromise,
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (exitCode === null && exitSignal === null) {
      child.kill("SIGTERM");
      await exitPromise;
    }
  }

  return {
    request,
    notify,
    initialize,
    close,
    nextMessage,
    sendRawBody,
    stderr: () => stderrText,
    orphanedMessages: () => orphanedMessages.slice(),
  };
}
