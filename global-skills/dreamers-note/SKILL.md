---
name: "dreamers-note"
description: "Global entry point for adding command text, bullets, facts, decisions, or follow-ups into the correct existing or new note in the cyborg Obsidian vault through the dreamers-note project framework. Use when the user asks to add, file, place, remember, or record new note content and wants a proposed destination/context before vault edits."
---

# dreamers-note

This is a global launcher. The project-owned skill is the source of truth.

1. Open `/home/cjstorrs/obsidian/cyborg/.codex/skills/note-add/SKILL.md`.
2. Follow that skill exactly from `/home/cjstorrs/projects/dreamers-note`.
3. Treat the user's message as the note-add command text unless they provide a separate payload.
4. If the session is cold or runtime readiness is unknown, call `workflow_ready` first.
5. Prefer the MCP-backed place-first proposal flow: start with `context_pack` profile `place`, prefer an existing note when it clearly owns the subject, and otherwise propose a new durable destination.
6. Call `workflow_policy` with `workflow: "add"` before placement or tag decisions. If you inspect `dreamers-note://workflow-policy/add`, do it through MCP resource reads only and never through shell file reads. If retrieval is low-signal, use `fallbackSuggestions` and workflow policy directly instead of ad hoc vault shell scans or generic answer-style retrieval.
7. Treat conventions, templates, and approved tags as rationale for the proposal, not as proposal evidence.
8. Do not edit the vault until the project skill's proposal has been reported and explicitly approved.
9. Keep framework changes, templates, taxonomy, indexes, agents, and proposal state in `dreamers-note`.
10. Report the project skill used, proposed or approved destination path, tags, links, and any changed vault path.
