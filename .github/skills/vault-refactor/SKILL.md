---
name: "vault-refactor"
description: "Copilot wrapper for branch-scoped cyborg Obsidian vault refactors using single-note review workers and PR-centered review."
---

# vault-refactor

Use `.codex/skills/vault-refactor/SKILL.md` as the source of truth and follow it exactly from the repository root.

Start or use the MCP server from the repository root with `node dist/cli.js mcp`. If runtime readiness is unknown, call `workflow_ready`, then batch read-only note-review workers and keep all mutations proposal-first in the orchestrator on a vault feature branch.

If the user did not provide a scope, ask them to choose full vault, section/folder, manually chosen files, or review-queue/diagnostic scope before creating the branch. After scope selection, do not pause for mid-run approval. Apply reviewable edits on the branch, keep destructive or secret-adjacent recommendations out of the diff, and include reviewer-attention sections in the PR. For classified directory homepages, use `_<folder-name>.md` and preserve human-owned `## Notes` while refreshing generated content.
