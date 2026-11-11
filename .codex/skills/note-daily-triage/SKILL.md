---
name: note-daily-triage
description: Extract useful material from selected daily notes, then archive completed sources after approval.
---

# note-daily-triage

For filing durable material from daily notes. Archive a source only after its extracted content has been saved and verified.

Resolve `framework_root` from this checkout or from `.dreamers-note-install.json` in the parent installed-skills directory. Read `<framework_root>/docs/note-workflow-policy.md` and the shared settings at `<framework_root>/config/vault.local.json` before accessing notes.

If `vault_path` is missing or unusable, ask in chat: “Where is your notes directory stored?” Wait for the user's answer, validate the directory, and save its absolute path as `vault_path` in that settings file. Reuse the saved path on later runs; follow the policy's setup rules when the user changes it.

1. Check vault Git status. Resolve daily notes at `00-inbox/daily-notes/yyyy-mm-dd.md` through `note-index.md`; when discovery is requested, list candidates and keep the batch bounded. Leave today's note open unless the user explicitly includes it.
2. Read both `## notes` and `## research` and any other existing source content, plus likely destinations. Decide what is durable, where it belongs, and what is still ambiguous or unfinished. Use the matching project/source template when creating destinations, following the policy's body rules.
3. Show concrete destination edits and proposed archive moves together. Keep notes with unresolved material in place. Obtain explicit approval unless this exact batch is already approved.
4. Apply destination edits directly and verify every extracted item. If any edit fails, stop and report partial progress; do not archive its source.
5. Move only fully processed sources to `99-archive/daily-notes/yyyy-mm-dd.md`. Stop on collisions, preserve the source filename and body, refresh `note-index.md`, and report the Git diff and remaining material.

These are ordinary file operations, not an atomic transaction. Preserve sources until all their destinations are verified so interrupted work can be resumed.
