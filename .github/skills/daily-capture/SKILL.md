---
name: "daily-capture"
description: "Copilot wrapper for place-first quick capture in the configured cyborg Obsidian vault using the dreamers-note MCP proposal workflow."
---

# daily-capture

Use `.codex/skills/daily-capture/SKILL.md` as the source of truth and follow it exactly from the repository root.

Start or use the MCP server from the repository root with `node dist/cli.js mcp`. If runtime readiness is unknown, call `workflow_ready`, then keep the capture proposal-first with `workflow_policy`, `context_pack`, `proposal_create_note`, and `proposal_read`.

Preserve explicit daily-note append requests, use durable placement when clear, and do not edit the vault until the user approves the specific proposal.
