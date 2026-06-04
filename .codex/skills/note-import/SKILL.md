---
name: "note-import"
description: "Project-local skill for importing an existing Markdown or text file into the configured cyborg Obsidian vault by reading the file, choosing the right project, knowledge, source, people, or other vault destination, applying only approved topical tags, and preserving the original source file unless deletion is explicitly requested."
---

# note-import

## Purpose

Import one or a small number of existing files directly into the configured Obsidian vault when the user wants the AI to choose the correct durable location.

## Inputs

- Source path from the user, such as `~/Desktop/linux.md`.
- Optional user hints about destination, title, tags, or whether the source should remain outside the vault.
- Vault path from `<local-home>/projects/dreamers-note/config/vault.json`.
- Naming and folder rules from `<local-home>/projects/dreamers-note/docs/conventions.md`.
- Approved topical tags from `<local-home>/projects/dreamers-note/taxonomy/approved-tags.md`.

## Allowed Paths

- Read the user-selected source file or files.
- Read framework config, conventions, templates, taxonomy, and indexes in `dreamers-note`.
- Read relevant existing vault notes to avoid duplicate destinations and choose useful links.
- Create or update only the reviewed destination note in the configured vault.

## Forbidden Actions

- Do not delete, move, or rewrite the original source file unless the user explicitly asks after the import target is clear.
- Do not overwrite or merge into an existing vault note without explicit approval.
- Do not import `.obsidian` internals, generated cache files, or secrets.
- Do not apply tags outside `taxonomy/approved-tags.md`; report useful missing tags in chat as proposals.
- Do not create lifecycle, queue, kind, or review tags.
- Do not batch-normalize unrelated vault content. Use `vault-normalization` for broad remaps.
- Do not target `02-areas` or `03-knowledge`; durable topical notes belong under `02-knowledge/<main>/<sub>/`.

## Phases

1. Resolve the source path, confirm it exists, and read the file content before deciding placement.
2. Read the vault config, conventions, and approved tags. Check `git -C <vault-path> status --short` and note unrelated existing changes without touching them.
3. Classify the file:
   - active project work goes to `01-projects/<main>/<sub>/<note-name>.md`
   - reusable owned knowledge goes to `02-knowledge/<main>/<sub>/<note-name>.md`
   - external source notes go to `03-sources` following the existing local folder pattern when clear
   - people and relationship notes go to `04-people/<main>/<sub>/<note-name>.md`
   - assets, templates, system files, and archive material stay in their matching top-level roots
4. Choose a lowercase kebab-case filename from the title or source filename. Avoid vague names such as `notes.md`, `misc.md`, `ideas.md`, and `important.md`.
5. Search the likely target folder and related vault notes for collisions, duplicates, and useful links. If a close existing note should receive the content, stop and ask before merging.
6. Decide approved topical tags, proposed new tags, links to add, and whether light cleanup is needed. Preserve useful source formatting; do not invent frontmatter beyond approved topical tags.
7. If confidence is high, there is no collision, and the user explicitly asked to add/import the file, create the destination note directly. Otherwise, report the proposed import and wait for approval.
8. Never delete the original source by default. If the user asked to move instead of copy, delete the source only after the vault destination is written, verified, and the user approved deletion.
9. Verify with `git -C <vault-path> status --short` and the relevant diff. Report the source path, destination path, approved tags, proposed tags, links added, whether the original source remains, and any unresolved questions.

## Agent Calls

- Call agent: tag-steward when useful topical tags are unclear or missing from the approved list.
- Call agent: librarian when destination choice, duplicate detection, merge-vs-new-note decisions, or link targets remain ambiguous after reading the source file and nearby vault context.
- No agent call is needed for a clear single-file import with high-confidence placement and approved tags.

## Output Format

For a proposal or completed import, report:

1. Source: original path and whether it remains in place.
2. Destination: vault-relative path, collision status, and confidence.
3. Classification: project, knowledge, source, people, asset, template, system, or archive.
4. Tags and links: approved tags applied, proposed new tags not applied, and links added or recommended.
5. Review: vault Git status summary, changed files, and any approval needed.

## Review Expectations

Single-file imports are moderate-risk vault edits. Prefer a vault Git branch for imports, preserve the original source file, and inspect the diff before treating the note as filed.
