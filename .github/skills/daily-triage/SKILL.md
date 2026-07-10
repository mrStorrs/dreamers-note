---
name: "daily-triage"
description: "Copilot wrapper for processing daily note inbox items through MCP-backed extraction proposals and archive proposals."
---

# daily-triage

Use `.codex/skills/daily-triage/SKILL.md` as the source of truth and follow it exactly from the repository root.

Start or use the MCP server from the repository root with `node dist/cli.js mcp`. If runtime readiness is unknown, call `workflow_ready`, then use `workflow_policy`, `context_pack`, `proposal_create_note`, `proposal_create`, and `proposal_read` for proposal-first triage.

Do not archive, split, or rewrite vault content until the extraction and archive proposals have been reviewed and explicitly approved. For classified directory homepages, use `_<folder-name>.md` and preserve human-owned `## Notes` while refreshing generated content.
