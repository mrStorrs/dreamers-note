import crypto from "crypto";
import fs from "fs";
import { compareVaultPaths, fileHash } from "./files";
import { classifyVaultPath } from "./path-safety";
import { fail, sha256 } from "./proposal-common";
import type { ProposalCreateInput, ProposalEnvironment, ProposalTarget } from "./proposal-types";
import type { Result } from "./types";

const LEGACY_BODY_PATCH_KEY = `edit${"Spec"}`;
const UNSAFE_PREVIEW_PATH = "[invalid or excluded target path]";
const UNSAFE_PREVIEW_MESSAGE = "Diff preview unavailable because the stored target path is invalid, excluded, or unsafe to read.";

export function buildProposalTargets(
  environment: ProposalEnvironment,
  rawTargets: ProposalCreateInput["targets"],
): Result<ProposalTarget[]> {
  if (!Array.isArray(rawTargets)) {
    return fail("invalid-arguments", "targets must be an array when provided");
  }
  const targets: ProposalTarget[] = [];
  for (const rawTarget of rawTargets) {
    const target = buildProposalTarget(environment, rawTarget);
    if (!target.ok) {
      return target as Result<ProposalTarget[]>;
    }
    targets.push(target.value);
  }
  return {
    ok: true,
    value: targets.sort((left, right) => compareVaultPaths(left.path, right.path)),
  };
}

export function buildProposalTarget(
  environment: ProposalEnvironment,
  rawTarget: ProposalCreateInput["targets"][number],
): Result<ProposalTarget> {
  const classified = classifyVaultPath({
    vaultPath: environment.vaultPath,
    input: rawTarget.path,
    privateGlobs: environment.privateGlobs,
  });
  if (!classified.ok) {
    return fail(classified.error.code, classified.error.message, { path: classified.error.path });
  }
  const absolutePath = classified.value.absolutePath;
  const beforeHash = fs.existsSync(absolutePath) ? fileHash(absolutePath) : null;
  const mode: ProposalTarget["mode"] = rawTarget.mode === "create" ? "create" : "replace";
  if (mode === "create" && beforeHash) {
    return fail("proposal-target-exists", `target already exists: ${classified.value.normalizedRelativePath}`);
  }
  if (mode === "replace" && !beforeHash) {
    return fail("proposal-target-missing", `target does not exist: ${classified.value.normalizedRelativePath}`);
  }
  if (typeof rawTarget.body !== "string" || rawTarget.body.length === 0) {
    return fail("invalid-arguments", `target body must be a non-empty string for ${classified.value.normalizedRelativePath}`);
  }
  return {
    ok: true,
    value: {
      path: classified.value.normalizedRelativePath,
      mode,
      body: rawTarget.body,
      beforeHash,
      bodyHash: sha256(rawTarget.body),
    },
  };
}

export function hydrateProposalTarget(rawTarget: unknown): ProposalTarget {
  const target = rawTarget && typeof rawTarget === "object" && !Array.isArray(rawTarget)
    ? rawTarget as Record<string, unknown>
    : {};
  const rawPatch = target[LEGACY_BODY_PATCH_KEY];
  const legacyPatch = rawPatch && typeof rawPatch === "object" && !Array.isArray(rawPatch)
    ? rawPatch as Record<string, unknown>
    : undefined;
  const start = typeof legacyPatch?.start === "number" ? legacyPatch.start : undefined;
  const end = typeof legacyPatch?.end === "number" ? legacyPatch.end : undefined;
  const insertText = typeof legacyPatch?.insertText === "string" ? legacyPatch.insertText : undefined;
  return {
    path: typeof target.path === "string" ? target.path : "",
    mode: target.mode === "create" ? "create" : "replace",
    body: typeof target.body === "string" ? target.body : undefined,
    legacyPatch: start !== undefined && end !== undefined && insertText !== undefined
      ? {
          start,
          end,
          insertText,
        }
      : undefined,
    beforeHash: typeof target.beforeHash === "string" ? target.beforeHash : null,
    bodyHash: typeof target.bodyHash === "string" ? target.bodyHash : "",
  };
}

export function materializeTargetBody(target: ProposalTarget, currentText: string): string {
  if (typeof target.body === "string") {
    return target.body;
  }
  if (target.legacyPatch) {
    return `${currentText.slice(0, target.legacyPatch.start)}${target.legacyPatch.insertText}${currentText.slice(target.legacyPatch.end)}`;
  }
  return target.mode === "create" ? "" : currentText;
}

export function buildDiffPreview(
  environment: ProposalEnvironment,
  targets: ProposalTarget[],
): Array<{ path: string; preview: string; truncated: boolean }> {
  return targets.map((target) => {
    const classified = classifyVaultPath({
      vaultPath: environment.vaultPath,
      input: target.path,
      privateGlobs: environment.privateGlobs,
    });
    if (!classified.ok) {
      return {
        path: UNSAFE_PREVIEW_PATH,
        preview: UNSAFE_PREVIEW_MESSAGE,
        truncated: false,
      };
    }
    const currentState = readCurrentForPreview(environment, classified.value.absolutePath);
    if (!currentState.ok) {
      return {
        path: classified.value.normalizedRelativePath,
        preview: UNSAFE_PREVIEW_MESSAGE,
        truncated: false,
      };
    }
    if (target.mode === "replace" && target.beforeHash !== currentState.hash) {
      return {
        path: classified.value.normalizedRelativePath,
        preview: "Diff preview unavailable because the target changed after proposal creation.",
        truncated: false,
      };
    }
    const next = materializeTargetBody(target, currentState.text);
    const preview = simpleDiff(currentState.text, next);
    return {
      path: classified.value.normalizedRelativePath,
      preview: preview.text,
      truncated: preview.truncated,
    };
  });
}

export function safeDiffPreviewPath(environment: ProposalEnvironment, targetPath: string): string {
  const classified = classifyVaultPath({
    vaultPath: environment.vaultPath,
    input: targetPath,
    privateGlobs: environment.privateGlobs,
  });
  return classified.ok ? classified.value.normalizedRelativePath : UNSAFE_PREVIEW_PATH;
}

export function proposalTargetDiffPayload(target: ProposalTarget): Record<string, unknown> {
  return {
    path: target.path,
    mode: target.mode,
    beforeHash: target.beforeHash,
    bodyHash: target.bodyHash,
  };
}

function simpleDiff(current: string, next: string): { text: string; truncated: boolean } {
  const currentLines = current.split(/\r?\n/);
  const nextLines = next.split(/\r?\n/);
  const lines = ["--- current", "+++ proposed"];
  const longest = Math.max(currentLines.length, nextLines.length);
  let emitted = 0;
  for (let index = 0; index < longest; index += 1) {
    const left = currentLines[index] ?? "";
    const right = nextLines[index] ?? "";
    if (left === right) {
      continue;
    }
    lines.push(`- ${left}`);
    lines.push(`+ ${right}`);
    emitted += 2;
    if (emitted >= 16) {
      return {
        text: `${lines.join("\n")}\n...`,
        truncated: true,
      };
    }
  }
  return {
    text: lines.join("\n"),
    truncated: false,
  };
}

function readCurrentForPreview(
  environment: ProposalEnvironment,
  absolutePath: string,
): { ok: true; text: string; hash: string | null } | { ok: false } {
  let fd: number | undefined;
  try {
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(absolutePath, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      return { ok: false };
    }
    const openedPath = realpathForOpenedFile(fd, absolutePath);
    const classified = classifyVaultPath({
      vaultPath: environment.vaultPath,
      input: openedPath,
      privateGlobs: environment.privateGlobs,
    });
    if (!classified.ok) {
      return { ok: false };
    }
    const content = fs.readFileSync(fd);
    return {
      ok: true,
      text: content.toString("utf8"),
      hash: crypto.createHash("sha256").update(content).digest("hex"),
    };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return {
        ok: true,
        text: "",
        hash: null,
      };
    }
    return { ok: false };
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

function realpathForOpenedFile(fd: number, fallbackPath: string): string {
  const procFdPath = `/proc/self/fd/${fd}`;
  if (fs.existsSync(procFdPath)) {
    return fs.realpathSync(procFdPath);
  }
  return fs.realpathSync(fallbackPath);
}
