---
name: note-add
description: Place new notes, captures, decisions, or explicit daily entries in a Markdown vault after showing the proposed edit.
---

# note-add

For a small addition, capture, decision, follow-up, or daily-note entry.

Resolve `framework_root` from this checkout or from `.dreamers-note-install.json` in the parent installed-skills directory. Read `<framework_root>/docs/note-workflow-policy.md` and the shared settings at `<framework_root>/config/vault.local.json` before accessing notes.

If `vault_path` is missing or unusable, ask in chat: “Where is your notes directory stored?” Wait for the user's answer, validate the directory, and save its absolute path as `vault_path` in that settings file. Reuse the saved path on later runs; follow the policy's setup rules when the user changes it.

1. Check vault Git status. Search `note-index.md` for candidate paths, then read the relevant notes with ordinary file tools. Use a focused content search if paths alone are insufficient.
2. Prefer an existing note with clear ownership and an insertion point; otherwise choose a classified destination. Consult the project/source template when applicable and follow the policy's body rules. An explicit daily request uses `00-inbox/daily-notes/yyyy-mm-dd.md` and the daily template's `## notes` / `## research` sections. Ask about unresolved placement rather than inventing a catch-all.
3. Show the destination and concrete proposed content or diff, with supporting paths and any tag/link changes. Obtain explicit approval unless the user already approved this specific edit.
4. Re-read affected files, apply the approved edit directly, and check that unrelated content was preserved. Refresh the Markdown index if paths were added, moved, or removed.
5. Report the changed paths and relevant Git diff. Do not commit or push unless requested.
