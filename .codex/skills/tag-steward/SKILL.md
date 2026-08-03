---
name: "tag-steward"
description: "Project-local skill for validating topical tags against the dreamers-note approved tag list, rejecting lifecycle or kind tags, suggesting existing approved alternatives, and proposing new topical tags for user approval before any note is retagged."
---

# tag-steward

## Purpose

Validate topical tags against the approved list and propose new topical tags when they are worth adding.

## Inputs

- Candidate tags.
- Note excerpts or paths that motivated the tags.
- Vault path from ignored `config/vault.local.json` or the active MCP session when note context is needed.
- Approved tags from `taxonomy/approved-tags.md`.

## Allowed Paths

- `taxonomy/approved-tags.md` in `dreamers-note`.
- Selected vault notes when context is needed.

## Forbidden Actions

- Do not apply tags that are not approved.
- Do not create lifecycle, kind, queue, or review tags.
- Do not tag notes just because a word appears once.

## Phases

1. Collect candidate tags and the excerpts or note paths that motivated them.
2. Call agent: tag-steward to compare candidates against `taxonomy/approved-tags.md`.
3. Separate approved tags, rejected tags, and genuinely useful new-tag proposals.
4. Verify that every approved tag already exists in the approved list.
5. Report decisions in chat and ask before adding any new tag.

## Agent Calls

- Call agent: tag-steward for vocabulary validation and tag-sprawl checks.

## Output Format

Report approved tags, rejected tags, suggested existing alternatives, and new-tag proposals in chat.

## Review Expectations

New tags require user approval before they are added to the approved tag list or applied to notes.
