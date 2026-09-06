import type { StructuredError } from "./types";

const MAX_ERROR_MESSAGE_CHARS = 280;

export function writeCliSuccess(command: string, data: unknown): void {
  process.stdout.write(`${JSON.stringify({ ok: true, command, data })}\n`);
}

export function writeCliFailure(error: Pick<StructuredError, "code" | "message">): void {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: {
      code: stableText(error.code, "cli-failed"),
      message: stableText(error.message, "command could not be completed"),
    },
  })}\n`);
}

export function commandFailure(code = "cli-failed", message = "command could not be completed"): StructuredError {
  return {
    code: stableText(code, "cli-failed"),
    message: stableText(message, "command could not be completed"),
  };
}

function stableText(value: string | undefined, fallback: string): string {
  const normalized = typeof value === "string"
    ? value.replace(/[\r\n\t]+/g, " ").trim()
    : "";
  if (!normalized) {
    return fallback;
  }
  return normalized.slice(0, MAX_ERROR_MESSAGE_CHARS);
}
