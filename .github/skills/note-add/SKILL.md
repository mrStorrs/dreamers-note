---
name: "note-add"
description: "Copilot wrapper for adding facts, decisions, follow-ups, and note content into the configured cyborg Obsidian vault with MCP-backed placement."
---

# note-add

Use `.codex/skills/note-add/SKILL.md` as the source of truth and follow it exactly from the repository root.

Start or use the MCP server from the repository root with `node dist/cli.js mcp`. If runtime readiness is unknown, call `workflow_ready`, then keep placement proposal-first with `workflow_policy`, `context_pack`, `read_note`, `proposal_create_note`, and `proposal_read`.

Prefer a strong existing-note match, use durable fallback guidance when retrieval is low-signal, and do not edit the vault until the user approves the specific proposal.
