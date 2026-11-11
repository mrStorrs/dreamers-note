---
name: note-import
description: Place a selected Markdown or text file in the vault while preserving the source and showing the proposed destination and edit.
---

# note-import

For a user-selected Markdown or text file. The source remains unchanged.

Resolve `framework_root` from this checkout or from `.dreamers-note-install.json` in the parent installed-skills directory. Read `<framework_root>/docs/note-workflow-policy.md` and the shared settings at `<framework_root>/config/vault.local.json` before accessing notes.

If `vault_path` is missing or unusable, ask in chat: “Where is your notes directory stored?” Wait for the user's answer, validate the directory, and save its absolute path as `vault_path` in that settings file. Reuse the saved path on later runs; follow the policy's setup rules when the user changes it.

1. Resolve the selected source and check it is a regular text file outside excluded paths; do not follow symlinks. Read only the content needed for placement, in chunks for large files.
2. Check vault Git status and search `note-index.md`. Read likely owners and check the intended destination for collisions. For new project/source notes, consult the matching vault template and follow the policy's body rules; do not add a title-only H1/H2. Preserve useful source content and provenance, and use only approved tags.
3. Show the source, destination, and proposed imported content or merge diff. Obtain explicit approval unless the user already approved this specific edit.
4. Re-read the source and destination before editing. Copy or incorporate the approved content using ordinary file tools, preserving the original file.
5. Refresh the index when paths change. Verify the destination, source preservation, and relevant vault Git diff; report the result.
