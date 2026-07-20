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
- MCP tools and resources: `workflow_ready`, `context_pack`, `workflow_policy`, `proposal_create_note`, `proposal_read`, and `dreamers-note://workflow-policy/import`.

## Allowed Paths

- Read the user-selected source file or files.
- Read framework config, templates, and indexes in `dreamers-note`, but use the `workflow_policy` MCP tool for placement and tag rules. If you inspect `dreamers-note://workflow-policy/import`, do it through MCP resource reads only and never through shell file reads.
- Read relevant existing vault notes to avoid duplicate destinations and choose useful links.
- Create or update only the reviewed destination note in the configured vault through the proposal queue.

## Forbidden Actions

- Do not delete, move, or rewrite the original source file unless the user explicitly asks after the import target is clear.
- Do not overwrite or merge into an existing vault note without explicit approval.
- Do not import `.obsidian` internals, generated cache files, or secrets.
- Do not apply tags outside the approved MCP workflow policy; report useful missing tags in chat as proposals.
- Do not create lifecycle, queue, kind, or review tags.
- Do not batch-normalize unrelated vault content. Use `vault-normalization` for broad remaps.
- Do not target `02-areas` or `03-knowledge`; durable topical notes belong under `02-knowledge/<main>/<sub>/`.
- Do not use ad hoc vault shell scans when `context_pack` returns `low-signal`; use `fallbackSuggestions`, conventions, and templates instead.
- Do not inspect the vault just to verify `03-sources`, fallback roots, or template presence when low-signal guidance already supplies that fallback.
- Do not use repo docs, conventions, templates, or approved-tag files as proposal evidence. They justify the proposal but are not evidence inputs.

## Phases

1. Resolve the source path from the current user request. If the user did not explicitly provide a source path in this request, stop and ask for it.
2. Validate the source path before reading: refuse symlinks, non-regular files, binary files, unexpectedly resolved paths, excluded or private paths, unreadable files, and oversized files unless the user explicitly approves a narrower or safer path.
3. Read the vault config, call `workflow_ready` when the session is cold or runtime readiness is unknown, then call `workflow_policy` with `workflow: "import"`, and read MCP guidance. Check `git -C <vault-path> status --short` and note unrelated existing changes without touching them.
4. Use `context_pack` profile `import` to search for existing-note candidates, collision risks, and useful links before deciding placement.
5. If `context_pack.retrievalSignal.state` is `low-signal`, do not fall back to ad hoc vault shell scans. Use `fallbackSuggestions`, conventions, and templates to choose the most plausible import shape first. If a fallback suggestion is marked as the default choice, trust it directly without extra vault scans to verify roots or templates.
6. Classify the file:
   - active project work goes to `01-projects/<main>/<sub>/<note-name>.md`
   - reusable owned knowledge goes to `02-knowledge/<main>/<sub>/<note-name>.md`
   - external source notes go to `03-sources` following the existing local folder pattern when clear
   - people and relationship notes go to `04-people/<main>/<sub>/<note-name>.md`
   - assets, templates, system files, and archive material stay in their matching top-level roots
7. Choose a lowercase kebab-case filename from the title or source filename. Avoid vague names such as `notes.md`, `misc.md`, `ideas.md`, and `important.md`.
8. Decide approved topical tags, proposed new tags, links to add, and whether light cleanup is needed. Preserve useful source formatting; do not invent frontmatter beyond approved topical tags.
9. Draft the import with `proposal_create_note`, using the validated external file as explicit evidence and keeping the original source file unchanged. Pass the vault-relative `path`, explicit `mode`, and full note `body` for the destination note. Do not put external source paths in the note path, do not use external files in `sourceChunkIds`, and do not use raw `proposal_create` unless you are creating a separate explicit external `delete-file` proposal. Treat conventions, templates, and approved tags as rationale only, not proposal evidence. Use `proposal_read` to inspect the bounded evidence, diff preview, and validation state before asking for approval.
10. If the user explicitly wants the original source deleted after import, create a separate proposal for that deletion. Do not combine source deletion into the main import proposal.
11. Report the chat-first proposal with source path, destination, approved tags, proposed new tags, links, confidence, and whether the original source remains. Stop after the proposal and wait for user approval.
12. If the MCP server is unavailable, report that dependency problem and fall back only to the existing manual or script proposal workflow. Do not silently write to the vault.
13. After approval, authorize and apply only the approved proposal set, then verify with `git -C <vault-path> status --short` and the relevant diff. Report the source path, destination path, approved tags, proposed tags, links added, whether the original source remains, and any unresolved questions.

## Note Body Style

- When creating a new imported note, do not start the body with an H1 or H2 that repeats the note title or filename. Obsidian already shows the title from the filename; start with useful links, metadata, or the first meaningful section instead.
- Keep a title-like heading only when it adds distinct context not already present in the note name or source material.
- A classified folder homepage uses `_<folder-name>.md`. Its generated lead summarizes the folder's subject matter from substantive owner-note prose or current child topics; it never explains that the file is an index or homepage. Generated `## Subfolders` and `## Pages` may be refreshed, but `## Notes` is human-owned and must be preserved unless the user explicitly asks otherwise.

## Agent Calls

- Call agent: tag-steward when useful topical tags are unclear or missing from the approved list.
- Call agent: librarian when destination choice, duplicate detection, merge-vs-new-note decisions, or link targets remain ambiguous after reading the source file and nearby vault context.
- No agent call is needed for a clear single-file import with high-confidence placement and approved tags.

## Output Format

For a proposal or completed import, report:

1. Source: original path and whether it remains in place.
2. Destination: vault-relative path, collision status, and confidence.
3. Classification: project, knowledge, source, people, asset, template, system, or archive.
4. Proposal: `proposal_create_note` / `proposal_read` status, whether a separate proposal is needed for source deletion, and any unresolved questions.
5. Tags and links: approved tags applied, proposed new tags not applied, and links added or recommended.
6. Review: vault Git status summary, changed files, and any approval needed.

## Review Expectations

Single-file imports are moderate-risk vault edits. Prefer a vault Git branch for imports, preserve the original source file by default, keep deletion as a separate proposal, and inspect the diff before treating the note as filed.
