---
name: "dreamers-note-import"
description: "Global entry point for importing an existing Markdown or text file into the correct location in the cyborg Obsidian vault through the dreamers-note project framework. Use when the user asks to add, import, file, or place an existing note file such as ~/Desktop/linux.md into the vault."
---

# dreamers-note-import

This is a global launcher. The project-owned skill is the source of truth.

1. Open `<local-home>/obsidian/cyborg/.codex/skills/note-import/SKILL.md`.
2. Follow that skill exactly from `<local-home>/projects/dreamers-note`.
3. Treat the user's message, including any source paths such as `~/Desktop/linux.md`, as the import request.
4. Keep framework changes, templates, taxonomy, indexes, agents, and proposal state in `dreamers-note`.
5. Edit the vault only where the project skill allows it.
6. Report the project skill used, source path, destination path, and whether the original source remains.
