---
name: "note-add"
description: "Project-local skill for adding user-provided command text, bullet items, facts, decisions, or follow-ups into the configured cyborg Obsidian vault by first searching for relevant existing notes to update with approved topical tags and backlinks, then proposing a new durable destination only when no suitable note exists. Use from the dreamers-note project when the user asks to add, file, place, remember, or record new note content and wants AI-chosen context rather than raw daily capture or file import."
---

# note-add

## Purpose

Place user-provided note content into the configured vault with a proposal-first workflow. Prefer updating a relevant existing note; create a new project, knowledge, source, or people note only when no suitable existing note exists.

## Inputs

- User-provided command text, bullets, facts, decisions, links, pasted fragments, or follow-ups.
- Optional user hints about destination, related people/projects/topics, tags, or urgency.
- Vault path from `/home/cjstorrs/projects/dreamers-note/config/vault.json`.
- Naming and folder rules from `/home/cjstorrs/projects/dreamers-note/docs/conventions.md`.
- Approved topical tags from `/home/cjstorrs/projects/dreamers-note/taxonomy/approved-tags.md`.

## Allowed Paths

- Read framework config, conventions, templates, taxonomy, agents, and indexes in `dreamers-note`.
- Read relevant existing vault notes to find merge targets, duplicate context, approved tags, and useful links.
- After explicit user approval, update only the approved existing destination note or create only the approved new destination note.
- Read Git status and diff for the configured vault before and after approved edits.

## Forbidden Actions

- Do not edit the vault before reporting the proposed destination, context, tags, links, and insertion text in chat.
- Do not apply changes until the user approves the specific proposal.
- Do not merge into an existing note when the relationship is weak, speculative, or only keyword-based.
- Do not apply tags outside `taxonomy/approved-tags.md`; report useful missing tags as proposals.
- Do not create lifecycle, queue, kind, or review tags.
- Do not batch-normalize unrelated vault content, archive daily notes, move files, or rewrite unrelated links.
- Do not target `02-areas` or `03-knowledge`; durable topical notes belong under `02-knowledge/<main>/<sub>/`.
- Do not put family notes under knowledge; family belongs under `04-people/family/<sub>/`.

## Phases

1. Parse the command into one or more note items. Preserve the user's wording when it carries meaning, and separate unrelated items instead of forcing one destination.
2. Read the vault config, conventions, and approved tags. Check `git -C <vault-path> status --short` and note unrelated existing changes without touching them.
3. Search for existing-note candidates before inventing a new path. Use topic terms, titles, headings, explicit names, existing tags, and likely folders across `01-projects`, `02-knowledge`, `03-sources`, and `04-people`.
4. Read the strongest candidate notes and nearby index or folder context. Prefer an existing note only when it already owns the topic, project, person, source, or decision context and the insertion section is clear.
5. If updating an existing note fits, choose the exact section or heading, the insertion text, approved tags to add or preserve, and wikilinks that create useful backlinks to related notes. Do not edit related notes just to create reciprocal links unless that is part of the approved proposal.
6. If no suitable existing note fits, choose a new destination using the placement rules below. Pick a lowercase kebab-case filename from the note's durable subject, not from vague words such as `notes`, `misc`, `ideas`, or `important`.
7. Validate tags against the approved list. Apply only approved topical tags in the proposal; list missing useful tags separately as new-tag proposals.
8. Report a chat-first proposal for each item. Include the destination, whether it is an existing-note update or new note, the context/section, draft text, approved tags, proposed tags, links/backlinks, confidence, and unresolved questions.
9. Stop after the proposal and wait for user approval. Approval must identify the proposal or destination being accepted before any vault file is edited.
10. After approval, apply only the approved change set on a vault Git branch. Keep the edit narrow and preserve existing note style.
11. Verify with `git -C <vault-path> status --short` and the relevant diff. Report changed files, tags, links, and any unresolved questions.

## Placement Rules

- Use an existing note when the content strengthens that note's established subject and will be findable there later.
- Use `01-projects/<main>/<sub>/<note-name>.md` for active project work, decisions, plans, and follow-ups tied to an active outcome.
- Use `02-knowledge/<main>/<sub>/<note-name>.md` for reusable owned knowledge, concepts, practices, recipes, references-to-self, and durable topical material.
- Use `03-sources` only for external source notes, quotes, publication notes, or source-specific summaries following the existing local folder pattern when clear.
- Use `04-people/<main>/<sub>/<note-name>.md` for people, organizations, relationship context, and family notes.
- Keep project, knowledge, and people notes exactly two classification directories below the root: `<root>/<main>/<sub>/<note-name>.md`.
- If multiple unrelated items point to different homes, propose separate destinations.

## Agent Calls

- Call agent: librarian when existing-note match, duplicate risk, merge-vs-new choice, destination path, collision risk, or link target selection remains ambiguous after reading candidate notes.
- Call agent: tag-steward when useful topical tags are unclear, missing from the approved list, or at risk of tag sprawl.
- No agent call is needed for a clear single-item proposal with a strong existing match and approved tags.

## Output Format

For a proposal, report:

1. Item: the parsed content being placed.
2. Destination: existing note and insertion section, or proposed new vault-relative path.
3. Context: why this location fits, nearby note context, and confidence.
4. Draft change: exact text or section outline to add.
5. Tags and links: approved tags to apply or preserve, proposed new tags not applied, and wikilinks/backlinks to add.
6. Approval needed: the specific edit that must be approved before mutation.

For an approved edit, report the destination path, changed section, approved tags applied, links added, vault Git status summary, and any diff review notes.

## Review Expectations

Note placement is moderate-risk because it can merge content into durable notes. Always show the destination/context proposal first, apply only approved changes, and inspect the vault Git diff before treating the note as filed.
