import path from "path";

export interface MarkdownLink {
  kind: "wikilink" | "markdown";
  rawTarget: string;
  targetPath?: string;
  targetHeading?: string;
  alias?: string;
  resolved: boolean;
  isEmbed: boolean;
}

export interface AssetReference {
  target: string;
  isEmbed: boolean;
  resolvedTargetPath?: string;
}

const WIKILINK_RE = /(!)?\[\[([^\]]+)\]\]/g;
const MARKDOWN_LINK_RE = /(!)?\[[^\]]*\]\(([^)]+)\)/g;
const ASSET_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".pdf",
  ".png",
  ".svg",
  ".webp",
  ".wav",
]);

export function collectMarkdownLinks(
  sourceRelativePath: string,
  body: string,
  knownNotePaths: string[],
  knownAssetPaths: string[],
): {
  noteLinks: MarkdownLink[];
  assetReferences: AssetReference[];
} {
  const noteLinks: MarkdownLink[] = [];
  const assetReferences: AssetReference[] = [];

  for (const match of body.matchAll(WIKILINK_RE)) {
    const isEmbed = match[1] === "!";
    const raw = match[2].trim();
    const [targetAndHeading, alias] = splitOnce(raw, "|");
    const [target, heading] = splitOnce(targetAndHeading, "#");
    const cleanTarget = target.trim();
    if (isAssetTarget(cleanTarget)) {
      assetReferences.push({
        target: cleanTarget,
        isEmbed,
        resolvedTargetPath: resolveAssetTarget(sourceRelativePath, cleanTarget, knownAssetPaths),
      });
      continue;
    }
    const targetPath = resolveWikilinkTarget(cleanTarget, knownNotePaths);
    noteLinks.push({
      kind: "wikilink",
      rawTarget: cleanTarget,
      targetPath,
      targetHeading: heading?.trim() || undefined,
      alias: alias?.trim() || undefined,
      resolved: Boolean(targetPath),
      isEmbed,
    });
  }

  for (const match of body.matchAll(MARKDOWN_LINK_RE)) {
    const isEmbed = match[1] === "!";
    const raw = match[2].trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      continue;
    }
    const [target, heading] = splitOnce(raw, "#");
    const cleanTarget = target.trim();
    if (isAssetTarget(cleanTarget)) {
      assetReferences.push({
        target: cleanTarget,
        isEmbed,
        resolvedTargetPath: resolveAssetTarget(sourceRelativePath, cleanTarget, knownAssetPaths),
      });
      continue;
    }
    const targetPath = resolveMarkdownTarget(sourceRelativePath, cleanTarget, knownNotePaths);
    noteLinks.push({
      kind: "markdown",
      rawTarget: cleanTarget,
      targetPath,
      targetHeading: heading?.trim() || undefined,
      resolved: Boolean(targetPath),
      isEmbed,
    });
  }

  return { noteLinks, assetReferences };
}

export function extractWikilinkTargets(text: string): string[] {
  const targets = new Set<string>();
  for (const match of text.matchAll(WIKILINK_RE)) {
    const [targetAndHeading] = splitOnce(match[2].trim(), "|");
    const [target] = splitOnce(targetAndHeading, "#");
    if (target.trim()) {
      targets.add(target.trim());
    }
  }
  return [...targets].sort();
}

export function extractMarkdownLinkTargets(text: string): string[] {
  const targets = new Set<string>();
  for (const match of text.matchAll(MARKDOWN_LINK_RE)) {
    const raw = match[2].trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      continue;
    }
    const [target] = splitOnce(raw, "#");
    if (target.trim()) {
      targets.add(target.trim());
    }
  }
  return [...targets].sort();
}

function resolveWikilinkTarget(target: string, knownNotePaths: string[]): string | undefined {
  const direct = resolveVaultRelativeTarget(target, knownNotePaths);
  if (direct) {
    return direct;
  }
  const normalizedTarget = noteKey(target);
  return [...knownNotePaths].sort(compareSearchPaths).find((knownPath) => noteKey(knownPath) === normalizedTarget);
}

function resolveMarkdownTarget(
  sourceRelativePath: string,
  target: string,
  knownNotePaths: string[],
): string | undefined {
  return resolveRelativeTarget(sourceRelativePath, target, knownNotePaths);
}

function resolveAssetTarget(
  sourceRelativePath: string,
  target: string,
  knownAssetPaths: string[],
): string | undefined {
  const sourceRelative = resolveRelativeTarget(sourceRelativePath, target, knownAssetPaths);
  if (sourceRelative) {
    return sourceRelative;
  }

  const direct = resolveVaultRelativeTarget(target, knownAssetPaths);
  if (direct) {
    return direct;
  }

  const basename = path.posix.basename(normalizeTargetPath(target));
  if (!basename) {
    return undefined;
  }
  const matches = knownAssetPaths.filter((knownPath) => path.posix.basename(knownPath) === basename);
  return matches.length === 1 ? matches[0] : undefined;
}

function resolveRelativeTarget(
  sourceRelativePath: string,
  target: string,
  knownPaths: string[],
): string | undefined {
  const normalized = normalizeTargetPath(path.posix.join(path.posix.dirname(sourceRelativePath), target));
  return knownPaths.find((knownPath) => normalizeTargetPath(knownPath) === normalized);
}

function resolveVaultRelativeTarget(target: string, knownPaths: string[]): string | undefined {
  const normalized = normalizeTargetPath(target);
  return knownPaths.find((knownPath) => normalizeTargetPath(knownPath) === normalized);
}

function isAssetTarget(target: string): boolean {
  return ASSET_EXTENSIONS.has(path.posix.extname(target).toLocaleLowerCase());
}

function splitOnce(value: string, separator: string): [string, string | undefined] {
  const index = value.indexOf(separator);
  if (index === -1) {
    return [value, undefined];
  }
  return [value.slice(0, index), value.slice(index + separator.length)];
}

function noteKey(value: string): string {
  const noExtension = value.replace(/\.md$/i, "");
  const basename = path.posix.basename(noExtension);
  return basename
    .normalize("NFC")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeTargetPath(value: string): string {
  return path.posix.normalize(value).replace(/^\.\//, "").normalize("NFC");
}

function compareSearchPaths(left: string, right: string): number {
  return left.replace(/ /g, "~").localeCompare(right.replace(/ /g, "~"));
}
