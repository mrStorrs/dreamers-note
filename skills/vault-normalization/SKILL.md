# vault-normalization

## Purpose

Propose lowercase kebab-case renames and moves for selected vault paths without changing files during the first proposal pass.

## Inputs

- Explicit vault paths or folders to inspect.
- Naming conventions from `docs/conventions.md`.

## Allowed Paths

- Selected paths in `<local-home>/obsidian/cyborg`.
- Framework scripts and templates in `dreamers-note`.

## Forbidden Actions

- Do not apply renames or moves during proposal generation.
- Do not normalize `.obsidian` internals.
- Do not delete files.
- Do not rewrite links without Git diff review.

## Output Format

Report a chat-first proposal with current path, proposed path, collision status, link-update risk, attachment risk, and recommended next action.

## Review Expectations

Normalization is high-risk. Apply only after explicit approval on a Git branch and inspect the diff before merge.
