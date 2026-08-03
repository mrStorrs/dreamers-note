---
name: "dreamers-note-review"
description: "Global entry point for reviewing one cyborg Obsidian vault note for proper tags, backlinks, location, ownership, duplicate risk, body style, and retrieval quality through the dreamers-note project framework."
---

# dreamers-note-review

target_skill: note-review
workflow_id: review
payload_mapping: >
  Treat the user's message as a request to resolve and review exactly one vault note unless they provide a separate note path or title.
reporting_fields:
- project skill used
- reviewed note path
- verdict
- findings
- reviewer attention
