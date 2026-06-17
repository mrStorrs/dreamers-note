import fs from "fs";
import path from "path";
import { compareVaultPaths, fileHash } from "./files";
import { classifyVaultPath } from "./path-safety";
import { fail, sha256 } from "./proposal-common";
import type { ProposalCreateInput, ProposalEnvironment, ProposalTarget } from "./proposal-types";
import type { Result } from "./types";

const LEGACY_BODY_PATCH_KEY = `edit${"Spec"}`;

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
    const absolutePath = path.join(environment.vaultPath, target.path);
    const current = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, "utf8") : "";
    const currentHash = fs.existsSync(absolutePath) ? fileHash(absolutePath) : null;
    if (target.mode === "replace" && target.beforeHash !== currentHash) {
      return {
        path: target.path,
        preview: "Diff preview unavailable because the target changed after proposal creation.",
        truncated: false,
      };
    }
    const next = materializeTargetBody(target, current);
    const preview = simpleDiff(current, next);
    return {
      path: target.path,
      preview: preview.text,
      truncated: preview.truncated,
    };
  });
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
