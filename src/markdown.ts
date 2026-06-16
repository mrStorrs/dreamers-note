import path from "path";
import {
  AssetReference,
  collectMarkdownLinks,
  extractMarkdownLinkTargets as extractMarkdownLinkTargetsFromLinks,
  extractWikilinkTargets as extractWikilinkTargetsFromLinks,
  MarkdownLink,
} from "./markdown-links";

export interface MarkdownHeading {
  level: number;
  text: string;
  path: string;
  line: number;
}

export interface MarkdownChunk {
  id: string;
  headingPath: string;
  text: string;
}

export interface ParseWarning {
  code: string;
  message: string;
}

export interface ParseMarkdownNoteOptions {
  relativePath: string;
  text: string;
  approvedTags: Set<string> | string[];
  knownNotePaths?: string[];
  knownAssetPaths?: string[];
}

export interface ParsedMarkdownNote {
  relativePath: string;
  title: string;
  headingPaths: MarkdownHeading[];
  chunks: MarkdownChunk[];
  links: MarkdownLink[];
  assetReferences: AssetReference[];
  approvedTags: string[];
  unapprovedTagCandidates: string[];
  warnings: ParseWarning[];
}

const HASHTAG_RE = /(?<!\w)#([\p{L}\p{N}][\p{L}\p{N}_/-]*)/gu;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

export type { AssetReference, MarkdownLink } from "./markdown-links";

export function parseMarkdownNote(options: ParseMarkdownNoteOptions): ParsedMarkdownNote {
  const approvedTagSet = new Set(Array.isArray(options.approvedTags) ? options.approvedTags : [...options.approvedTags]);
  const knownNotePaths = options.knownNotePaths ?? [];
  const knownAssetPaths = options.knownAssetPaths ?? [];
  const warnings: ParseWarning[] = [];
  const frontmatter = readFrontmatter(options.text, warnings);
  const extractedTags = new Set<string>(collectFrontmatterTags(frontmatter.raw, warnings));
  const links = collectMarkdownLinks(options.relativePath, frontmatter.body, knownNotePaths, knownAssetPaths);
  const inlineTags = collectBodyTags(frontmatter.body);
  for (const tag of inlineTags) {
    extractedTags.add(tag);
  }

  const lineState = parseBodyLines(frontmatter.body, titleFromPath(options.relativePath));
  const title = lineState.headings.find((heading) => heading.level === 1)?.text ?? titleFromPath(options.relativePath);
  const approvedTags = [...extractedTags].filter((tag) => approvedTagSet.has(tag)).sort();
  const unapprovedTagCandidates = [...extractedTags].filter((tag) => !approvedTagSet.has(tag)).sort();

  return {
    relativePath: options.relativePath,
    title,
    headingPaths: lineState.headings,
    chunks: lineState.chunks,
    links: links.noteLinks.sort(compareLinks),
    assetReferences: links.assetReferences.sort((left, right) => left.target.localeCompare(right.target)),
    approvedTags,
    unapprovedTagCandidates,
    warnings,
  };
}

export function titleFromPath(relativePath: string): string {
  const basename = path.posix.basename(relativePath, path.posix.extname(relativePath));
  return basename
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\p{L}/gu, (match) => match.toLocaleUpperCase());
}

export function extractTagNames(text: string): string[] {
  const warnings: ParseWarning[] = [];
  const frontmatter = readFrontmatter(text, warnings);
  const tags = new Set<string>(collectFrontmatterTags(frontmatter.raw, warnings));
  for (const tag of collectBodyTags(frontmatter.body)) {
    tags.add(tag);
  }
  return [...tags].sort();
}

export function extractWikilinkTargets(text: string): string[] {
  return extractWikilinkTargetsFromLinks(text);
}

export function extractMarkdownLinkTargets(text: string): string[] {
  return extractMarkdownLinkTargetsFromLinks(text);
}

export function extractTags(text: string): string[] {
  return extractTagNames(text);
}

export function extractWikilinks(text: string): string[] {
  return extractWikilinkTargets(text);
}

export function extractMarkdownLinks(text: string): string[] {
  return extractMarkdownLinkTargets(text);
}

function readFrontmatter(text: string, warnings: ParseWarning[]): { raw: string; body: string } {
  const normalizedText = text.replace(/\r\n/g, "\n");
  if (!normalizedText.startsWith("---\n")) {
    return { raw: "", body: normalizedText };
  }

  const end = normalizedText.indexOf("\n---\n", 4);
  if (end === -1) {
    warnings.push({
      code: "malformed-frontmatter",
      message: "frontmatter opening marker has no closing marker",
    });
    return { raw: "", body: normalizedText };
  }

  const raw = normalizedText.slice(4, end);
  if (looksMalformedFrontmatter(raw)) {
    warnings.push({
      code: "malformed-frontmatter",
      message: "frontmatter could not be parsed completely",
    });
  }
  return {
    raw,
    body: normalizedText.slice(end + "\n---\n".length),
  };
}

function collectFrontmatterTags(frontmatter: string, warnings: ParseWarning[]): string[] {
  if (!frontmatter) {
    return [];
  }
  const tags = new Set<string>();
  let inTagsList = false;
  for (const line of frontmatter.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "tags:") {
      inTagsList = true;
      continue;
    }
    if (inTagsList && trimmed.startsWith("- ")) {
      addTag(tags, trimmed.slice(2));
      continue;
    }
    if (inTagsList && trimmed && !trimmed.startsWith("#")) {
      inTagsList = false;
    }
    if (trimmed.startsWith("tags:") && trimmed !== "tags:") {
      const rawTags = trimmed.split(":", 2)[1].trim();
      if (rawTags.startsWith("[") && rawTags.endsWith("]")) {
        for (const tag of rawTags.slice(1, -1).split(",")) {
          addTag(tags, tag);
        }
      } else if (rawTags.includes("[") || rawTags.includes("]")) {
        warnings.push({
          code: "malformed-frontmatter",
          message: "frontmatter tags list is malformed",
        });
      } else {
        addTag(tags, rawTags);
      }
    }
  }
  return [...tags];
}

function collectBodyTags(body: string): string[] {
  const tags = new Set<string>();
  for (const match of body.matchAll(HASHTAG_RE)) {
    addTag(tags, match[1]);
  }
  return [...tags];
}

function addTag(tags: Set<string>, rawTag: string): void {
  const cleaned = rawTag.trim().replace(/^#/, "").replace(/^['"]|['"]$/g, "");
  if (cleaned) {
    tags.add(cleaned);
  }
}

function parseBodyLines(body: string, fallbackTitle: string): { headings: MarkdownHeading[]; chunks: MarkdownChunk[] } {
  const headings: MarkdownHeading[] = [];
  const chunks: MarkdownChunk[] = [];
  const stack: string[] = [];
  const lines = body.split(/\r?\n/);
  let currentHeadingPath = fallbackTitle;
  let currentChunkLines: string[] = [];
  let ordinal = 0;

  const flushChunk = () => {
    const text = currentChunkLines.join("\n").trim();
    if (!text) {
      currentChunkLines = [];
      return;
    }
    chunks.push({
      id: `chunk-${ordinal}`,
      headingPath: currentHeadingPath,
      text,
    });
    ordinal += 1;
    currentChunkLines = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      flushChunk();
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      stack.length = level - 1;
      stack[level - 1] = text;
      currentHeadingPath = stack.filter(Boolean).join(" > ") || text;
      headings.push({
        level,
        text,
        path: currentHeadingPath,
        line: index + 1,
      });
    }
    currentChunkLines.push(line);
  }
  flushChunk();

  return {
    headings,
    chunks,
  };
}

function compareLinks(left: MarkdownLink, right: MarkdownLink): number {
  return `${left.kind}:${left.rawTarget}:${left.isEmbed ? 1 : 0}`.localeCompare(
    `${right.kind}:${right.rawTarget}:${right.isEmbed ? 1 : 0}`,
  );
}

function looksMalformedFrontmatter(raw: string): boolean {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("tags:") && count(trimmed, "[") !== count(trimmed, "]")) {
      return true;
    }
    if (trimmed.includes(":") && /:\s*[\[{][^\]}]*$/.test(trimmed)) {
      return true;
    }
  }
  return false;
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}
