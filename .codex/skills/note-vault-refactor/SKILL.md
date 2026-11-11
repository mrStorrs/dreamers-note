---
name: note-vault-refactor
description: Refactor an explicit set of Markdown vault notes on a Git branch using direct edits and a readable note index.
---

# note-vault-refactor

For an explicitly scoped batch refactor or normalization. A request to refactor the specified scope authorizes ordinary edits within that scope.

Resolve `framework_root` from this checkout or from `.dreamers-note-install.json` in the parent installed-skills directory. Read `<framework_root>/docs/note-workflow-policy.md` and the shared settings at `<framework_root>/config/vault.local.json` before accessing notes.

If `vault_path` is missing or unusable, ask in chat: “Where is your notes directory stored?” Wait for the user's answer, validate the directory, and save its absolute path as `vault_path` in that settings file. Reuse the saved path on later runs; follow the policy's setup rules when the user changes it.

1. Establish the requested paths and branch. Inspect Git status, preserve unrelated edits, and create a descriptive branch if the user has not named one. Ask for scope if the request is ambiguous.
2. Use `note-index.md`, focused searches, and direct note reads to assess placement, tags, links, duplicate content, and body quality. Review inline; use read-only `note-review` workers only when delegation is requested or useful for the explicitly authorized batch.
3. Edit the selected notes with ordinary file tools, following the policy's formats and templates for newly created notes. Preserve existing note structure unless changing it is in scope. Before a move, check the destination and update affected links. Keep uncertain, destructive, or privacy-adjacent proposals unapplied pending a concrete decision.
4. Preserve human-owned folder homepages and their `## Notes` sections. Refresh `note-index.md` after path changes, then inspect the relevant Git diff for content loss, broken links, and unintended edits.
5. Report applied changes plus `reviewer_attention` and `not_applied`. Commit, push, or open a PR when requested as part of the task; include those sections in any PR summary.
