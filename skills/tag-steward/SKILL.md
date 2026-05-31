# tag-steward

## Purpose

Validate topical tags against the approved list and propose new topical tags when they are worth adding.

## Inputs

- Candidate tags.
- Note excerpts or paths that motivated the tags.
- Approved tags from `taxonomy/approved-tags.md`.

## Allowed Paths

- `taxonomy/approved-tags.md` in `dreamers-note`.
- Selected vault notes when context is needed.

## Forbidden Actions

- Do not apply tags that are not approved.
- Do not create lifecycle, kind, queue, or review tags.
- Do not tag notes just because a word appears once.

## Output Format

Report approved tags, rejected tags, suggested existing alternatives, and new-tag proposals in chat.

## Review Expectations

New tags require user approval before they are added to the approved tag list or applied to notes.
