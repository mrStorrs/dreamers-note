# daily-triage

## Purpose

Extract useful pieces from selected daily notes into projects, knowledge notes, sources, or archive actions, then archive each processed daily note after approved extraction is complete.

## Inputs

- One or more explicit daily note paths.
- Approved topical tags from `taxonomy/approved-tags.md`.
- Optional user guidance about destination projects or topics.

## Allowed Paths

- Selected daily notes in `<local-home>/obsidian/cyborg`.
- Project, knowledge, source, and archive destinations in the vault.
- Framework taxonomy and templates in `dreamers-note`.

## Forbidden Actions

- Do not delete raw daily notes.
- Do not tag every passing mention.
- Do not apply unapproved tags.
- Do not overwrite existing notes without preserving reviewable diff context.

## Phases

1. Select explicit daily note paths and read only those notes.
2. Call agent: triage to identify meaningful fragments and classify each as project, knowledge, source, person, archive-only, or ignore.
3. Call agent: tag-steward with candidate topical tags and source excerpts.
4. Call agent: librarian for destination checks, existing-note matches, and collision risks.
5. Report a chat-first proposal with source excerpts, destinations, approved tags, new-tag proposals, and risks.
6. Apply only user-approved changes on a Git branch.
7. Verify agent work by checking approved tags, source backlinks, destination paths, and `git diff`.
8. Archive each processed daily note only after the extracted material exists in its durable destination and the user approves the archive step.

## Agent Calls

- Call agent: triage for extraction and classification.
- Call agent: tag-steward for approved topical tag validation.
- Call agent: librarian for destination and existing-note checks.

## Output Format

Report a chat-first proposal with source excerpts, proposed destinations, approved tags, unapproved tag proposals, and archive actions for processed daily notes. Apply approved changes on a Git branch.

## Review Expectations

The user reviews the chat proposal first, then reviews `git diff` before merge. A daily note is archived only when the diff shows the extracted material in durable destinations and the archive move is included in the approved change set.
