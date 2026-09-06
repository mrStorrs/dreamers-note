#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { applyChange, createChange, listChanges, rejectChange, showChange } from "./change-service";
import { parseCliArguments, type CliCommand } from "./cli-arguments";
import { commandFailure, writeCliFailure, writeCliSuccess } from "./cli-output";
import { inspectContextSource, readContext, relatedContext, searchContext } from "./context-service";
import { planDailyTriage } from "./daily-triage";
import { planDirectoryIndexChange, runDirectoryIndexMigration } from "./directory-index-migration";
import { startMcpServer } from "./mcp-server";
import { reviewContext } from "./review-service";
import { ensureRuntimeReady, inspectRuntimeReadiness } from "./runtime-readiness";
import type { Result, StructuredError } from "./types";
import { loadVaultEnvironment } from "./vault-environment";
import { planVaultInventory } from "./vault-inventory";
import { planVaultNormalization } from "./vault-normalization";
import type { ChangeCreateInput } from "./change-contracts";

const MAX_INPUT_BYTES = 2_000_000;
const MAX_JSONL_RECORDS = 1_000;

interface PreparedCommandInput {
  changeCreate?: Record<string, unknown>;
  normalizationDecisions?: unknown[];
}

type InputPreflight =
  | { ok: true; value: PreparedCommandInput }
  | { ok: false; error: StructuredError; exitCode: 1 | 2 };

export function main(argv = process.argv.slice(2)): number {
  if (argv[0] === "mcp") {
    return startLegacyMcp(argv.slice(1));
  }
  if (argv[0] === "migrate-directory-indexes") {
    return runDirectoryIndexMigration(argv.slice(1), process.cwd());
  }
  const parsed = parseCliArguments(argv);
  if (!parsed.ok) {
    writeCliFailure(parsed.error);
    return 2;
  }
  const preflight = prepareCommandInput(parsed.value.command);
  if (!preflight.ok) {
    writeCliFailure(preflight.error);
    return preflight.exitCode;
  }
  try {
    return dispatch(parsed.value.rootDir, parsed.value.command, preflight.value);
  } catch {
    writeCliFailure(commandFailure());
    return 1;
  }
}

function dispatch(rootDir: string, command: CliCommand, input: PreparedCommandInput): number {
  const environment = loadVaultEnvironment({ rootDir });
  if (!environment.ok) {
    writeCliFailure(environment.error);
    return 1;
  }
  switch (command.kind) {
    case "doctor":
      return emit("doctor", doctorResult(environment.value));
    case "index-refresh":
      return emit("index refresh", forceIndexRefresh(environment.value));
    case "context-search":
      return emit("context search", searchContext(environment.value, { query: command.query, limit: command.limit }));
    case "context-read":
      return emit("context read", readContext(environment.value, {
        path: command.path,
        heading: command.heading,
        maxChars: command.maxChars,
      }));
    case "context-source":
      return emit("context source", inspectContextSource(environment.value, {
        path: command.path,
        offset: command.offset,
        maxChars: command.maxChars,
      }));
    case "context-related":
      return emit("context related", relatedContext(environment.value, {
        path: command.path,
        query: command.query,
        limit: command.limit,
      }));
    case "review":
      return emit(`review ${command.reviewKind}`, reviewContext(environment.value, {
        kind: command.reviewKind,
        limit: command.limit,
      }));
    case "change-create":
      return input.changeCreate === undefined
        ? emit("change create", fail("cli-failed", "change input preflight was unavailable"))
        : emit("change create", createChange(environment.value, input.changeCreate as unknown as ChangeCreateInput));
    case "change-show":
      return emit("change show", showChange(environment.value, command.id, {
        path: command.path,
        offset: command.offset,
        maxChars: command.maxChars,
      }));
    case "change-list":
      return emit("change list", listChanges(environment.value));
    case "change-reject":
      return emit("change reject", rejectChange(environment.value, command.id));
    case "change-apply":
      return emit("change apply", applyChange(environment.value, { id: command.id, revision: command.revision }));
    case "daily-triage":
      return emit("daily triage", planDailyTriage(environment.value, {
        paths: command.paths,
        archiveCheck: command.archiveCheck,
        cursor: command.cursor,
        limit: command.limit,
      }));
    case "vault-inventory":
      return emit("vault inventory", planVaultInventory(environment.value, {
        paths: command.paths,
        cursor: command.cursor,
        limit: command.limit,
      }));
    case "vault-normalize":
      return input.normalizationDecisions === undefined
        ? emit("vault normalize", fail("cli-failed", "normalization input preflight was unavailable"))
        : emit("vault normalize", planVaultNormalization(environment.value, input.normalizationDecisions));
    case "vault-directory-index":
      return emit("vault directory-index", planDirectoryIndexChange(environment.value, { paths: command.paths }));
  }
}

function prepareCommandInput(command: CliCommand): InputPreflight {
  if (command.kind === "change-create") {
    const parsed = readJsonInput(command.input);
    return !parsed.ok
      ? inputPreflightFailure(parsed.error)
      : { ok: true, value: { changeCreate: parsed.value } };
  }
  if (command.kind === "vault-normalize") {
    const parsed = readJsonLines(command.decisionPath);
    return !parsed.ok
      ? inputPreflightFailure(parsed.error)
      : { ok: true, value: { normalizationDecisions: parsed.value } };
  }
  return { ok: true, value: {} };
}

function inputPreflightFailure(error: StructuredError): InputPreflight {
  return {
    ok: false,
    error,
    exitCode: error.code === "cli-input-unreadable" ? 1 : 2,
  };
}

function doctorResult(environment: Parameters<typeof inspectRuntimeReadiness>[0]): Result<unknown> {
  const readiness = inspectRuntimeReadiness(environment);
  if (!readiness.ok) {
    return readiness;
  }
  return {
    ok: true,
    value: {
      runtime: {
        state: readiness.value.state,
        cacheManaged: true,
      },
      capabilities: {
        jsonCli: true,
        changeLifecycle: true,
      },
    },
  };
}

function forceIndexRefresh(environment: Parameters<typeof ensureRuntimeReady>[0]): Result<unknown> {
  const ready = ensureRuntimeReady(environment);
  if (!ready.ok) {
    return ready;
  }
  return {
    ok: true,
    value: {
      readiness: ready.value,
    },
  };
}

function emit(command: string, result: Result<unknown>): number {
  if (!result.ok) {
    writeCliFailure(result.error);
    return 1;
  }
  writeCliSuccess(command, result.value);
  return 0;
}

function readJsonInput(input: string): Result<Record<string, unknown>> {
  const raw = readBoundedInput(input);
  if (!raw.ok) return raw as Result<Record<string, unknown>>;
  try {
    const value = JSON.parse(raw.value);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return fail("cli-input-invalid", "change input must be a JSON object");
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return fail("cli-input-invalid", "change input is not valid JSON");
  }
}

function readJsonLines(inputPath: string): Result<unknown[]> {
  const raw = readBoundedInput(inputPath);
  if (!raw.ok) return raw as Result<unknown[]>;
  const records: unknown[] = [];
  for (const line of raw.value.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (records.length >= MAX_JSONL_RECORDS) {
      return fail("cli-input-too-large", "decision JSONL contains too many records");
    }
    try {
      const record = JSON.parse(line);
      if (typeof record !== "object" || record === null || Array.isArray(record)) {
        return fail("cli-input-invalid", "decision JSONL records must be objects");
      }
      records.push(record);
    } catch {
      return fail("cli-input-invalid", "decision JSONL is not valid JSON");
    }
  }
  return { ok: true, value: records };
}

function readBoundedInput(input: string): Result<string> {
  let fd: number | undefined;
  let shouldClose = false;
  const fileInput = input !== "-";
  try {
    if (!fileInput) {
      fd = 0;
    } else {
      const absolutePath = path.resolve(input);
      const initial = fs.lstatSync(absolutePath);
      if (!initial.isFile() || initial.isSymbolicLink()) {
        return fail("cli-input-invalid", "input file must be a regular non-symlink file");
      }
      const noFollow = noFollowFlag();
      if (noFollow === undefined) {
        return fail("cli-input-unreadable", "input file could not be read safely");
      }
      fd = fs.openSync(absolutePath, fs.constants.O_RDONLY | noFollow);
      shouldClose = true;
      const pinned = fs.fstatSync(fd);
      if (!pinned.isFile() || pinned.dev !== initial.dev || pinned.ino !== initial.ino) {
        return fail("cli-input-invalid", "input file must be a regular non-symlink file");
      }
      if (pinned.size > MAX_INPUT_BYTES) {
        return fail("cli-input-too-large", "input exceeds the supported size");
      }
    }
    return { ok: true, value: readBoundedDescriptor(fd) };
  } catch (error) {
    return error instanceof InputTooLargeError
      ? fail("cli-input-too-large", "input exceeds the supported size")
      : fail("cli-input-unreadable", fileInput ? "input file could not be read" : "input could not be read");
  } finally {
    if (shouldClose && fd !== undefined) fs.closeSync(fd);
  }
}

function readBoundedDescriptor(fd: number | undefined): string {
  if (fd === undefined) {
    throw new Error("input descriptor was not opened");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const remaining = MAX_INPUT_BYTES + 1 - total;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
    if (bytesRead === 0) {
      return Buffer.concat(chunks, total).toString("utf8");
    }
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
    if (total > MAX_INPUT_BYTES) {
      throw new InputTooLargeError();
    }
  }
}

class InputTooLargeError extends Error {
  constructor() {
    super("input exceeds the supported size");
  }
}

function noFollowFlag(): number | undefined {
  return typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : undefined;
}

function startLegacyMcp(argv: string[]): number {
  let rootDir = process.cwd();
  let writeEnabled = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        process.stderr.write("--root requires a path\n");
        return 2;
      }
      rootDir = path.resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--write-enabled") {
      writeEnabled = true;
      continue;
    }
    process.stderr.write("unknown MCP option\n");
    return 2;
  }
  startMcpServer({ rootDir, writeEnabled });
  return 0;
}

function fail<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message } };
}

if (require.main === module) {
  process.exitCode = main();
}
