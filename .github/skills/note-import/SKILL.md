---
name: "note-import"
description: "Copilot wrapper for importing Markdown or text files into the configured cyborg Obsidian vault through MCP proposal review."
---

# note-import

Use `.codex/skills/note-import/SKILL.md` as the source of truth and follow it exactly from the repository root.

Start or use the MCP server from the repository root with `node dist/cli.js mcp`. If runtime readiness is unknown, call `workflow_ready`, validate the source path first, then keep import proposal-first with `workflow_policy`, `context_pack`, `proposal_create_note`, and `proposal_read`.

Keep the original source file in place unless the user explicitly requests a separate delete proposal, and do not mutate the vault before approval. For classified directory homepages, use `_<folder-name>.md`, keep generated leads focused on folder subject matter rather than the file's role, and preserve human-owned `## Notes` while refreshing generated content.
