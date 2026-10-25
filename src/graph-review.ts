import Database from "better-sqlite3";
import { compareVaultPaths } from "./files";
import { classifyVaultPath } from "./path-safety";
import { normalizeForSearch } from "./text-prep";
import type { Result } from "./types";

const EXCERPT_LIMIT = 240;
const EMPTY_NOTE_CHARS = 24;
const OVERLONG_NOTE_CHARS = 4_500;

export interface GraphReviewEnvironment {
  databasePath: string;
  vaultPath: string;
  privateGlobs: string[];
}

export type ReviewSeverity = "high" | "medium" | "low" | "info";

export interface ReviewEvidence {
  path: string;
  detail: string;
  excerpt: string;
}

export interface ReviewFinding {
  category: string;
  severity: ReviewSeverity;
  summary: string;
  paths: string[];
  evidence: ReviewEvidence[];
  recommendation: string;
}

interface NoteRecord {
  path: string;
  title: string;
  tags: string[];
  unapprovedTags: string[];
  body: string;
  mtimeMs: number;
  outgoing: EdgeRecord[];
  incoming: Set<string>;
  assets: AssetReference[];
}

interface EdgeRecord {
  source: string;
  target: string | null;
  rawTarget: string;
  resolved: boolean;
}

interface AssetReference {
  target: string;
  resolvedTarget: string | null;
}

interface GraphState {
  notes: Map<string, NoteRecord>;
}

export function buildGraphReview(environment: GraphReviewEnvironment, options: { limit?: number } = {}) {
  return withGraphState(environment, "graph-review-failed", (state) => {
    const unresolved = [...state.notes.values()].flatMap((note) => note.outgoing.filter((edge) => !edge.resolved).map((edge) => finding(
      "unresolved-link", "medium", `Unresolved link in ${note.path}.`, [note.path], note,
      `Check or remove [[${edge.rawTarget}]].`,
    )));
    const orphans = [...state.notes.values()].filter((note) => note.incoming.size === 0 && note.outgoing.length === 0).map((note) => finding(
      "orphan-note", "low", `${note.path} has no indexed links.`, [note.path], note,
      "Add only links that make the note easier to find later.",
    ));
    const items = sortFindings([...unresolved, ...orphans]).slice(0, boundedLimit(options.limit));
    return {
      summary: { notes: state.notes.size, unresolvedLinks: unresolved.length, orphanNotes: orphans.length },
      items,
    };
  });
}

export function buildHealthReview(environment: GraphReviewEnvironment, options: { limit?: number } = {}) {
  return withGraphState(environment, "health-review-failed", (state) => {
    const items: ReviewFinding[] = [];
    for (const note of state.notes.values()) {
      if (note.body.trim().length <= EMPTY_NOTE_CHARS) {
        items.push(finding("thin-note", "low", `${note.path} has very little note content.`, [note.path], note, "Add durable context or merge it into its clear owner."));
      }
      if (note.body.length > OVERLONG_NOTE_CHARS) {
        items.push(finding("overlong-note", "low", `${note.path} is long enough to consider splitting.`, [note.path], note, "Split only independently findable subjects."));
      }
      if (note.unapprovedTags.length) {
        items.push(finding("unapproved-tags", "medium", `${note.path} has tags outside the approved taxonomy.`, [note.path], note, "Replace only with approved topical tags after review."));
      }
    }
    const ordered = sortFindings(items).slice(0, boundedLimit(options.limit));
    return {
      counts: countBySeverity(items),
      items: ordered,
    };
  });
}

export function buildDuplicateReview(environment: GraphReviewEnvironment, options: { limit?: number } = {}) {
  return withGraphState(environment, "duplicate-review-failed", (state) => ({
    items: duplicateFindings(state.notes).slice(0, boundedLimit(options.limit)),
  }));
}

export function buildRelatedContext(
  environment: GraphReviewEnvironment,
  options: { path?: string; query?: string; limit?: number },
) {
  return withGraphState(environment, "graph-context-failed", (state) => {
    const subject = resolveSubject(environment, options, state.notes);
    if (!subject) throw new Error("selected note was not found");
    const limit = boundedLimit(options.limit);
    const duplicateCandidates = duplicateFindings(state.notes).filter((item) => item.paths.includes(subject.path)).slice(0, limit);
    return {
      subject: { path: subject.path, title: subject.title },
      groups: {
        outgoingLinks: { items: subject.outgoing.filter((edge) => edge.resolved).slice(0, limit).map((edge) => finding("outgoing-link", "info", `${subject.path} links to ${edge.target}.`, [subject.path, edge.target ?? edge.rawTarget], subject, "Use this link as contextual evidence.")) },
        backlinks: { items: [...subject.incoming].sort(compareVaultPaths).slice(0, limit).map((source) => finding("backlink", "info", `${source} links to ${subject.path}.`, [source, subject.path], subject, "Review whether this relationship remains useful.")) },
        embeds: { items: subject.assets.slice(0, limit).map((asset) => finding("asset-embed", "info", `${subject.path} embeds ${asset.resolvedTarget ?? asset.target}.`, [subject.path, asset.resolvedTarget ?? asset.target], subject, "Keep referenced assets available.")) },
        duplicateCandidates: { items: duplicateCandidates },
        sharedTags: { items: sharedTagFindings(subject, state.notes, limit) },
      },
    };
  });
}

function withGraphState<T>(environment: GraphReviewEnvironment, code: string, callback: (state: GraphState) => T): Result<T> {
  try {
    const db = new Database(environment.databasePath, { readonly: true, fileMustExist: true });
    try {
      return { ok: true, value: callback(loadGraphState(db)) };
    } finally {
      db.close();
    }
  } catch {
    return { ok: false, error: { code, message: "runtime graph could not be read" } };
  }
}

function loadGraphState(db: Database.Database): GraphState {
  const rows = db.prepare(`
    select n.relative_path, n.title, n.approved_tags, n.unapproved_tags, f.mtime_ms,
      coalesce(group_concat(c.text, '\n'), '') as body
    from notes n join files f on f.relative_path = n.relative_path
    left join chunks c on c.relative_path = n.relative_path
    group by n.relative_path, n.title, n.approved_tags, n.unapproved_tags, f.mtime_ms
  `).all() as Array<{ relative_path: string; title: string; approved_tags: string; unapproved_tags: string; mtime_ms: number; body: string }>;
  const notes = new Map<string, NoteRecord>(rows.map((row) => [row.relative_path, {
    path: row.relative_path,
    title: row.title,
    tags: readStrings(row.approved_tags),
    unapprovedTags: readStrings(row.unapproved_tags),
    body: row.body,
    mtimeMs: row.mtime_ms,
    outgoing: [],
    incoming: new Set<string>(),
    assets: [],
  } as NoteRecord]));
  const edges = db.prepare("select relative_path, raw_target, target_path, resolved from graph_edges order by id").all() as Array<{ relative_path: string; raw_target: string; target_path: string | null; resolved: number }>;
  for (const row of edges) {
    const source = notes.get(row.relative_path);
    if (!source) continue;
    const edge = { source: row.relative_path, target: row.target_path, rawTarget: row.raw_target, resolved: row.resolved === 1 };
    source.outgoing.push(edge);
    if (edge.resolved && edge.target && notes.has(edge.target)) notes.get(edge.target)?.incoming.add(source.path);
  }
  const assets = db.prepare("select relative_path, target, resolved_target_path from asset_references order by id").all() as Array<{ relative_path: string; target: string; resolved_target_path: string | null }>;
  for (const row of assets) notes.get(row.relative_path)?.assets.push({ target: row.target, resolvedTarget: row.resolved_target_path });
  return { notes };
}

function resolveSubject(environment: GraphReviewEnvironment, options: { path?: string; query?: string }, notes: Map<string, NoteRecord>): NoteRecord | undefined {
  if (options.path) {
    const classified = classifyVaultPath({ vaultPath: environment.vaultPath, input: options.path, privateGlobs: environment.privateGlobs });
    return classified.ok ? notes.get(classified.value.normalizedRelativePath) : undefined;
  }
  const query = normalizeForSearch(options.query ?? "");
  if (!query) return undefined;
  return [...notes.values()].sort((left, right) => compareVaultPaths(left.path, right.path)).find((note) =>
    normalizeForSearch(note.title) === query || normalizeForSearch(note.path) === query || normalizeForSearch(note.title).includes(query));
}

function duplicateFindings(notes: Map<string, NoteRecord>): ReviewFinding[] {
  const values = [...notes.values()].sort((left, right) => compareVaultPaths(left.path, right.path));
  const results: ReviewFinding[] = [];
  for (let index = 0; index < values.length; index += 1) {
    for (let other = index + 1; other < values.length; other += 1) {
      const left = values[index];
      const right = values[other];
      const sameTitle = normalizeForSearch(left.title) && normalizeForSearch(left.title) === normalizeForSearch(right.title);
      const sameBody = left.body.trim().length > 40 && normalizeForSearch(left.body) === normalizeForSearch(right.body);
      if (sameTitle || sameBody) {
        results.push(finding("duplicate-candidate", "medium", `${left.path} and ${right.path} may overlap.`, [left.path, right.path], left, "Compare ownership before merging or linking."));
      }
    }
  }
  return sortFindings(results);
}

function sharedTagFindings(subject: NoteRecord, notes: Map<string, NoteRecord>, limit: number): ReviewFinding[] {
  return [...notes.values()].filter((note) => note.path !== subject.path && note.tags.some((tag) => subject.tags.includes(tag)))
    .sort((left, right) => compareVaultPaths(left.path, right.path)).slice(0, limit)
    .map((note) => finding("shared-tag", "info", `${note.path} shares approved tags with ${subject.path}.`, [subject.path, note.path], note, "Use only if it strengthens the current note's context."));
}

function finding(category: string, severity: ReviewSeverity, summary: string, paths: string[], note: NoteRecord, recommendation: string): ReviewFinding {
  return { category, severity, summary, paths, evidence: [{ path: note.path, detail: summary, excerpt: excerpt(note.body) }], recommendation };
}

function excerpt(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= EXCERPT_LIMIT ? compact : `${compact.slice(0, EXCERPT_LIMIT - 1)}…`;
}

function readStrings(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function boundedLimit(value?: number): number {
  return Math.min(Math.max(value ?? 10, 1), 50);
}

function countBySeverity(items: ReviewFinding[]): Record<ReviewSeverity, number> {
  return items.reduce<Record<ReviewSeverity, number>>((counts, item) => ({ ...counts, [item.severity]: counts[item.severity] + 1 }), { high: 0, medium: 0, low: 0, info: 0 });
}

function sortFindings(items: ReviewFinding[]): ReviewFinding[] {
  const rank: Record<ReviewSeverity, number> = { high: 0, medium: 1, low: 2, info: 3 };
  return [...items].sort((left, right) => rank[left.severity] - rank[right.severity] || left.category.localeCompare(right.category) || left.paths.join("\0").localeCompare(right.paths.join("\0")));
}
