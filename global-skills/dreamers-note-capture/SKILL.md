---
name: "dreamers-note-capture"
description: "Global entry point for adding or formatting quick notes, inbox captures, and daily-note entries in the cyborg Obsidian vault through the dreamers-note project framework. Use when the user asks to add a note, capture a thought, append to a daily note, or record raw material for later AI organization."
---

# dreamers-note-capture

This is a global launcher. The project-owned skill is the source of truth.

1. Open `<local-home>/obsidian/cyborg/.codex/skills/daily-capture/SKILL.md`.
2. Follow that skill exactly from `<local-home>/projects/dreamers-note`.
3. Use place-first capture by default, preserve explicit daily-note append, and record placement debt when ambiguity forces a daily fallback.
4. If the session is cold or runtime readiness is unknown, call `workflow_ready` first.
5. Call `workflow_policy` with `workflow: "capture"`, then start with `context_pack` profile `place`; if you inspect `dreamers-note://workflow-policy/capture`, do it through MCP resource reads only and never through shell file reads. If retrieval is low-signal, use `fallbackSuggestions` and explicit user intent instead of ad hoc vault shell scans.
6. Treat conventions, templates, and approved tags as rationale for the proposal, not as proposal evidence.
7. Keep framework changes, templates, taxonomy, indexes, agents, and proposal state in `dreamers-note`.
8. Edit the vault only where the project skill allows it.
9. Report the project skill used and any changed vault path.
