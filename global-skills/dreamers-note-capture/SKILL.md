---
name: "dreamers-note-capture"
description: "Global entry point for adding or formatting quick notes, inbox captures, and daily-note entries in the cyborg Obsidian vault through the dreamers-note project framework. Use when the user asks to add a note, capture a thought, append to a daily note, or record raw material for later AI organization."
---

# dreamers-note-capture

target_skill_path: <local-home>/obsidian/cyborg/.codex/skills/daily-capture/SKILL.md
workflow_id: capture
payload_mapping: >
  Treat the user's message as capture text, preserving explicit daily-note append requests.
reporting_fields:
- project skill used
- proposed or approved destination path
- placement debt status
- changed vault path
