---
name: "dreamers-note-import"
description: "Global entry point for importing an existing Markdown or text file into the correct location in the cyborg Obsidian vault through the dreamers-note project framework. Use when the user asks to add, import, file, or place an existing note file such as ~/Desktop/linux.md into the vault."
---

# dreamers-note-import

This is a global launcher. The project-owned skill is the source of truth.

1. Open `/home/cjstorrs/obsidian/cyborg/.codex/skills/note-import/SKILL.md`.
2. Follow that skill exactly from `/home/cjstorrs/projects/dreamers-note`.
3. Treat the user's message, including any source paths such as `~/Desktop/linux.md`, as the import request.
4. Call `workflow_policy` with `workflow: "import"`, then start with `context_pack` profile `import` and the project skill's source-path validation before drafting any proposal. If you inspect `dreamers-note://workflow-policy/import`, do it through MCP resource reads only and never through shell file reads.
5. If retrieval is low-signal, use `fallbackSuggestions` directly. If one is marked as the default choice, trust it without extra vault scans to verify roots or templates.
6. Treat conventions, templates, and approved tags as rationale for the proposal, not as proposal evidence.
7. Keep framework changes, templates, taxonomy, indexes, agents, and proposal state in `dreamers-note`.
8. Edit the vault only where the project skill allows it.
9. Report the project skill used, source path, destination path, and whether the original source remains.
