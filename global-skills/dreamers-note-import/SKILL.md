---
name: "dreamers-note-import"
description: "Global entry point for importing an existing Markdown or text file into the correct location in the cyborg Obsidian vault through the dreamers-note project framework. Use when the user asks to add, import, file, or place an existing note file such as ~/Desktop/linux.md into the vault."
---

# dreamers-note-import

target_skill_path: /home/cjstorrs/obsidian/cyborg/.codex/skills/note-import/SKILL.md
workflow_id: import
payload_mapping: >
  Treat the user's message, including any source paths such as ~/Desktop/linux.md, as the import request.
reporting_fields:
- project skill used
- source path
- destination path
- whether the original source remains
