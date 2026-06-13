import { extractMarkdownLinkTargets, extractTagNames, extractWikilinkTargets } from "./markdown";

export function extractTags(text: string): string[] {
  return extractTagNames(text);
}

export function extractWikilinks(text: string): string[] {
  return extractWikilinkTargets(text);
}

export function extractMarkdownLinks(text: string): string[] {
  return extractMarkdownLinkTargets(text);
}
