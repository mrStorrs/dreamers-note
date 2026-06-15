---
name: "dreamers-note-capture"
description: "Global entry point for adding or formatting quick notes, inbox captures, and daily-note entries in the cyborg Obsidian vault through the dreamers-note project framework. Use when the user asks to add a note, capture a thought, append to a daily note, or record raw material for later AI organization."
---

# dreamers-note-capture

This is a global launcher. The project-owned skill is the source of truth.

1. Open `<local-home>/obsidian/cyborg/.codex/skills/daily-capture/SKILL.md`.
2. Follow that skill exactly from `<local-home>/projects/dreamers-note`.
3. Use place-first capture by default, preserve explicit daily-note append, and record placement debt when ambiguity forces a daily fallback.
4. Start with `context_pack` profile `place`; if retrieval is low-signal, use `fallbackSuggestions` and explicit user intent instead of ad hoc vault shell scans.
5. Treat conventions, templates, and approved tags as rationale for the proposal, not as proposal evidence.
6. Keep framework changes, templates, taxonomy, indexes, agents, and proposal state in `dreamers-note`.
7. Edit the vault only where the project skill allows it.
8. Report the project skill used and any changed vault path.
