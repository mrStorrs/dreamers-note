---
name: "note-daily-triage"
description: "Triage selected or discovered daily notes into one approved atomic extraction-and-archive vault change."
---

# note-daily-triage

Use this skill for daily-note processing. It turns durable items into approved destination notes and archives only the reviewed daily notes in the same atomic change.

Resolve the framework root/CLI through the checked-in repository or installed locator, then read the shared workflow policy at `<framework_root>/docs/note-workflow-policy.md`.

1. Run `daily triage` for the selected daily paths, or let its deterministic discovery identify candidates. Use `--archive-check` when deciding whether a note can be archived.
2. Read bounded context for each candidate destination. Make the AI judgment about extraction, destination, tags, links, and material that must remain unfiled; do not invent a catch-all location.
3. Compose one complete change input that includes every accepted extraction, required full-body updates, and archive moves. Create it with `change create --input -` and inspect it with `change show --id`.
4. Report extracted items, destinations, retained/ambiguous material, archive moves, tags/links, exact id/revision, and full diff. Stop for explicit user approval.
5. After approval of that exact revision, use `change apply --id <id> --revision <sha256>` and report the vault Git diff.

Do not archive before the extracted content is included in the same reviewed change. Do not apply changes without approval, process excluded paths, or turn incomplete/ambiguous material into a forced durable note.
