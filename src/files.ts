import crypto from "crypto";
import fs from "fs";
import path from "path";
import { classifyVaultPath } from "./path-safety";

export interface ListVaultFilesOptions {
  vaultPath: string;
  selectedPaths: string[];
  privateGlobs?: string[];
}

export function listVaultFiles(options: ListVaultFilesOptions): string[] {
  const vaultPath = path.resolve(options.vaultPath);
  const selectedPaths = options.selectedPaths.length > 0 ? options.selectedPaths : ["."];
  const files = new Set<string>();

  for (const selectedPath of selectedPaths) {
    const classified = classifyVaultPath({
      vaultPath,
      input: selectedPath,
      privateGlobs: options.privateGlobs,
    });
    if (!classified.ok && ["outside-vault", "path-traversal", "encoded-separator"].includes(classified.error.code)) {
      throw new Error(`selected path outside vault: ${selectedPath}`);
    }
    if (!classified.ok) {
      continue;
    }
    const absolute = classified.value.absolutePath;
    if (!fs.existsSync(absolute) || fs.lstatSync(absolute).isSymbolicLink()) {
      continue;
    }
    collectVaultFiles(vaultPath, absolute, files, options.privateGlobs ?? []);
  }

  return [...files].sort();
}

export function fileHash(filePath: string): string {
  const digest = crypto.createHash("sha256");
  digest.update(fs.readFileSync(filePath));
  return digest.digest("hex");
}

function collectVaultFiles(
  vaultPath: string,
  absolute: string,
  files: Set<string>,
  privateGlobs: string[],
): void {
  const relative = toPosix(path.relative(vaultPath, absolute));
  const classified = classifyVaultPath({
    vaultPath,
    input: relative || ".",
    privateGlobs,
  });
  if (!classified.ok) {
    return;
  }

  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    return;
  }
  if (stat.isFile()) {
    files.add(absolute);
    return;
  }
  if (!stat.isDirectory()) {
    return;
  }

  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    collectVaultFiles(vaultPath, path.join(absolute, entry.name), files, privateGlobs);
  }
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
