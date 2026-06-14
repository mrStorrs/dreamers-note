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
- MCP tools and resources: `context_pack`, `read_note`, `proposal_create`, `proposal_read`, `dreamers-note://approved-tags`, and `dreamers-note://conventions`.

## Allowed Paths

- Read the configured vault, relevant existing notes, and selected daily notes.
- Read framework templates, conventions, approved tags, and runtime proposal state in `dreamers-note`.
- After explicit user approval, update only the approved durable destination note or daily note target.

## Forbidden Actions

- Do not move, split, archive, or delete content.
- Do not force durable placement when the user explicitly asked for a daily note append.
- Do not apply unapproved tags.
- Do not write workflow metadata, placement debt markers, or review comments into daily notes.
- If the MCP server is unavailable, do not fall through to a silent direct edit. Use only the existing manual or script workflow that still preserves proposal-first review.

## Phases

1. Parse whether the request is an explicit daily-note append, a place-first quick capture, or an ambiguous capture that may need fallback.
2. If the user names a daily note path or explicitly asks for a daily note, draft that daily-note proposal directly and do not force durable placement.
3. Otherwise use `context_pack` profile `place` to search existing notes first. Use `read_note` for bounded follow-up excerpts when candidate ownership or insertion anchor still needs evidence.
4. If a durable destination is clear, draft a proposal for the existing note update or the new durable note.
5. If placement remains ambiguous, draft today's daily-note proposal and record placement debt in runtime state with the original text, candidate destinations, ambiguity reason, and review due date. Keep that placement debt out of the vault note itself.
6. If the MCP server is unavailable, report that dependency failure and fall back only to the existing manual or script workflow that still produces a proposal-first review step. Do not edit the vault directly in this fallback.
7. Validate tags against the approved list. Apply only approved topical tags in the proposal; list missing useful tags separately as new-tag proposals.
8. Use `proposal_create` to draft the runtime proposal metadata and `proposal_read` to inspect the final proposal, bounded evidence, placement debt, and diff preview before asking for approval. For normal note content changes, use `targets` with vault-relative paths plus the full file body. Do not use `pathActions` unless you are actually moving a vault file or creating a separate explicit external delete proposal.
9. Report the proposed append or durable placement change in chat, including whether this was place-first, explicit daily-note append, or ambiguity fallback.
10. Apply only after user approval or when the user explicitly asks for direct branch changes through the approved proposal flow.

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

Place-first quick capture is moderate-risk because it can route transient input into durable notes. Preserve explicit daily-note append, use placement debt when ambiguity forces a daily fallback, and keep the workflow proposal-first through `proposal_create` and `proposal_read`.
