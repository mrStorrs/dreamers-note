# daily-triage

## Purpose

Extract useful pieces from selected daily notes into projects, knowledge notes, sources, or archive actions, then archive each processed daily note after approved extraction is complete.

## Inputs

- One or more explicit daily note paths.
- Approved topical tags from `taxonomy/approved-tags.md`.
- Optional user guidance about destination projects or topics.
- Optional archive request after extraction has been proposed or applied.

## Allowed Paths

- Selected daily notes in `/home/cjstorrs/obsidian/cyborg`.
- Project, knowledge, source, and archive destinations in the vault.
- Framework taxonomy and templates in `dreamers-note`.

## Forbidden Actions

- Do not delete raw daily notes.
- Do not tag every passing mention.
- Do not apply unapproved tags.
- Do not overwrite existing notes without preserving reviewable diff context.

## Phases

1. Select explicit daily note paths and read only those notes.
2. Run the deterministic dry-run helper from `/home/cjstorrs/projects/dreamers-note`: `python3 scripts/propose-daily-triage.py --vault /home/cjstorrs/obsidian/cyborg <daily-note-paths>`.
3. Call agent: triage only for judgment-heavy extraction that the helper cannot infer from the selected note context.
4. Call agent: tag-steward with candidate topical tags and source excerpts.
5. Call agent: librarian for destination checks, existing-note matches, and collision risks.
6. Report the helper output plus any agent refinements as the chat-first proposal, including source excerpts, destinations, approved tags, new-tag proposals, backlinks, and risks.
7. Apply only user-approved extraction changes on a Git branch.
8. Verify agent work by checking approved tags, source backlinks, destination paths, and `git diff`.
9. If archive behavior is requested, re-run the helper with `--archive`. Archive each processed daily note only after extracted material exists in durable destinations and is visible in Git diff.

## Agent Calls

- Call agent: triage for extraction and classification.
- Call agent: tag-steward for approved topical tag validation.
- Call agent: librarian for destination and existing-note checks.

## Output Format

Report a chat-first proposal with source excerpts, proposed destinations, approved tags, unapproved tag proposals, backlinks to the source daily note, and archive readiness for processed daily notes. Apply approved changes on a Git branch.

## Review Expectations

The user reviews the chat proposal first, then reviews `git diff` before merge. A daily note is archived only when the diff shows the extracted material in durable destinations and the archive move is included in the approved change set.
