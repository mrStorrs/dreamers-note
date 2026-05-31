# daily-triage

## Purpose

Extract useful pieces from selected daily notes into projects, knowledge notes, sources, or archive actions.

## Inputs

- One or more explicit daily note paths.
- Approved topical tags from `taxonomy/approved-tags.md`.
- Optional user guidance about destination projects or topics.

## Allowed Paths

- Selected daily notes in `/home/cjstorrs/obsidian/cyborg`.
- Project, knowledge, source, and archive destinations in the vault.
- Framework taxonomy and templates in `dreamers-note`.

## Forbidden Actions

- Do not delete raw daily notes.
- Do not tag every passing mention.
- Do not apply unapproved tags.
- Do not overwrite existing notes without preserving reviewable diff context.

## Output Format

Report a chat-first proposal with source excerpts, proposed destinations, approved tags, unapproved tag proposals, and archive recommendations. Apply approved changes on a Git branch.

## Review Expectations

The user reviews the chat proposal first, then reviews `git diff` before merge.
