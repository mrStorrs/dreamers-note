---
name: note-review
description: Review one Markdown vault note for placement, tags, links, duplicates, clarity, and privacy without editing it.
---

# note-review

Review exactly one note. This skill reports findings and proposed text; it does not edit the vault.

Resolve `framework_root` from this checkout or from `.dreamers-note-install.json` in the parent installed-skills directory. Read `<framework_root>/docs/note-workflow-policy.md` and the shared settings at `<framework_root>/config/vault.local.json` before accessing notes.

If `vault_path` is missing or unusable, ask in chat: “Where is your notes directory stored?” Wait for the user's answer, validate the directory, and save its absolute path as `vault_path` in that settings file. Reuse the saved path on later runs; follow the policy's setup rules when the user changes it.

1. Resolve the selected note through `note-index.md` when needed and read it with ordinary file tools. If the index is missing, use a focused file listing; do not create vault files during a review. User-authorized settings setup remains allowed.
2. Inspect placement, approved tags, useful outgoing and incoming links, likely duplicates, ownership, and body clarity against the policy's note formats. Check daily dates/sections and consult relevant project/source templates without imposing them retroactively on existing notes. Flag redundant title-only H1/H2 headings. Search only relevant allowed paths for supporting evidence.
3. Return concise findings with vault-relative paths and bounded excerpts. If a fix was requested, show the proposed content or diff in chat.
4. For a caller reviewing a larger scope, include the note path, recommendation, confidence, reviewer attention, and anything left unapplied.

Moving, merging, splitting, and deleting are recommendations here, not actions.
