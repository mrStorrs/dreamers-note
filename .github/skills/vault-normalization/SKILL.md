---
name: "vault-normalization"
description: "Copilot wrapper for phase-gated AI review of selected vault files with approved placement, tag, link, and split decisions."
---

# vault-normalization

Use `.codex/skills/vault-normalization/SKILL.md` as the source of truth and follow it exactly from the repository root.

Start or use the MCP server from the repository root with `node dist/cli.js mcp`. If runtime readiness is unknown, call `workflow_ready`, then preserve the workflow's phase gates and proposal-first review.

Read or inspect each selected file individually, keep approved tags constrained by policy, and do not batch-normalize unrelated vault content. For classified directory homepages, use `_<folder-name>.md`, keep generated leads focused on folder subject matter rather than the file's role, and preserve human-owned `## Notes` while refreshing generated content.
