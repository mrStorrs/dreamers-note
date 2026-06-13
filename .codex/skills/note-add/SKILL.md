---
name: "note-add"
description: "Project-local skill for adding user-provided command text, bullet items, facts, decisions, or follow-ups into the configured cyborg Obsidian vault with an MCP-backed place-first proposal workflow. It searches existing notes first with cited context, proposes a durable existing-note update or new note, and uses daily-note fallback only when placement is ambiguous or explicitly requested."
---

# note-add

## Purpose

Place user-provided note content into the configured vault with an MCP-backed, proposal-first workflow. Prefer updating a relevant existing note; create a new project, knowledge, source, or people note only when no suitable existing note exists.

## Inputs

- User-provided command text, bullets, facts, decisions, links, pasted fragments, or follow-ups.
- Optional user hints about destination, related people/projects/topics, tags, urgency, or explicit daily-note fallback.
- Vault path from `<local-home>/projects/dreamers-note/config/vault.json`.
- Naming and folder rules from `<local-home>/projects/dreamers-note/docs/conventions.md`.
- Approved topical tags from `<local-home>/projects/dreamers-note/taxonomy/approved-tags.md`.
- MCP tools and resources: `context_pack`, `read_note`, `proposal_create`, `proposal_read`, `dreamers-note://approved-tags`, and `dreamers-note://conventions`.

## Allowed Paths

- Read framework config, conventions, templates, taxonomy, agents, and runtime proposal state in `dreamers-note`.
- Read relevant existing vault notes to find merge targets, duplicate context, approved tags, and useful links.
- After explicit user approval, update only the approved existing destination note or create only the approved new destination note.
- Read Git status and diff for the configured vault before and after approved edits.

## Forbidden Actions

- Do not edit the vault before reporting the proposed destination, context, tags, links, placement scorecard, and insertion text in chat.
- Do not apply changes until the user approves the specific proposal.
- Do not merge into an existing note when the relationship is weak, speculative, or only keyword-based.
- Do not apply tags outside `taxonomy/approved-tags.md`; report useful missing tags as proposals.
- Do not create lifecycle, queue, kind, or review tags.
- Do not batch-normalize unrelated vault content, archive daily notes, move files, or rewrite unrelated links.
- Do not target `02-areas` or `03-knowledge`; durable topical notes belong under `02-knowledge/<main>/<sub>/`.
- Do not put family notes under knowledge; family belongs under `04-people/family/<sub>/`.
- If the MCP server is unavailable, do not fall through to a silent direct edit. Use only the existing manual or script workflow that still preserves proposal-first review.

## Phases

1. Parse the command into one or more note items. Preserve the user's wording when it carries meaning, and separate unrelated items instead of forcing one destination.
2. Read the vault config, conventions, and approved tags. Check `git -C <vault-path> status --short` and note unrelated existing changes without touching them.
3. Search for existing-note candidates before inventing a new path. Use `context_pack` profile `place` to gather that evidence first, then use `read_note` for bounded follow-up excerpts when candidate ownership or insertion anchor still needs evidence.
4. If the MCP server is unavailable, report that dependency failure and fall back only to the existing manual or script workflow that still produces a proposal-first review step. Do not edit the vault directly in this fallback.
5. Prefer an existing note only when the note already owns the subject and the insertion section is clear. Otherwise choose a new durable destination using the placement rules below.
6. Build a placement scorecard for each proposal: subject ownership, insertion anchor, naming fit, tag fit, link fit, ambiguity, fallback reason, confidence, and unresolved questions.
7. Validate tags against the approved list. Apply only approved topical tags in the proposal; list missing useful tags separately as new-tag proposals.
8. Use `proposal_create` to draft the runtime proposal metadata and `proposal_read` to inspect the final proposal, bounded evidence, and diff preview before asking for approval.
9. Report a chat-first proposal for each item. Include the destination, whether it is an existing-note update or new note, the context/section, draft text, approved tags, proposed tags, links/backlinks, placement scorecard, confidence, and unresolved questions.
10. Stop after the proposal and wait for user approval. Approval must identify the proposal or destination being accepted before any vault file is edited.
11. After approval, request the one-use apply authorization, apply only the approved proposal, then verify with `git -C <vault-path> status --short` and the relevant diff. Report changed files, tags, links, and review guidance.

## Placement Rules

- Use an existing note when the content strengthens that note's established subject and will be findable there later.
- Use `01-projects/<main>/<sub>/<note-name>.md` for active project work, decisions, plans, and follow-ups tied to an active outcome.
- Use `02-knowledge/<main>/<sub>/<note-name>.md` for reusable owned knowledge, concepts, practices, recipes, references-to-self, and durable topical material.
- Use `03-sources` only for external source notes, quotes, publication notes, or source-specific summaries following the existing local folder pattern when clear.
- Use `04-people/<main>/<sub>/<note-name>.md` for people, organizations, relationship context, and family notes.
- Keep project, knowledge, and people notes exactly two classification directories below the root: `<root>/<main>/<sub>/<note-name>.md`.
- If multiple unrelated items point to different homes, propose separate destinations.
- Use a daily note only when the user explicitly asks for one or the placement remains ambiguous after cited MCP retrieval.

## Agent Calls

- Call agent: librarian when existing-note match, duplicate risk, merge-vs-new choice, destination path, collision risk, or link target selection remains ambiguous after MCP retrieval.
- Call agent: tag-steward when useful topical tags are unclear, missing from the approved list, or at risk of tag sprawl.
- No agent call is needed for a clear single-item proposal with a strong existing match and approved tags.

## Output Format

For a proposal, report:

1. Item: the parsed content being placed.
2. Destination: existing note and insertion section, or proposed new vault-relative path.
3. Context: why this location fits, nearby note context, and confidence.
4. Draft change: exact text or section outline to add.
5. Placement scorecard: subject ownership, insertion anchor, naming fit, tag fit, link fit, ambiguity, fallback reason, confidence, and unresolved questions.
6. Tags and links: approved tags to apply or preserve, proposed new tags not applied, and wikilinks/backlinks to add.
7. Approval needed: the specific edit that must be approved before mutation.

For an approved edit, report the destination path, changed section, approved tags applied, links added, vault Git status summary, and diff review notes.

## Review Expectations

Note placement is moderate-risk because it can merge content into durable notes. Always show the destination and placement scorecard first, keep the workflow proposal-first through `proposal_create` and `proposal_read`, and inspect the vault Git diff before treating the note as filed.
