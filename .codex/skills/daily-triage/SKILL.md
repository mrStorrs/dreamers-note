---
name: "daily-triage"
description: "Project-local skill for processing every daily note in the configured cyborg Obsidian vault inbox by extracting durable project, knowledge, source, or people notes, applying only approved topical tags, proposing new tags separately, and archiving processed daily notes after approved extraction is visible in Git status or diff."
---

# daily-triage

## Purpose

Extract useful pieces from all inbox daily notes into project, knowledge, people, source, or archive actions, then archive each processed daily note after approved extraction is complete.

## Inputs

- Daily notes discovered automatically under `00-inbox/daily-notes`.
- Vault path from `<local-home>/projects/dreamers-note/config/vault.json`.
- Workflow policy from `workflow_policy` with `workflow: "triage"` or, if needed, the `dreamers-note://workflow-policy/triage` MCP resource.
- Runtime bootstrap from `workflow_ready` when the MCP session is cold or readiness is unknown.
- Optional user guidance about destination projects or topics.
- Optional user guidance to narrow scope, but do not ask for paths when no scope is provided.

## Allowed Paths

- All current daily notes in the configured vault inbox, or a narrower user-specified daily-note scope.
- Project, knowledge, people, source, and archive destinations in the vault.
- Framework templates in `dreamers-note`, but use the `workflow_policy` MCP tool for placement and tag rules. If you inspect `dreamers-note://workflow-policy/triage`, do it through MCP resource reads only and never through shell file reads.
- Runtime proposal state and MCP resources in `dreamers-note`.

## Forbidden Actions

- Do not delete raw daily notes.
- Do not archive unread or unprocessed daily notes.
- Do not tag every passing mention.
- Do not apply unapproved tags.
- Do not overwrite existing notes without preserving reviewable diff context.

## Phases

1. Discover all Markdown daily notes under the configured vault's `00-inbox/daily-notes` directory, unless the user explicitly narrows scope, and read only those notes.
2. Run the deterministic dry-run helper from `<local-home>/projects/dreamers-note`: `python3 scripts/propose-daily-triage.py`. Pass note paths only when the user narrowed scope. The helper reads the vault path from `config/vault.json` unless `--vault` is explicitly provided.
3. When the session is cold or runtime readiness is unknown, call `workflow_ready`.
4. Use `context_pack` profile `triage`, `read_note`, and `workflow_policy` with `workflow: "triage"` to gather cited destination candidates, source backlinks, approved tags, and open questions for each extracted item.
5. Call agent: triage only for judgment-heavy extraction that the helper cannot infer from the selected note context.
6. Call agent: tag-steward with candidate topical tags and source excerpts.
7. Call agent: librarian for destination checks, existing-note matches, and collision risks.
8. Draft bundled proposals for the extraction set. Use `proposal_create_note` for extracted note content and reserve raw `proposal_create` for archive moves or explicit external delete proposals only. Related extraction and archive steps should share one bundle ID while preserving per-proposal approval, dependencies, blockers, and apply status.
9. Run the helper with `--archive` for the same scope to confirm archive readiness, then keep archive moves as separate proposals that depend on the extraction proposals. Archive each processed daily note under `99-archive/daily-notes/` only after extracted material exists in durable destinations and is visible in Git status or diff.
10. Report the helper output plus any MCP and agent refinements as the chat-first proposal, including source excerpts, destinations, approved tags, new-tag proposals, backlinks, bundle structure, and archive readiness.
11. If the MCP server is unavailable, report that dependency problem and fall back only to the existing helper-driven manual proposal workflow. Do not silently mutate the vault.
12. Apply only user-approved extraction and archive proposals on a Git branch.
13. Verify the approved tags, source backlinks, destination paths, bundle dependencies, and Git status or diff after apply.

## Placement Rules

- Treat `knowledge` and `area` daily-note fragments as durable topical knowledge notes.
- Prefer `## area: <main>/<sub>/<note-title>` in daily notes when the knowledge destination is known.
- Prefer `## project: <main>/<sub>/<note-title>` and `## person: <main>/<sub>/<note-title>` when those destinations are known.
- Legacy `## knowledge: <note-title>` fragments are allowed, but the fallback destination is `02-knowledge/uncategorized/general/<note-title>.md` and should be refined by librarian review.
- Do not create or target `02-areas` or `03-knowledge`.
- Family notes belong under `04-people/family/<sub>/`, not under `02-knowledge/family/`.
- Do not nest project, knowledge, or people notes deeper than `<root>/<main>/<sub>/<note-name>.md`.

## Note Body Style

- When creating extracted note bodies, do not start with an H1 or H2 that repeats the note title or filename. Obsidian already shows the title from the filename; start with useful links, metadata, source context, or the first meaningful section instead.
- Keep a title-like heading only when it adds distinct context not already present in the note name.
- A classified folder homepage uses `_<folder-name>.md`. Its generated lead summarizes the folder's subject matter from substantive owner-note prose or current child topics; it never explains that the file is an index or homepage. Generated `## Subfolders` and `## Pages` may be refreshed, but `## Notes` is human-owned and must be preserved unless the user explicitly asks otherwise.

## Agent Calls

- Call agent: triage for extraction and classification.
- Call agent: tag-steward for approved topical tag validation.
- Call agent: librarian for destination and existing-note checks.

## Output Format

Report a chat-first proposal with source excerpts, proposed destinations, approved tags, unapproved tag proposals, backlinks to each source daily note, bundle IDs, proposal dependencies, and archive readiness for processed daily notes. Apply approved extraction and archive changes on a Git branch.

## Review Expectations

The user reviews the chat proposal first, then reviews Git status or diff before merge. A daily note is archived only when the reviewed change set shows the extracted material in durable destinations and the archive move, and the archive proposal should remain blocked until those extraction proposals apply.
