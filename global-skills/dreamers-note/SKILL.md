---
name: "dreamers-note"
description: "Global entry point for adding command text, bullets, facts, decisions, or follow-ups into the correct existing or new note in the cyborg Obsidian vault through the dreamers-note project framework. Use when the user asks to add, file, place, remember, or record new note content and wants a proposed destination/context before vault edits."
---

# dreamers-note

target_skill: note-add
workflow_id: add
payload_mapping: >
  Treat the user's message as the note-add command text unless they provide a separate payload.
reporting_fields:
- project skill used
- proposed or approved destination path
- tags
- links
- changed vault path
