---
name: "dreamers-note"
description: "Global entry point for adding command text, bullets, facts, decisions, or follow-ups into the correct existing or new note in the cyborg Obsidian vault through the dreamers-note project framework. Use when the user asks to add, file, place, remember, or record new note content and wants a proposed destination/context before vault edits."
---

# dreamers-note

This is a global launcher. The project-owned skill is the source of truth.

1. Open `<local-home>/obsidian/cyborg/.codex/skills/note-add/SKILL.md`.
2. Follow that skill exactly from `<local-home>/projects/dreamers-note`.
3. Treat the user's message as the note-add command text unless they provide a separate payload.
4. Prefer an existing note when it is clearly relevant; otherwise propose a new durable destination.
5. Do not edit the vault until the project skill's proposal has been reported and explicitly approved.
6. Keep framework changes, templates, taxonomy, indexes, agents, and proposal state in `dreamers-note`.
7. Report the project skill used, proposed or approved destination path, tags, links, and any changed vault path.
