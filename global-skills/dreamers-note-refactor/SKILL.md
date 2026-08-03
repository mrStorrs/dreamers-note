---
name: "dreamers-note-refactor"
description: "Global entry point for branch-scoped cyborg Obsidian vault refactors that batch single-note reviews, apply reviewable edits on a feature branch, and open a PR with reviewer-attention notes."
---

# dreamers-note-refactor

target_skill: vault-refactor
workflow_id: refactor
payload_mapping: >
  Treat the user's message as the vault refactor scope, including any folder paths, note paths, queue names, or branch and PR hints.
reporting_fields:
- project skill used
- vault branch
- reviewed scope
- changed paths
- reviewer attention
- PR status
