---
name: "daily-capture"
description: "Project-local skill for place-first quick capture in the configured cyborg Obsidian vault. It searches for an existing durable home first, preserves explicit daily-note append behavior, and records placement debt when ambiguity forces a daily fallback."
---

# daily-capture

## Purpose

Handle quick capture with a place-first, proposal-first workflow. Prefer a durable existing note or a new durable note when the destination is clear, but preserve explicit daily-note append when the user asks for it.

## Inputs

- User-provided raw text, bullets, links, or pasted fragments.
- Optional selected daily note path, normally `00-inbox/daily-notes/yyyy-mm-dd.md`.
- Vault path from `<local-home>/projects/dreamers-note/config/vault.json`.
- MCP tools and resources: `workflow_ready`, `context_pack`, `read_note`, `workflow_policy`, `proposal_create_note`, `proposal_read`, and `dreamers-note://workflow-policy/capture`.

## Allowed Paths

- Read the configured vault, relevant existing notes, and selected daily notes.
- Read framework templates and runtime proposal state in `dreamers-note`, but use the `workflow_policy` MCP tool for placement and tag rules. If you inspect `dreamers-note://workflow-policy/capture`, do it through MCP resource reads only and never through shell file reads.
- After explicit user approval, update only the approved durable destination note or daily note target.

## Forbidden Actions

- Do not move, split, archive, or delete content.
- Do not force durable placement when the user explicitly asked for a daily note append.
- Do not apply unapproved tags.
- Do not write workflow metadata, placement debt markers, or review comments into daily notes.
- Do not use ad hoc vault shell scans when `context_pack` returns `low-signal`; use `fallbackSuggestions`, conventions, and explicit user intent instead.
- Do not use repo docs, conventions, templates, or approved-tag files as proposal evidence. They justify the proposal but are not evidence inputs.
- If the MCP server is unavailable, do not fall through to a silent direct edit. Use only the existing manual or script workflow that still preserves proposal-first review.

## Phases

1. Parse whether the request is an explicit daily-note append, a place-first quick capture, or an ambiguous capture that may need fallback.
2. If the user names a daily note path or explicitly asks for a daily note, draft that daily-note proposal directly and do not force durable placement.
3. When the session is cold or runtime readiness is unknown, call `workflow_ready`.
4. Otherwise use `context_pack` profile `place` to search existing notes first. Use `read_note` for bounded follow-up excerpts when candidate ownership or insertion anchor still needs evidence.
5. If `context_pack.retrievalSignal.state` is `low-signal`, do not fall back to ad hoc vault shell scans. Use `fallbackSuggestions`, conventions, and explicit user intent to decide between a durable note and a daily fallback. Treat that fallback guidance as rationale, not proposal evidence.
6. If a durable destination is clear, draft a proposal for the existing note update or the new durable note.
7. If placement remains ambiguous, draft today's daily-note proposal and record placement debt in runtime state with the original text, candidate destinations, ambiguity reason, and review due date. Keep that placement debt out of the vault note itself.
8. If the MCP server is unavailable, report that dependency failure and fall back only to the existing manual or script workflow that still produces a proposal-first review step. Do not edit the vault directly in this fallback.
9. Validate tags by calling `workflow_policy` with `workflow: "capture"`. Apply only approved topical tags in the proposal; list missing useful tags separately as new-tag proposals.
10. Use `proposal_create_note` to draft the runtime proposal metadata and `proposal_read` to inspect the final proposal, bounded evidence, placement debt, and diff preview before asking for approval. For normal note content changes, pass the vault-relative `path`, explicit `mode`, and full note `body`. Reserve raw `proposal_create` for archive moves, vault moves, or separate explicit external delete proposals only.
11. Report the proposed append or durable placement change in chat, including whether this was place-first, explicit daily-note append, or ambiguity fallback.
12. Apply only after user approval or when the user explicitly asks for direct branch changes through the approved proposal flow.

## Note Body Style

- When creating a new durable note, do not start the body with an H1 or H2 that repeats the note title or filename. Obsidian already shows the title from the filename; start with useful links, metadata, or the first meaningful section instead.
- Keep a title-like heading only when it adds distinct context not already present in the note name.

## Agent Calls

- No agent call is needed for a clear single capture proposal.
- Call agent: librarian when ambiguity persists after MCP retrieval and the durable home is still unclear.
- Call agent: tag-steward when approved topical tags are unclear or a useful new tag may be needed.

## Output Format

Report:

1. Capture type: place-first, explicit daily-note append, or ambiguity fallback.
2. Destination: durable note path or daily note path.
3. Draft change: exact text or section outline to add.
4. Placement scorecard: subject ownership, insertion anchor, naming fit, tag fit, link fit, ambiguity, fallback reason, confidence, and unresolved questions.
5. Placement debt: include this only when ambiguity forced a daily fallback.
6. Approval needed: the specific proposal that must be approved before mutation.

## Review Expectations

Place-first quick capture is moderate-risk because it can route transient input into durable notes. Preserve explicit daily-note append, use placement debt when ambiguity forces a daily fallback, and keep the workflow proposal-first through `proposal_create_note` and `proposal_read`.
