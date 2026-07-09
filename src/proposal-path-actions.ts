import fs from "fs";
import path from "path";
import { compareVaultPaths, fileHash } from "./files";
import { inspectImportSource } from "./import-source";
import { classifyVaultPath } from "./path-safety";
import { fail, nonEmptyString } from "./proposal-common";
import type {
  ProposalCreateInput,
  ProposalEnvironment,
  ProposalPathAction,
  StoredProposal,
} from "./proposal-types";
import type { Result } from "./types";

export function normalizePathActions(
  environment: ProposalEnvironment,
  rawActions: ProposalCreateInput["pathActions"] = [],
): Result<ProposalPathAction[]> {
  if (!Array.isArray(rawActions)) {
    return fail("invalid-arguments", "pathActions must be an array when provided");
  }
  const actions: ProposalPathAction[] = [];
  for (const rawAction of rawActions) {
    if (!rawAction || typeof rawAction !== "object" || Array.isArray(rawAction)) {
      return fail("invalid-arguments", "pathActions entries must be objects");
    }
    const actionType = rawAction.type === "move" ? "move" : rawAction.type === "delete-file" ? "delete-file" : undefined;
    if (!actionType) {
      return fail("invalid-arguments", "pathActions.type must be move or delete-file");
    }
    const scope = rawAction.scope === "external" ? "external" : "vault";
    const rawPath = nonEmptyString(rawAction.path);
    if (!rawPath) {
      return fail("invalid-arguments", "pathActions.path must be a non-empty string");
    }

    if (actionType === "move") {
      const destinationPath = nonEmptyString(rawAction.destinationPath);
      if (!destinationPath) {
        return fail("invalid-arguments", "move pathActions require destinationPath");
      }
      if (scope !== "vault") {
        return fail("invalid-arguments", "move pathActions only support vault scope");
      }
      const fromPath = classifyVaultPath({
        vaultPath: environment.vaultPath,
        input: rawPath,
        privateGlobs: environment.privateGlobs,
      });
      if (!fromPath.ok) {
        return fail(fromPath.error.code, fromPath.error.message, { path: fromPath.error.path });
      }
      if (!fs.existsSync(fromPath.value.absolutePath)) {
        return fail("proposal-source-missing", "move source path is missing", { path: fromPath.value.normalizedRelativePath });
      }
      const toPath = classifyVaultPath({
        vaultPath: environment.vaultPath,
        input: destinationPath,
        privateGlobs: environment.privateGlobs,
      });
      if (!toPath.ok) {
        return fail(toPath.error.code, toPath.error.message, { path: toPath.error.path });
      }
      if (fromPath.value.normalizedRelativePath === toPath.value.normalizedRelativePath) {
        return fail("invalid-arguments", "move source and destination must differ");
      }
      const destinationBeforeHash = fs.existsSync(toPath.value.absolutePath) ? fileHash(toPath.value.absolutePath) : null;
      if (destinationBeforeHash !== null) {
        return fail("proposal-target-exists", `move destination already exists: ${toPath.value.normalizedRelativePath}`);
      }
      actions.push({
        type: "move",
        scope: "vault",
        path: fromPath.value.normalizedRelativePath,
        destinationPath: toPath.value.normalizedRelativePath,
        beforeHash: fileHash(fromPath.value.absolutePath),
        destinationBeforeHash,
      });
      continue;
    }

    if (scope !== "external") {
      return fail("invalid-arguments", "delete-file pathActions require external scope");
    }
    const inspection = inspectImportSource({
      rootDir: environment.rootDir,
      vaultPath: environment.vaultPath,
      privateGlobs: environment.privateGlobs,
      inputPath: rawPath,
      explicitPathProvided: true,
    });
    if (!inspection.ok) {
      return fail(inspection.error.code, inspection.error.message, { path: inspection.error.path });
    }
    actions.push({
      type: "delete-file",
      scope: "external",
      path: inspection.value.absolutePath,
      beforeHash: inspection.value.hash,
    });
  }
  return {
    ok: true,
    value: actions,
  };
}

export function validatePathAction(
  environment: ProposalEnvironment,
  action: ProposalPathAction,
): Result<void> {
  if (action.type === "move") {
    const fromPath = classifyVaultPath({
      vaultPath: environment.vaultPath,
      input: action.path,
      privateGlobs: environment.privateGlobs,
    });
    if (!fromPath.ok) {
      return fail(fromPath.error.code, fromPath.error.message, { path: fromPath.error.path });
    }
    if (!fs.existsSync(fromPath.value.absolutePath)) {
      return fail("proposal-source-missing", "move source path is missing", { path: action.path });
    }
    if (fileHash(fromPath.value.absolutePath) !== action.beforeHash) {
      return fail("proposal-source-changed", "move source changed after proposal creation", { path: action.path });
    }
    const toPath = classifyVaultPath({
      vaultPath: environment.vaultPath,
      input: action.destinationPath,
      privateGlobs: environment.privateGlobs,
    });
    if (!toPath.ok) {
      return fail(toPath.error.code, toPath.error.message, { path: toPath.error.path });
    }
    const destinationHash = fs.existsSync(toPath.value.absolutePath) ? fileHash(toPath.value.absolutePath) : null;
    if (destinationHash !== action.destinationBeforeHash) {
      return fail("proposal-target-changed", "move destination changed after proposal creation", {
        path: action.destinationPath,
      });
    }
    return {
      ok: true,
      value: undefined,
    };
  }

  const inspection = inspectImportSource({
    rootDir: environment.rootDir,
    vaultPath: environment.vaultPath,
    privateGlobs: environment.privateGlobs,
    inputPath: action.path,
    explicitPathProvided: true,
  });
  if (!inspection.ok) {
    return fail(inspection.error.code, inspection.error.message, { path: inspection.error.path });
  }
  if (inspection.value.hash !== action.beforeHash) {
    return fail("proposal-external-source-changed", "external source changed after proposal creation", {
      path: action.path,
    });
  }
  return {
    ok: true,
    value: undefined,
  };
}

export function primaryProposalPath(proposal: Pick<StoredProposal, "targetPaths" | "pathActions">): string | undefined {
  return proposal.targetPaths[0] ?? proposal.pathActions[0]?.path;
}

export function buildChangedVaultPaths(proposal: Pick<StoredProposal, "targetPaths" | "pathActions">): string[] {
  const changedPaths = new Set(proposal.targetPaths);
  for (const action of proposal.pathActions) {
    if (action.scope !== "vault") {
      continue;
    }
    changedPaths.add(action.path);
    changedPaths.add(action.destinationPath);
  }
  return [...changedPaths].sort(compareVaultPaths);
}

export function proposalPathActionDiffPayload(action: ProposalPathAction): Record<string, unknown> {
  if (action.type === "move") {
    return {
      type: action.type,
      scope: action.scope,
      path: action.path,
      destinationPath: action.destinationPath,
      beforeHash: action.beforeHash,
      destinationBeforeHash: action.destinationBeforeHash,
    };
  }
  return {
    type: action.type,
    scope: action.scope,
    path: action.path,
    beforeHash: action.beforeHash,
  };
}
