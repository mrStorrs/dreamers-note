import path from "path";
import { compareVaultPaths, readVaultRegularFile, scanVaultEntries } from "./files";
import { extractMarkdownLinks, extractWikilinks } from "./markdown";
import { classifyVaultPath } from "./path-safety";
import { validateConventionPath } from "./conventions";
import type { ChangeCreateInput } from "./change-contracts";
import type { Result } from "./types";
import type { VaultEnvironment } from "./vault-environment";

const REQUIRED_REVIEW_SCOPE = ["placement", "tags", "links", "content"];
const TARGET_ROOTS = new Set([
  "00-inbox",
  "01-projects",
  "02-knowledge",
  "03-sources",
  "04-people",
  "05-assets",
  "06-templates",
  "07-system",
  "99-archive",
]);

const TOP_LEVEL_MAP: Record<string, string> = {
  "00-inbox": "00-inbox",
  "01-projects": "01-projects",
  "02-areas": "02-knowledge",
  "02-knowledge": "02-knowledge",
  "03-knowledge": "02-knowledge",
  "03-sources": "03-sources",
  "04-sources": "03-sources",
  "04-people": "04-people",
  "05-people": "04-people",
  "05-assets": "05-assets",
  "06-assets": "05-assets",
  "06-templates": "06-templates",
  "07-templates": "06-templates",
  "07-system": "07-system",
  "08-system": "07-system",
  "99-archive": "99-archive",
  archive: "99-archive",
  areas: "02-knowledge",
  "broad-topics": "02-knowledge",
  family: "04-people",
  inbox: "00-inbox",
  knowledge: "02-knowledge",
  people: "04-people",
  projects: "01-projects",
  resources: "02-knowledge",
  sources: "03-sources",
  assets: "05-assets",
  templates: "06-templates",
  system: "07-system",
};
const AREA_ALIASES = new Set(["02-areas", "02-knowledge", "03-knowledge", "areas", "broad-topics", "knowledge", "resources"]);
const LEGACY_AREA_ALIASES = new Set(["03-knowledge", "broad-topics", "knowledge", "resources"]);
const PEOPLE_ALIASES = new Set(["family"]);
const MAX_NORMALIZATION_RESULT_BYTES = 512 * 1024;

export interface VaultNormalizationResult {
  changeInput: ChangeCreateInput;
  decisions: number;
  writes: number;
  moves: number;
  unresolvedReferences: number;
}

interface NormalizationDecision {
  sourcePath: string;
  targetPath: string;
  approvedTags: string[];
  linksToAdd: string[];
  extractedNotes: ExtractedNote[];
}

interface ExtractedNote {
  targetPath: string;
  title: string;
  body: string;
  approvedTags: string[];
  linksToAdd: string[];
}

export function normalizeVaultRelativePath(relativePath: string): string {
  const parts = relativePath.split("/").filter(Boolean);
  const filename = parts.pop() ?? "untitled";
  const normalizedParts = parts.map(normalizeSegment);
  const normalizedName = normalizeFileName(filename);
  if (normalizedParts.length === 0) {
    return filename.toLocaleLowerCase().endsWith(".md")
      ? `02-knowledge/uncategorized/general/${normalizedName}`
      : `05-assets/${normalizedName}`;
  }
  const firstRaw = normalizedParts[0];
  const first = TOP_LEVEL_MAP[firstRaw] ?? firstRaw;
  const markdown = normalizedName.endsWith(".md");
  if (!markdown && LEGACY_AREA_ALIASES.has(firstRaw)) {
    return ["05-assets", ...normalizedParts, normalizedName].join("/");
  }
  if (markdown && AREA_ALIASES.has(firstRaw)) {
    return classifiedNotePath("02-knowledge", normalizedParts.slice(1), normalizedName);
  }
  if (markdown && PEOPLE_ALIASES.has(firstRaw)) {
    return classifiedNotePath("04-people", normalizedParts, normalizedName);
  }
  if (markdown && !TARGET_ROOTS.has(first)) {
    return classifiedNotePath("02-knowledge", normalizedParts, normalizedName);
  }
  if (!TARGET_ROOTS.has(first)) {
    return ["05-assets", ...normalizedParts, normalizedName].join("/");
  }
  if (markdown && ["01-projects", "02-knowledge", "04-people"].includes(first)) {
    return classifiedNotePath(first, normalizedParts.slice(1), normalizedName);
  }
  return [first, ...normalizedParts.slice(1), normalizedName].join("/");
}

export function planVaultNormalization(
  environment: VaultEnvironment,
  records: unknown[],
): Result<VaultNormalizationResult> {
  const decisions = validateDecisions(environment, records);
  if (!decisions.ok) {
    return decisions;
  }
  const rewrite = rewriteAffectedMarkdown(environment, decisions.value);
  if (!rewrite.ok) {
    return rewrite;
  }
  const extractedWrites = decisions.value.flatMap((decision) => decision.extractedNotes.map((note) => ({
    path: note.targetPath,
    body: renderExtractedNote(note, decision.targetPath),
  })));
  const moves = decisions.value
    .filter((decision) => decision.sourcePath !== decision.targetPath)
    .map((decision) => ({ from: decision.sourcePath, to: decision.targetPath }))
    .sort((left, right) => compareVaultPaths(left.from, right.from) || compareVaultPaths(left.to, right.to));
  const movingSources = new Set(moves.map((move) => move.from));
  const writes = [...rewrite.value.writes, ...extractedWrites]
    .map((write) => ({ ...write, ...(movingSources.has(write.path) ? { beforeMove: true } : {}) }))
    .sort((left, right) => compareVaultPaths(left.path, right.path));
  if (writes.length === 0 && moves.length === 0) {
    return fail("vault-normalize-empty", "reviewed normalization decisions do not change the vault");
  }
  const value: VaultNormalizationResult = {
    changeInput: {
      summary: "Apply reviewed vault normalization",
      writes,
      moves,
    },
    decisions: decisions.value.length,
    writes: writes.length,
    moves: moves.length,
    unresolvedReferences: rewrite.value.unresolvedReferences,
  };
  if (serializedByteLength(value) > MAX_NORMALIZATION_RESULT_BYTES) {
    return fail("vault-normalize-output-too-large", "normalization change input exceeds the reviewable output limit");
  }
  return {
    ok: true,
    value,
  };
}

function validateDecisions(environment: VaultEnvironment, records: unknown[]): Result<NormalizationDecision[]> {
  if (!Array.isArray(records) || records.length === 0) {
    return fail("vault-normalize-decisions-invalid", "normalization requires one or more reviewed decisions");
  }
  const decisions: NormalizationDecision[] = [];
  const sources = new Set<string>();
  const targets = new Set<string>();
  const extractedTargets = new Set<string>();
  for (const record of records) {
    if (!isRecord(record) || record.reviewed !== true) {
      return fail("vault-normalize-review-required", "every normalization decision must be reviewed");
    }
    if (!hasExactReviewScope(record.reviewed_scope) || hasUnresolvedQuestions(record.unresolved_questions)) {
      return fail("vault-normalize-review-invalid", "reviewed decisions require the complete scope with no unresolved questions");
    }
    const source = normalizedVaultFile(environment, record.source_path, "vault-normalize-source-invalid", false);
    if (!source.ok) return source;
    const target = normalizedVaultFile(environment, record.target_path, "vault-normalize-target-invalid", true);
    if (!target.ok) return target;
    if (!TARGET_ROOTS.has(target.value.split("/")[0] ?? "")) {
      return fail("vault-normalize-target-invalid", "normalization target must use an approved vault root");
    }
    const approvedTags = stringArray(record.approved_tags);
    const linksToAdd = stringArray(record.links_to_add);
    if (!approvedTags || !linksToAdd || approvedTags.some((tag) => !environment.approvedTags.includes(tag)) || linksToAdd.some((link) => !boundedText(link))) {
      return fail("vault-normalize-decision-invalid", "normalization decision contains unsupported tags or links");
    }
    const convention = validateConventionPath(target.value, approvedTags, new Set(environment.approvedTags), environment.conventionPolicy);
    if (!convention.ok) {
      return fail("vault-normalize-target-invalid", "normalization target does not meet vault conventions");
    }
    if (sources.has(source.value) || targets.has(target.value) || extractedTargets.has(source.value) || extractedTargets.has(target.value)) {
      return fail("vault-normalize-collision", "normalization decisions contain duplicate sources or targets");
    }
    const targetExists = target.value === source.value
      ? { ok: true as const, value: false }
      : vaultFileExists(environment, target.value, "vault-normalize-target-invalid");
    if (!targetExists.ok) return targetExists;
    if (targetExists.value) {
      return fail("vault-normalize-collision", "normalization target already exists");
    }
    const extracted = validateExtractedNotes(environment, record.extracted_notes, target.value, targets, extractedTargets);
    if (!extracted.ok) return extracted;
    sources.add(source.value);
    targets.add(target.value);
    decisions.push({
      sourcePath: source.value,
      targetPath: target.value,
      approvedTags,
      linksToAdd,
      extractedNotes: extracted.value,
    });
  }
  for (const decision of decisions) {
    if (decision.targetPath !== decision.sourcePath && sources.has(decision.targetPath)) {
      return fail("vault-normalize-collision", "normalization targets may not overlap a source path");
    }
  }
  return { ok: true, value: decisions };
}

function validateExtractedNotes(
  environment: VaultEnvironment,
  value: unknown,
  sourceTarget: string,
  moveTargets: Set<string>,
  extractedTargets: Set<string>,
): Result<ExtractedNote[]> {
  if (value === undefined) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(value)) {
    return fail("vault-normalize-decision-invalid", "extracted notes must be an array");
  }
  const notes: ExtractedNote[] = [];
  for (const rawNote of value) {
    if (!isRecord(rawNote)) {
      return fail("vault-normalize-decision-invalid", "extracted note is not valid");
    }
    const target = normalizedVaultFile(environment, rawNote.target_path, "vault-normalize-target-invalid", true);
    if (!target.ok) return target;
    if (!target.value.endsWith(".md") || !TARGET_ROOTS.has(target.value.split("/")[0] ?? "")) {
      return fail("vault-normalize-target-invalid", "extracted note target is not eligible");
    }
    const title = typeof rawNote.title === "string" ? rawNote.title.trim() : "";
    const body = typeof rawNote.body === "string" ? rawNote.body.trim() : "";
    const approvedTags = stringArray(rawNote.approved_tags);
    const linksToAdd = stringArray(rawNote.links_to_add);
    if (!boundedText(title) || !boundedText(body, 1_000_000) || !approvedTags || !linksToAdd || approvedTags.some((tag) => !environment.approvedTags.includes(tag)) || linksToAdd.some((link) => !boundedText(link))) {
      return fail("vault-normalize-decision-invalid", "extracted note has invalid content, tags, or links");
    }
    const convention = validateConventionPath(target.value, approvedTags, new Set(environment.approvedTags), environment.conventionPolicy);
    const targetExists = vaultFileExists(environment, target.value, "vault-normalize-target-invalid");
    if (!targetExists.ok) return targetExists;
    if (
      !convention.ok
      || targetExists.value
      || target.value === sourceTarget
      || moveTargets.has(target.value)
      || extractedTargets.has(target.value)
    ) {
      return fail("vault-normalize-collision", "extracted note target conflicts with the reviewed normalization");
    }
    extractedTargets.add(target.value);
    notes.push({ targetPath: target.value, title, body, approvedTags, linksToAdd });
  }
  return { ok: true, value: notes };
}

function rewriteAffectedMarkdown(
  environment: VaultEnvironment,
  decisions: NormalizationDecision[],
): Result<{ writes: Array<{ path: string; body: string }>; unresolvedReferences: number }> {
  let scan;
  try {
    scan = scanVaultEntries({ vaultPath: environment.vaultPath, privateGlobs: environment.privateGlobs });
  } catch {
    return fail("vault-normalize-scan-failed", "normalization could not inspect vault notes");
  }
  const maps = buildReferenceMaps(decisions);
  if (!maps.ok) return maps;
  const bySource = new Map(decisions.map((decision) => [decision.sourcePath, decision]));
  const oldTokens = new Set([...maps.value.note.keys(), ...maps.value.asset.keys()]);
  const writes: Array<{ path: string; body: string }> = [];
  let unresolvedReferences = 0;
  for (const entry of scan.files.filter((item) => item.kind === "note")) {
    let content: Buffer | undefined;
    try {
      content = readVaultRegularFile(environment.vaultPath, entry.relativePath);
    } catch {
      return fail("vault-normalize-scan-failed", "normalization could not inspect vault notes");
    }
    if (!content) {
      return fail("vault-normalize-scan-failed", "vault notes changed during normalization planning");
    }
    const decision = bySource.get(entry.relativePath);
    let body = rewriteWikiLinks(content.toString("utf8"), maps.value.note, maps.value.asset);
    body = rewriteMarkdownLinks(body, maps.value.note, maps.value.asset);
    if (decision?.approvedTags.length) {
      body = setFrontmatterTags(body, decision.approvedTags);
    }
    if (decision) {
      body = appendLinks(body, decision.linksToAdd);
    }
    unresolvedReferences += [...extractWikilinks(body), ...extractMarkdownLinks(body)]
      .filter((reference) => oldTokens.has(reference) || oldTokens.has(path.posix.basename(reference))).length;
    if (body !== content.toString("utf8")) {
      writes.push({ path: entry.relativePath, body });
    }
  }
  return { ok: true, value: { writes, unresolvedReferences } };
}

function buildReferenceMaps(
  decisions: NormalizationDecision[],
): Result<{ note: Map<string, string>; asset: Map<string, string> }> {
  const note = new Map<string, string>();
  const asset = new Map<string, string>();
  for (const decision of decisions) {
    const source = decision.sourcePath;
    const target = decision.targetPath;
    const map = source.endsWith(".md") ? note : asset;
    const replacement = source.endsWith(".md") ? withoutExtension(target) : target;
    const tokens = source.endsWith(".md")
      ? [source, withoutExtension(source), path.posix.basename(source), path.posix.basename(withoutExtension(source))]
      : [source, path.posix.basename(source)];
    for (const token of tokens) {
      const previous = map.get(token);
      if (previous && previous !== replacement) {
        return fail("vault-normalize-link-ambiguous", "normalization decisions contain ambiguous link aliases");
      }
      map.set(token, replacement);
    }
  }
  return { ok: true, value: { note, asset } };
}

function rewriteWikiLinks(text: string, note: Map<string, string>, asset: Map<string, string>): string {
  return text.replace(/(!?)\[\[([^\]]+)\]\]/g, (whole, embed: string, inner: string) => {
    const [targetAndAnchor, alias] = inner.split("|", 2);
    const hashIndex = targetAndAnchor.indexOf("#");
    const target = hashIndex >= 0 ? targetAndAnchor.slice(0, hashIndex) : targetAndAnchor;
    const anchor = hashIndex >= 0 ? targetAndAnchor.slice(hashIndex) : "";
    const replacement = asset.get(target) ?? note.get(target);
    if (!replacement) return whole;
    const display = alias ?? (!embed && !target.endsWith(".md") ? path.posix.basename(withoutExtension(target)) : "");
    return `${embed}[[${replacement}${anchor}${display ? `|${display}` : ""}]]`;
  });
}

function rewriteMarkdownLinks(text: string, note: Map<string, string>, asset: Map<string, string>): string {
  return text.replace(/(!?)\[([^\]]*)\]\(([^)]+)\)/g, (whole, prefix: string, label: string, rawTarget: string) => {
    const hashIndex = rawTarget.indexOf("#");
    const target = hashIndex >= 0 ? rawTarget.slice(0, hashIndex) : rawTarget;
    const anchor = hashIndex >= 0 ? rawTarget.slice(hashIndex) : "";
    const replacement = asset.get(target)
      ?? asset.get(path.posix.basename(target))
      ?? (note.get(target) ? `${note.get(target)}.md` : undefined)
      ?? (note.get(withoutExtension(target)) ? `${note.get(withoutExtension(target))}.md` : undefined);
    return replacement ? `${prefix}[${label}](${replacement}${anchor})` : whole;
  });
}

function setFrontmatterTags(text: string, tags: string[]): string {
  const tagLines = ["tags:", ...[...tags].sort().map((tag) => `  - ${tag}`)];
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---\n", 4);
    if (end !== -1) {
      const frontmatter = text.slice(4, end).split("\n");
      const next: string[] = [];
      let skipTags = false;
      for (const line of frontmatter) {
        const trimmed = line.trim();
        if (trimmed === "tags:" || trimmed.startsWith("tags:")) {
          skipTags = true;
          continue;
        }
        if (skipTags && trimmed.startsWith("- ")) {
          continue;
        }
        skipTags = false;
        next.push(line);
      }
      return `---\n${[...next, ...tagLines].join("\n").trim()}\n---\n${text.slice(end + 5)}`;
    }
  }
  return `---\n${tagLines.join("\n")}\n---\n${text}`;
}

function appendLinks(text: string, links: string[]): string {
  const bullets = links.filter(Boolean).map((link) => `- ${wikilinkFor(link)}`);
  const missing = bullets.filter((bullet) => !text.includes(bullet));
  if (missing.length === 0) return text;
  const addition = missing.join("\n");
  return text.includes("## links")
    ? `${text.trimEnd()}\n${addition}\n`
    : `${text.trimEnd()}\n\n## links\n\n${addition}\n`;
}

function renderExtractedNote(note: ExtractedNote, sourceTarget: string): string {
  const lines: string[] = [];
  if (note.approvedTags.length) {
    lines.push("---", "tags:", ...[...note.approvedTags].sort().map((tag) => `  - ${tag}`), "---", "");
  }
  lines.push(`# ${note.title}`, "", `source: ${wikilinkFor(sourceTarget)}`, "", "## notes", "", note.body);
  if (note.linksToAdd.length) {
    lines.push("", "## links", "", ...note.linksToAdd.map((link) => `- ${wikilinkFor(link)}`));
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function normalizedVaultFile(
  environment: VaultEnvironment,
  value: unknown,
  code: string,
  target: boolean,
): Result<string> {
  if (typeof value !== "string" || !value.trim()) {
    return fail(code, "normalization decision path is invalid");
  }
  const classified = classifyVaultPath({
    vaultPath: environment.vaultPath,
    input: value,
    privateGlobs: environment.privateGlobs,
  });
  if (!classified.ok || !classified.value.normalizedRelativePath) {
    return fail(code, "normalization decision path is not eligible");
  }
  if (!target) {
    const exists = vaultFileExists(environment, classified.value.normalizedRelativePath, "vault-normalize-source-invalid");
    if (!exists.ok) return exists;
    if (!exists.value) {
      return fail("vault-normalize-source-missing", "normalization source is missing");
    }
  }
  return { ok: true, value: classified.value.normalizedRelativePath };
}

function vaultFileExists(environment: VaultEnvironment, relativePath: string, code: string): Result<boolean> {
  try {
    return { ok: true, value: readVaultRegularFile(environment.vaultPath, relativePath) !== undefined };
  } catch {
    return fail(code, "normalization decision path could not be safely inspected");
  }
}

function hasExactReviewScope(value: unknown): boolean {
  const scope = stringArray(value);
  if (!scope || scope.length !== REQUIRED_REVIEW_SCOPE.length) {
    return false;
  }
  return new Set(scope).size === REQUIRED_REVIEW_SCOPE.length
    && scope.every((item) => REQUIRED_REVIEW_SCOPE.includes(item));
}

function hasUnresolvedQuestions(value: unknown): boolean {
  return value !== undefined && (!Array.isArray(value) || value.length > 0);
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return value.map((item) => item.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: string, maximum = 500): boolean {
  return value.length > 0 && value.length <= maximum && !/[\x00-\x1F\x7F]/.test(value);
}

function normalizeSegment(value: string): string {
  const normalized = value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalized || "untitled";
}

function normalizeFileName(value: string): string {
  const extension = path.posix.extname(value).toLocaleLowerCase();
  const stem = extension ? value.slice(0, -extension.length) : value;
  return `${normalizeSegment(stem)}${extension}`;
}

function classifiedNotePath(root: string, topicParts: string[], filename: string): string {
  if (topicParts.length === 0) {
    return `${root}/uncategorized/general/${filename}`;
  }
  if (topicParts.length === 1) {
    return `${root}/${topicParts[0]}/general/${filename}`;
  }
  const name = topicParts.length > 2
    ? `${topicParts.slice(2).join("-")}-${filename}`
    : filename;
  return `${root}/${topicParts[0]}/${topicParts[1]}/${name}`;
}

function withoutExtension(value: string): string {
  return value.endsWith(".md") ? value.slice(0, -3) : value;
}

function wikilinkFor(target: string): string {
  if (target.startsWith("[[") && target.endsWith("]]")) return target;
  return `[[${withoutExtension(target.trim())}]]`;
}

function fail<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message } };
}

function serializedByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
