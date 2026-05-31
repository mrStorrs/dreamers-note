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

## Phases

1. Select explicit vault paths or folders to inspect.
2. Build an inventory of current paths, file types, and obvious Obsidian link or attachment risks.
3. Call agent: librarian to propose lowercase kebab-case destination paths.
4. Run deterministic collision checks before presenting any apply recommendation.
5. Report a chat-first proposal with risks and unresolved decisions.
6. Apply only after explicit user approval on a Git branch.
7. Verify agent work by checking collisions, excluded `.obsidian` paths, link risks, and `git diff`.

## Agent Calls

- Call agent: librarian for rename and move proposals.
- Call agent: tag-steward only if a future normalization request includes tag cleanup, which is not part of default normalization.

## Output Format

Report a chat-first proposal with current path, proposed path, collision status, link-update risk, attachment risk, and recommended next action.

## Review Expectations

Normalization is high-risk. Apply only after explicit approval on a Git branch and inspect the diff before merge.
