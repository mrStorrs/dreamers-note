---
name: "tag-steward"
description: "Copilot wrapper for validating topical tags against the dreamers-note approved tag workflow."
---

# tag-steward

Use `.codex/skills/tag-steward/SKILL.md` as the source of truth and follow it exactly from the repository root.

Start or use the MCP server from the repository root with `node dist/cli.js mcp`. If runtime readiness is unknown, call `workflow_ready`, then use `workflow_policy` to validate approved tags.

Keep tag changes proposal-first, reject lifecycle or kind tags, and surface useful missing topical tags separately instead of applying them.
