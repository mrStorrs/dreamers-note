import fs from "fs";
import path from "path";
import { compareVaultPaths, readVaultRegularFile, scanVaultEntries } from "./files";
import { extractMarkdownLinks, extractTagNames, extractWikilinks } from "./markdown";
import { collectMarkdownLinks } from "./markdown-links";
import { classifyVaultPath } from "./path-safety";
import { normalizeVaultRelativePath } from "./vault-normalization";
import type { Result } from "./types";
import type { VaultEnvironment } from "./vault-environment";

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 50;
const REQUIRED_REVIEW_SCOPE = ["placement", "tags", "links", "content"];
const MAX_INVENTORY_RESULT_BYTES = 512 * 1024;

export interface VaultInventoryInput {
  paths: string[];
  cursor?: string;
  limit?: number;
}

export interface VaultInventoryResult {
  items: Array<{
    sourcePath: string;
    proposedPath: string;
    fileKind: "markdown-note" | "asset-or-other";
    sha256: string;
    approvedTags: string[];
    unapprovedTagCandidates: string[];
    wikilinks: string[];
    markdownLinks: string[];
    assetReferences: string[];
    mustReadFile: true;
    aiReviewRequired: true;
    requiredReviewScope: string[];
    reviewState: "unreviewed";
    reviewRequired: true;
    risk: {
      linkUpdateNeeded: boolean;
      attachmentRisk: boolean;
    };
  }>;
  nextCursor: string | null;
  excludedCount: number;
}

interface ReferenceRisk {
  linkUpdateNeeded: boolean;
  attachmentRisk: boolean;
}

export function planVaultInventory(
  environment: VaultEnvironment,
  input: VaultInventoryInput,
): Result<VaultInventoryResult> {
  if (!Array.isArray(input.paths) || input.paths.length === 0) {
    return fail("vault-inventory-path-required", "vault inventory requires one or more paths");
  }
  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    return fail("vault-inventory-limit-invalid", "vault inventory limit is outside the safe range");
  }
  const paths = normalizeSelection(environment, input.paths);
  if (!paths.ok) {
    return paths as Result<VaultInventoryResult>;
  }
  const cursor = normalizeCursor(environment, input.cursor);
  if (!cursor.ok) {
    return cursor as Result<VaultInventoryResult>;
  }
  let scan;
  try {
    scan = scanVaultEntries({
      vaultPath: environment.vaultPath,
      privateGlobs: environment.privateGlobs,
      selectedPaths: paths.value,
    });
  } catch {
    return fail("vault-inventory-scan-failed", "vault inventory could not inspect the selected paths");
  }
  const referenceRisks = buildReferenceRisks(environment);
  if (!referenceRisks.ok) {
    return referenceRisks as Result<VaultInventoryResult>;
  }
  const eligible = scan.files.filter((entry) => !cursor.value || compareVaultPaths(entry.relativePath, cursor.value) > 0);
  const page = eligible.slice(0, limit);
  const items = [] as VaultInventoryResult["items"];
  for (const entry of page) {
    const record = inventoryRecord(environment, entry, referenceRisks.value);
    if (!record.ok) {
      return record as Result<VaultInventoryResult>;
    }
    items.push(record.value);
  }
  const value: VaultInventoryResult = {
    items,
    nextCursor: eligible.length > page.length ? page[page.length - 1]?.relativePath ?? null : null,
    excludedCount: scan.exclusions.length,
  };
  if (serializedByteLength(value) > MAX_INVENTORY_RESULT_BYTES) {
    return fail("vault-inventory-output-too-large", "vault inventory result exceeds the reviewable output limit");
  }
  return {
    ok: true,
    value,
  };
}

function normalizeSelection(environment: VaultEnvironment, requestedPaths: string[]): Result<string[]> {
  const selected = new Set<string>();
  for (const requestedPath of requestedPaths) {
    const classified = classifyVaultPath({
      vaultPath: environment.vaultPath,
      input: requestedPath,
      privateGlobs: environment.privateGlobs,
    });
    if (!classified.ok) {
      return fail("vault-inventory-path-invalid", "vault inventory path is not eligible");
    }
    try {
      const stat = fs.lstatSync(classified.value.absolutePath);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        return fail("vault-inventory-path-invalid", "vault inventory path is not eligible");
      }
    } catch {
      return fail("vault-inventory-path-invalid", "vault inventory path does not exist");
    }
    selected.add(classified.value.normalizedRelativePath || ".");
  }
  return { ok: true, value: [...selected].sort(compareVaultPaths) };
}

function normalizeCursor(environment: VaultEnvironment, cursor: string | undefined): Result<string> {
  if (!cursor) {
    return { ok: true, value: "" };
  }
  const classified = classifyVaultPath({
    vaultPath: environment.vaultPath,
    input: cursor,
    privateGlobs: environment.privateGlobs,
  });
  if (!classified.ok) {
    return fail("vault-inventory-cursor-invalid", "vault inventory cursor is not eligible");
  }
  return { ok: true, value: classified.value.normalizedRelativePath };
}

function inventoryRecord(
  environment: VaultEnvironment,
  entry: { relativePath: string; kind: "note" | "asset"; hash: string },
  referenceRisks: ReadonlyMap<string, ReferenceRisk>,
): Result<VaultInventoryResult["items"][number]> {
  const incoming = referenceRisks.get(entry.relativePath) ?? { linkUpdateNeeded: false, attachmentRisk: false };
  if (entry.kind === "asset") {
    return {
      ok: true,
      value: {
        sourcePath: entry.relativePath,
        proposedPath: normalizeVaultRelativePath(entry.relativePath),
        fileKind: "asset-or-other",
        sha256: entry.hash,
        approvedTags: [],
        unapprovedTagCandidates: [],
        wikilinks: [],
        markdownLinks: [],
        assetReferences: [],
        mustReadFile: true,
        aiReviewRequired: true,
        requiredReviewScope: [...REQUIRED_REVIEW_SCOPE],
        reviewState: "unreviewed",
        reviewRequired: true,
        risk: { linkUpdateNeeded: incoming.linkUpdateNeeded, attachmentRisk: true },
      },
    };
  }
  let content: Buffer | undefined;
  try {
    content = readVaultRegularFile(environment.vaultPath, entry.relativePath);
  } catch {
    return fail("vault-inventory-scan-failed", "vault inventory could not read a selected note");
  }
  if (!content) {
    return fail("vault-inventory-scan-failed", "vault inventory changed during inspection");
  }
  const text = content.toString("utf8");
  const tags = extractTagNames(text);
  const wikilinks = extractWikilinks(text);
  const markdownLinks = extractMarkdownLinks(text);
  const assetReferences = [...wikilinks, ...markdownLinks]
    .filter((reference) => path.posix.extname(reference) !== "")
    .sort();
  return {
    ok: true,
    value: {
      sourcePath: entry.relativePath,
      proposedPath: normalizeVaultRelativePath(entry.relativePath),
      fileKind: "markdown-note",
      sha256: entry.hash,
      approvedTags: tags.filter((tag) => environment.approvedTags.includes(tag)),
      unapprovedTagCandidates: tags.filter((tag) => !environment.approvedTags.includes(tag)),
      wikilinks,
      markdownLinks,
      assetReferences,
      mustReadFile: true,
      aiReviewRequired: true,
      requiredReviewScope: [...REQUIRED_REVIEW_SCOPE],
      reviewState: "unreviewed",
      reviewRequired: true,
      risk: {
        linkUpdateNeeded: wikilinks.length > 0 || markdownLinks.length > 0 || incoming.linkUpdateNeeded,
        attachmentRisk: /!\[\[|!\[/.test(text) || incoming.attachmentRisk,
      },
    },
  };
}

function buildReferenceRisks(environment: VaultEnvironment): Result<ReadonlyMap<string, ReferenceRisk>> {
  let scan;
  try {
    scan = scanVaultEntries({ vaultPath: environment.vaultPath, privateGlobs: environment.privateGlobs });
  } catch {
    return fail("vault-inventory-scan-failed", "vault inventory could not inspect vault references");
  }
  const notePaths = scan.files.filter((entry) => entry.kind === "note").map((entry) => entry.relativePath);
  const assetPaths = scan.files.filter((entry) => entry.kind === "asset").map((entry) => entry.relativePath);
  const risks = new Map<string, ReferenceRisk>();
  for (const entry of scan.files) {
    if (entry.kind !== "note") continue;
    let content: Buffer | undefined;
    try {
      content = readVaultRegularFile(environment.vaultPath, entry.relativePath);
    } catch {
      return fail("vault-inventory-scan-failed", "vault inventory could not inspect vault references");
    }
    if (!content) {
      return fail("vault-inventory-scan-failed", "vault inventory changed during reference inspection");
    }
    const links = collectMarkdownLinks(entry.relativePath, content.toString("utf8"), notePaths, assetPaths);
    for (const link of links.noteLinks) {
      recordIncomingRisk(risks, entry.relativePath, link.targetPath, link.isEmbed);
    }
    for (const reference of links.assetReferences) {
      recordIncomingRisk(risks, entry.relativePath, reference.resolvedTargetPath, reference.isEmbed);
    }
  }
  return { ok: true, value: risks };
}

function recordIncomingRisk(
  risks: Map<string, ReferenceRisk>,
  sourcePath: string,
  targetPath: string | undefined,
  isEmbed: boolean,
): void {
  if (!targetPath || targetPath === sourcePath) return;
  const current = risks.get(targetPath) ?? { linkUpdateNeeded: false, attachmentRisk: false };
  current.linkUpdateNeeded = true;
  current.attachmentRisk ||= isEmbed;
  risks.set(targetPath, current);
}

function fail<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message } };
}

function serializedByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
