# daily-capture

## Purpose

Help write or structure a selected daily note while keeping capture fast and non-destructive.

## Inputs

- Target daily note path.
- User-provided raw text, bullets, links, or pasted fragments.

## Allowed Paths

- The selected daily note in `<local-home>/obsidian/cyborg`.
- Framework templates in `dreamers-note`.

## Forbidden Actions

- Do not move, split, archive, or delete content.
- Do not file material into projects or knowledge notes.
- Do not apply unapproved tags.

## Phases

1. Confirm the target daily note path and the capture text.
2. Append or format the capture in the selected daily note.
3. Verify that no filing, archive, tag creation, or cross-note edit occurred.
4. Report the exact changed section for Git review if a file was edited.

## Agent Calls

- No agent call by default. This skill is intentionally capture-only.
- Call agent: triage only if the user explicitly asks to move from capture into daily triage.

## Output Format

Report the proposed append or formatting change in chat. Apply only after user approval or when the user explicitly asks for direct branch changes.

## Review Expectations

Daily capture changes are low-risk but still happen through Git when files are edited.
