# vault-normalization

## Purpose

Propose lowercase kebab-case renames and moves for selected vault paths without changing files during the first proposal pass.

## Inputs

- Explicit vault paths or folders to inspect.
- Naming conventions from `docs/conventions.md`.
- Optional deterministic dry-run output from `scripts/propose-vault-normalization.py`.

## Allowed Paths

- Selected paths in `/home/cjstorrs/obsidian/cyborg`.
- Framework scripts and templates in `dreamers-note`.

## Forbidden Actions

- Do not apply renames or moves during proposal generation.
- Do not normalize `.obsidian` internals.
- Do not delete files.
- Do not rewrite links without Git diff review.
- Do not treat a generated proposal as approval to apply changes.

## Phases

1. Select explicit vault paths or folders to inspect.
2. From `/home/cjstorrs/projects/dreamers-note`, run `python3 scripts/propose-vault-normalization.py --vault /home/cjstorrs/obsidian/cyborg <selected-paths>` to build the dry-run proposal of record: normalized path candidates, collision risks, link-update needs, attachment risks, and next actions.
3. Review the deterministic dry-run output for unresolved collisions, existing target paths, incoming or outgoing link risks, attachment risks, and excluded internals.
4. Call agent: librarian only when the dry-run output exposes an ambiguous structural decision that deterministic lowercase normalization cannot resolve.
5. Report a chat-first proposal with risks and unresolved decisions.
6. Stop unless the user explicitly approves a separate apply workflow on a Git branch.
7. If a future approved apply workflow exists, verify agent work by checking collisions, excluded `.obsidian` paths, link risks, `git status`, and `git diff` before PR review.

## Agent Calls

- Call agent: librarian only for ambiguous rename or move decisions that remain after the deterministic dry-run proposal.
- Call agent: tag-steward only if a future normalization request includes tag cleanup, which is not part of default normalization.

## Output Format

Report a chat-first proposal with current path, proposed path, collision status, link-update risk, attachment risk, and recommended next action.

Use this structure:

1. Summary: selected scope, file count, and dry-run-only status.
2. Proposed path changes: current path, proposed path, file kind, collision risk, link-update needs, attachment risks, and recommended next action.
3. Risks: collisions, existing target paths, wikilinks, embedded attachments, non-Markdown assets, and excluded internals.
4. Approval needed: decisions required before any future branch can apply changes.

## Review Expectations

Normalization is high-risk. Apply only after explicit approval on a Git branch and inspect the diff before merge.

The dry-run helper is not apply-capable. It must leave the vault unchanged.
