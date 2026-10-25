import path from "path";
import type { ReviewKind } from "./review-service";

export interface CliUsageError {
  code: string;
  message: string;
}

export type CliCommand =
  | { kind: "doctor" }
  | { kind: "index-refresh" }
  | { kind: "context-search"; query: string; limit?: number }
  | { kind: "context-read"; path: string; heading?: string; maxChars?: number }
  | { kind: "context-source"; path: string; offset?: number; maxChars?: number }
  | { kind: "context-related"; path?: string; query?: string; limit?: number }
  | { kind: "review"; reviewKind: ReviewKind; limit?: number }
  | { kind: "change-create"; input: string }
  | { kind: "change-show"; id: string; path?: string; offset?: number; maxChars?: number }
  | { kind: "change-list" }
  | { kind: "change-reject"; id: string }
  | { kind: "change-apply"; id: string; revision: string }
  | {
      kind: "daily-triage";
      paths: string[];
      archiveCheck: boolean;
      cursor?: string;
      limit?: number;
    }
  | { kind: "vault-inventory"; paths: string[]; cursor?: string; limit?: number }
  | { kind: "vault-normalize"; decisionPath: string }
  | { kind: "vault-directory-index"; paths: string[] };

export interface ParsedCliCommand {
  rootDir: string;
  command: CliCommand;
}

export type ParseCliResult =
  | { ok: true; value: ParsedCliCommand }
  | { ok: false; error: CliUsageError };

type OptionValues = Record<string, string | true | undefined>;

interface ParsedOptions {
  options: OptionValues;
  positionals: string[];
}

interface OptionSpec {
  value?: true;
}

const MAX_PAGE_LIMIT = 50;
const MAX_READ_CHARS = 12_000;

export function parseCliArguments(argv: string[], cwd = process.cwd()): ParseCliResult {
  const common = parseCommonArguments(argv, cwd);
  if (!common.ok) {
    return common;
  }
  const args = common.value.args;
  if (args.length === 0) {
    return success(common.value.rootDir, { kind: "doctor" });
  }

  switch (args[0]) {
    case "doctor":
      return noArguments(common.value.rootDir, args.slice(1), { kind: "doctor" });
    case "index":
      return parseIndex(common.value.rootDir, args.slice(1));
    case "context":
      return parseContext(common.value.rootDir, args.slice(1));
    case "review":
      return parseReview(common.value.rootDir, args.slice(1));
    case "change":
      return parseChange(common.value.rootDir, args.slice(1));
    case "daily":
      return parseDaily(common.value.rootDir, args.slice(1));
    case "vault":
      return parseVault(common.value.rootDir, args.slice(1));
    default:
      return usage("cli-unknown-command", "command is not supported");
  }
}

function parseCommonArguments(
  argv: string[],
  cwd: string,
): { ok: true; value: { rootDir: string; args: string[] } } | { ok: false; error: CliUsageError } {
  let rootDir = path.resolve(cwd);
  let rootSeen = false;
  const args: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== "--root") {
      args.push(arg);
      continue;
    }
    if (rootSeen) {
      return usage("cli-option-repeated", "--root may be supplied only once");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      return usage("cli-option-value-required", "--root requires a path value");
    }
    rootSeen = true;
    rootDir = path.resolve(value);
    index += 1;
  }
  return { ok: true, value: { rootDir, args } };
}

function parseIndex(rootDir: string, args: string[]): ParseCliResult {
  if (args[0] !== "refresh") {
    return usage("cli-unknown-command", "index requires the refresh action");
  }
  return noArguments(rootDir, args.slice(1), { kind: "index-refresh" });
}

function parseContext(rootDir: string, args: string[]): ParseCliResult {
  const action = args[0];
  if (!action) {
    return usage("cli-unknown-command", "context requires an action");
  }
  if (action === "search") {
    const parsed = parseOptions(args.slice(1), { "--query": { value: true }, "--limit": { value: true } });
    if (!parsed.ok) return parsed;
    const query = requiredOption(parsed.value, "--query");
    if (!query.ok) return query;
    const limit = optionalBound(parsed.value, "--limit", 1, MAX_PAGE_LIMIT);
    if (!limit.ok) return limit;
    return success(rootDir, { kind: "context-search", query: query.value, limit: limit.value });
  }
  if (action === "read") {
    const parsed = parseOptions(args.slice(1), {
      "--path": { value: true },
      "--heading": { value: true },
      "--max-chars": { value: true },
    });
    if (!parsed.ok) return parsed;
    const selectedPath = requiredOption(parsed.value, "--path");
    if (!selectedPath.ok) return selectedPath;
    const maxChars = optionalBound(parsed.value, "--max-chars", 1, MAX_READ_CHARS);
    if (!maxChars.ok) return maxChars;
    return success(rootDir, {
      kind: "context-read",
      path: selectedPath.value,
      heading: stringOption(parsed.value.options, "--heading"),
      maxChars: maxChars.value,
    });
  }
  if (action === "source") {
    const parsed = parseOptions(args.slice(1), {
      "--path": { value: true },
      "--offset": { value: true },
      "--max-chars": { value: true },
    });
    if (!parsed.ok) return parsed;
    const selectedPath = requiredOption(parsed.value, "--path");
    if (!selectedPath.ok) return selectedPath;
    const offset = optionalBound(parsed.value, "--offset", 0, Number.MAX_SAFE_INTEGER);
    if (!offset.ok) return offset;
    const maxChars = optionalBound(parsed.value, "--max-chars", 1, MAX_READ_CHARS);
    if (!maxChars.ok) return maxChars;
    return success(rootDir, {
      kind: "context-source",
      path: selectedPath.value,
      offset: offset.value,
      maxChars: maxChars.value,
    });
  }
  if (action === "related") {
    const parsed = parseOptions(args.slice(1), {
      "--path": { value: true },
      "--query": { value: true },
      "--limit": { value: true },
    });
    if (!parsed.ok) return parsed;
    const selectedPath = stringOption(parsed.value.options, "--path");
    const query = stringOption(parsed.value.options, "--query");
    if (Boolean(selectedPath) === Boolean(query)) {
      return usage("cli-selector-invalid", "context related requires exactly one selector");
    }
    const limit = optionalBound(parsed.value, "--limit", 1, 30);
    if (!limit.ok) return limit;
    return success(rootDir, { kind: "context-related", path: selectedPath, query, limit: limit.value });
  }
  return usage("cli-unknown-command", "context action is not supported");
}

function parseReview(rootDir: string, args: string[]): ParseCliResult {
  const reviewKind = args[0];
  if (reviewKind !== "graph" && reviewKind !== "health" && reviewKind !== "duplicates") {
    return usage("cli-unknown-command", "review action is not supported");
  }
  const parsed = parseOptions(args.slice(1), { "--limit": { value: true } });
  if (!parsed.ok) return parsed;
  const limit = optionalBound(parsed.value, "--limit", 1, MAX_PAGE_LIMIT);
  if (!limit.ok) return limit;
  return success(rootDir, { kind: "review", reviewKind, limit: limit.value });
}

function parseChange(rootDir: string, args: string[]): ParseCliResult {
  const action = args[0];
  if (action === "create") {
    const parsed = parseOptions(args.slice(1), { "--input": { value: true } });
    if (!parsed.ok) return parsed;
    const input = requiredOption(parsed.value, "--input");
    if (!input.ok) return input;
    return success(rootDir, { kind: "change-create", input: input.value });
  }
  if (action === "show") {
    const parsed = parseOptions(args.slice(1), {
      "--id": { value: true },
      "--path": { value: true },
      "--offset": { value: true },
      "--max-chars": { value: true },
    });
    if (!parsed.ok) return parsed;
    const id = requiredOption(parsed.value, "--id");
    if (!id.ok) return id;
    const offset = optionalBound(parsed.value, "--offset", 0, Number.MAX_SAFE_INTEGER);
    if (!offset.ok) return offset;
    const maxChars = optionalBound(parsed.value, "--max-chars", 1, MAX_READ_CHARS);
    if (!maxChars.ok) return maxChars;
    const selectedPath = stringOption(parsed.value.options, "--path");
    if (!selectedPath && (offset.value !== undefined || maxChars.value !== undefined)) {
      return usage("cli-selector-invalid", "change page bounds require a write path");
    }
    return success(rootDir, {
      kind: "change-show",
      id: id.value,
      path: selectedPath,
      offset: offset.value,
      maxChars: maxChars.value,
    });
  }
  if (action === "list") {
    return noArguments(rootDir, args.slice(1), { kind: "change-list" });
  }
  if (action === "reject") {
    const parsed = parseOptions(args.slice(1), { "--id": { value: true } });
    if (!parsed.ok) return parsed;
    const id = requiredOption(parsed.value, "--id");
    if (!id.ok) return id;
    return success(rootDir, { kind: "change-reject", id: id.value });
  }
  if (action === "apply") {
    const parsed = parseOptions(args.slice(1), {
      "--id": { value: true },
      "--revision": { value: true },
    });
    if (!parsed.ok) return parsed;
    const id = requiredOption(parsed.value, "--id");
    if (!id.ok) return id;
    const revision = requiredOption(parsed.value, "--revision");
    if (!revision.ok) return revision;
    return success(rootDir, { kind: "change-apply", id: id.value, revision: revision.value });
  }
  return usage("cli-unknown-command", "change action is not supported");
}

function parseDaily(rootDir: string, args: string[]): ParseCliResult {
  if (args[0] !== "triage") {
    return usage("cli-unknown-command", "daily requires the triage action");
  }
  const parsed = parseOptions(args.slice(1), {
    "--archive-check": {},
    "--cursor": { value: true },
    "--limit": { value: true },
  }, true);
  if (!parsed.ok) return parsed;
  const limit = optionalBound(parsed.value, "--limit", 1, MAX_PAGE_LIMIT);
  if (!limit.ok) return limit;
  return success(rootDir, {
    kind: "daily-triage",
    paths: parsed.value.positionals,
    archiveCheck: parsed.value.options["--archive-check"] === true,
    cursor: stringOption(parsed.value.options, "--cursor"),
    limit: limit.value,
  });
}

function parseVault(rootDir: string, args: string[]): ParseCliResult {
  const action = args[0];
  if (action === "inventory") {
    const parsed = parseOptions(args.slice(1), {
      "--cursor": { value: true },
      "--limit": { value: true },
    }, true);
    if (!parsed.ok) return parsed;
    if (parsed.value.positionals.length === 0) {
      return usage("cli-positional-required", "vault inventory requires one or more paths");
    }
    const limit = optionalBound(parsed.value, "--limit", 1, MAX_PAGE_LIMIT);
    if (!limit.ok) return limit;
    return success(rootDir, {
      kind: "vault-inventory",
      paths: parsed.value.positionals,
      cursor: stringOption(parsed.value.options, "--cursor"),
      limit: limit.value,
    });
  }
  if (action === "normalize") {
    const parsed = parseOptions(args.slice(1), {}, true);
    if (!parsed.ok) return parsed;
    if (parsed.value.positionals.length !== 1) {
      return usage("cli-positional-required", "vault normalize requires one decision JSONL file");
    }
    return success(rootDir, { kind: "vault-normalize", decisionPath: parsed.value.positionals[0] });
  }
  if (action === "directory-index") {
    const parsed = parseOptions(args.slice(1), {}, true);
    if (!parsed.ok) return parsed;
    return success(rootDir, { kind: "vault-directory-index", paths: parsed.value.positionals });
  }
  return usage("cli-unknown-command", "vault action is not supported");
}

function noArguments(rootDir: string, args: string[], command: CliCommand): ParseCliResult {
  if (args.length === 0) {
    return success(rootDir, command);
  }
  return usage("cli-unexpected-positional", "command does not accept additional arguments");
}

function parseOptions(
  args: string[],
  allowed: Record<string, OptionSpec>,
  allowPositionals = false,
): { ok: true; value: ParsedOptions } | { ok: false; error: CliUsageError } {
  const options: OptionValues = {};
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      if (!allowPositionals) {
        return usage("cli-unexpected-positional", "command received an unexpected positional argument");
      }
      positionals.push(arg);
      continue;
    }
    const spec = allowed[arg];
    if (!spec) {
      return usage("cli-unknown-option", "command received an unsupported option");
    }
    if (options[arg] !== undefined) {
      return usage("cli-option-repeated", "an option may be supplied only once");
    }
    if (!spec.value) {
      options[arg] = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      return usage("cli-option-value-required", "an option requires a value");
    }
    options[arg] = value;
    index += 1;
  }
  return { ok: true, value: { options, positionals } };
}

function requiredOption(options: ParsedOptions, name: string): { ok: true; value: string } | { ok: false; error: CliUsageError } {
  const value = stringOption(options.options, name);
  if (!value) {
    return usage("cli-option-required", "a required option was not supplied");
  }
  return { ok: true, value };
}

function stringOption(options: OptionValues, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

function optionalBound(
  parsed: ParsedOptions,
  name: string,
  minimum: number,
  maximum: number,
): { ok: true; value: number | undefined } | { ok: false; error: CliUsageError } {
  const raw = stringOption(parsed.options, name);
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    return usage("cli-bound-invalid", "a numeric option is outside its supported range");
  }
  return { ok: true, value };
}

function success(rootDir: string, command: CliCommand): ParseCliResult {
  return { ok: true, value: { rootDir, command } };
}

function usage(code: string, message: string): { ok: false; error: CliUsageError } {
  return { ok: false, error: { code, message } };
}
