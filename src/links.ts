const WIKILINK_RE = /!?\[\[([^\]]+)\]\]/g;
const MARKDOWN_LINK_RE = /!?\[[^\]]*\]\(([^)]+)\)/g;
const HASHTAG_RE = /(?<!\w)#([A-Za-z0-9][A-Za-z0-9_-]*)/g;

export function extractTags(text: string): string[] {
  const tags = new Set<string>();
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---\n", 4);
    if (end !== -1) {
      const frontmatter = text.slice(4, end).split(/\r?\n/);
      let inTags = false;
      for (const line of frontmatter) {
        const trimmed = line.trim();
        if (trimmed === "tags:") {
          inTags = true;
          continue;
        }
        if (inTags && trimmed.startsWith("- ")) {
          tags.add(trimmed.slice(2).trim());
          continue;
        }
        if (inTags && trimmed && !trimmed.startsWith("#")) {
          inTags = false;
        }
        if (trimmed.startsWith("tags:") && trimmed !== "tags:") {
          const rawTags = trimmed.split(":", 2)[1].trim().replace(/^\[/, "").replace(/\]$/, "");
          for (const tag of rawTags.split(",")) {
            const cleaned = tag.trim().replace(/^['"]|['"]$/g, "");
            if (cleaned) {
              tags.add(cleaned);
            }
          }
        }
      }
    }
  }

  for (const match of text.matchAll(HASHTAG_RE)) {
    tags.add(match[1]);
  }

  return [...tags].filter(Boolean).sort();
}

export function extractWikilinks(text: string): string[] {
  const links = new Set<string>();
  for (const match of text.matchAll(WIKILINK_RE)) {
    links.add(match[1].split("|", 1)[0].split("#", 1)[0]);
  }
  return [...links].sort();
}

export function extractMarkdownLinks(text: string): string[] {
  const links = new Set<string>();
  for (const match of text.matchAll(MARKDOWN_LINK_RE)) {
    links.add(match[1].split("#", 1)[0]);
  }
  return [...links].sort();
}
