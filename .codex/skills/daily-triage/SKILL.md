---
name: "daily-triage"
description: "Project-local skill for processing every daily note in the configured cyborg Obsidian vault inbox by extracting durable project, knowledge, source, or people notes, applying only approved topical tags, proposing new tags separately, and archiving processed daily notes after approved extraction is visible in Git status or diff."
---

# daily-triage

## Purpose

Extract useful pieces from all inbox daily notes into project, knowledge, people, source, or archive actions, then archive each processed daily note after approved extraction is complete.

## Inputs

- Daily notes discovered automatically under `00-inbox/daily-notes`.
- Vault path from `/home/cjstorrs/projects/dreamers-note/config/vault.json`.
- Approved topical tags from `taxonomy/approved-tags.md`.
- Optional user guidance about destination projects or topics.
- Optional user guidance to narrow scope, but do not ask for paths when no scope is provided.

## Allowed Paths

- All current daily notes in the configured vault inbox, or a narrower user-specified daily-note scope.
- Project, knowledge, people, source, and archive destinations in the vault.
- Framework taxonomy and templates in `dreamers-note`.
- Runtime proposal state and MCP resources in `dreamers-note`.

## Forbidden Actions

- Do not delete raw daily notes.
- Do not archive unread or unprocessed daily notes.
- Do not tag every passing mention.
- Do not apply unapproved tags.
- Do not overwrite existing notes without preserving reviewable diff context.

## Phases

1. Discover all Markdown daily notes under the configured vault's `00-inbox/daily-notes` directory, unless the user explicitly narrows scope, and read only those notes.
2. Run the deterministic dry-run helper from `/home/cjstorrs/projects/dreamers-note`: `python3 scripts/propose-daily-triage.py`. Pass note paths only when the user narrowed scope. The helper reads the vault path from `config/vault.json` unless `--vault` is explicitly provided.
3. Use `context_pack` profile `triage` plus `read_note` to gather cited destination candidates, source backlinks, approved tags, and open questions for each extracted item.
4. Call agent: triage only for judgment-heavy extraction that the helper cannot infer from the selected note context.
5. Call agent: tag-steward with candidate topical tags and source excerpts.
6. Call agent: librarian for destination checks, existing-note matches, and collision risks.
7. Draft bundled `proposal_create` records for the extraction set. Related extraction and archive steps should share one bundle ID while preserving per-proposal approval, dependencies, blockers, and apply status.
8. Run the helper with `--archive` for the same scope to confirm archive readiness, then keep archive moves as separate proposals that depend on the extraction proposals. Archive each processed daily note under `99-archive/daily-notes/` only after extracted material exists in durable destinations and is visible in Git status or diff.
9. Report the helper output plus any MCP and agent refinements as the chat-first proposal, including source excerpts, destinations, approved tags, new-tag proposals, backlinks, bundle structure, and archive readiness.
10. If the MCP server is unavailable, report that dependency problem and fall back only to the existing helper-driven manual proposal workflow. Do not silently mutate the vault.
11. Apply only user-approved extraction and archive proposals on a Git branch.
12. Verify the approved tags, source backlinks, destination paths, bundle dependencies, and Git status or diff after apply.

## Placement Rules

- Treat `knowledge` and `area` daily-note fragments as durable topical knowledge notes.
- Prefer `## area: <main>/<sub>/<note-title>` in daily notes when the knowledge destination is known.
- Prefer `## project: <main>/<sub>/<note-title>` and `## person: <main>/<sub>/<note-title>` when those destinations are known.
- Legacy `## knowledge: <note-title>` fragments are allowed, but the fallback destination is `02-knowledge/uncategorized/general/<note-title>.md` and should be refined by librarian review.
- Do not create or target `02-areas` or `03-knowledge`.
- Family notes belong under `04-people/family/<sub>/`, not under `02-knowledge/family/`.
- Do not nest project, knowledge, or people notes deeper than `<root>/<main>/<sub>/<note-name>.md`.

## Agent Calls

- Call agent: triage for extraction and classification.
- Call agent: tag-steward for approved topical tag validation.
- Call agent: librarian for destination and existing-note checks.

## Output Format

Report a chat-first proposal with source excerpts, proposed destinations, approved tags, unapproved tag proposals, backlinks to each source daily note, bundle IDs, proposal dependencies, and archive readiness for processed daily notes. Apply approved extraction and archive changes on a Git branch.

## Review Expectations

The user reviews the chat proposal first, then reviews Git status or diff before merge. A daily note is archived only when the reviewed change set shows the extracted material in durable destinations and the archive move, and the archive proposal should remain blocked until those extraction proposals apply.
