---
name: "daily-triage"
description: "Project-local skill for processing selected daily notes in the configured cyborg Obsidian vault by extracting durable project, knowledge, source, or people notes, applying only approved topical tags, proposing new tags separately, and archiving processed daily notes after approved extraction is visible in Git diff."
---

# daily-triage

## Purpose

Extract useful pieces from selected daily notes into project, knowledge, people, source, or archive actions, then archive each processed daily note after approved extraction is complete.

## Inputs

- One or more explicit daily note paths, normally under `00-inbox/daily-notes`.
- Vault path from `<local-home>/projects/dreamers-note/config/vault.json`.
- Approved topical tags from `taxonomy/approved-tags.md`.
- Optional user guidance about destination projects or topics.
- Optional archive request after extraction has been proposed or applied.

## Allowed Paths

- Selected daily notes in the configured vault.
- Project, knowledge, people, source, and archive destinations in the vault.
- Framework taxonomy and templates in `dreamers-note`.

## Forbidden Actions

- Do not delete raw daily notes.
- Do not tag every passing mention.
- Do not apply unapproved tags.
- Do not overwrite existing notes without preserving reviewable diff context.

## Phases

1. Select explicit daily note paths and read only those notes.
2. Run the deterministic dry-run helper from `<local-home>/projects/dreamers-note`: `python3 scripts/propose-daily-triage.py <daily-note-paths>`. The helper reads the vault path from `config/vault.json` unless `--vault` is explicitly provided.
3. Call agent: triage only for judgment-heavy extraction that the helper cannot infer from the selected note context.
4. Call agent: tag-steward with candidate topical tags and source excerpts.
5. Call agent: librarian for destination checks, existing-note matches, and collision risks.
6. Report the helper output plus any agent refinements as the chat-first proposal, including source excerpts, destinations, approved tags, new-tag proposals, backlinks, and risks.
7. Apply only user-approved extraction changes on a Git branch.
8. Verify agent work by checking approved tags, source backlinks, destination paths, and `git diff`.
9. If archive behavior is requested, re-run the helper with `--archive`. Archive each processed daily note only after extracted material exists in durable destinations and is visible in Git diff.

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

Report a chat-first proposal with source excerpts, proposed destinations, approved tags, unapproved tag proposals, backlinks to the source daily note, and archive readiness for processed daily notes. Apply approved changes on a Git branch.

## Review Expectations

The user reviews the chat proposal first, then reviews `git diff` before merge. A daily note is archived only when the diff shows the extracted material in durable destinations and the archive move is included in the approved change set.
