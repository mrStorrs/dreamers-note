---
name: "vault-normalization"
description: "Project-local skill for phase-gated AI review of the configured cyborg Obsidian vault: dry-run normalization, committed inventory indexes, reviewed rename or move decisions, approved topical tags, deterministic apply, link rewrites, and Git/PR review."
---

# vault-normalization

## Purpose

Normalize and remap selected vault paths through a phase-gated workflow: dry-run proposal, committed inventory indexes, AI review decisions, deterministic apply, and Git/PR review.

## Inputs

- Explicit vault paths or folders to inspect.
- Vault path from `/home/cjstorrs/projects/dreamers-note/config/vault.json`.
- Naming conventions from `docs/conventions.md`.
- Optional deterministic dry-run output from `scripts/propose-vault-normalization.py`.
- Committed project indexes in `indexes/`.
- Approved topical tags from `taxonomy/approved-tags.md`.
- AI review decisions in `indexes/ai-review-decisions.jsonl`.

## Allowed Paths

- Selected paths in the configured vault.
- Framework scripts and templates in `dreamers-note`.

## Forbidden Actions

- Do not apply renames or moves during proposal generation.
- Do not normalize `.obsidian` internals.
- Do not delete files.
- Do not rewrite links without Git diff review.
- Do not treat a generated proposal as approval to apply changes.
- Do not apply unreviewed records from `indexes/remap-queue.jsonl`.
- Do not apply tags outside `taxonomy/approved-tags.md`; record missing useful tags in `indexes/tag-proposals.jsonl`.
- Do not run deterministic apply outside a vault Git repository.

## Phases

1. Select explicit vault paths or folders to inspect.
2. From `/home/cjstorrs/projects/dreamers-note`, run `python3 scripts/propose-vault-normalization.py <selected-paths>` to build the dry-run proposal of record: normalized path candidates, collision risks, link-update needs, attachment risks, and next actions. The helper reads the vault path from `config/vault.json` unless `--vault` is explicitly provided.
3. Review the deterministic dry-run output for unresolved collisions, existing target paths, incoming or outgoing link risks, attachment risks, and excluded internals.
4. Build committed project state with `python3 scripts/build-vault-inventory.py --indexes indexes <selected-paths>`. This writes `indexes/vault-inventory.jsonl`, `indexes/remap-queue.jsonl`, and placeholder decision/tag proposal files.
5. Review `indexes/remap-queue.jsonl` one file or small batch at a time. For each unreviewed record, read the source note or inspect the asset, choose one approved target folder, propose a lowercase/kebab-case filename, choose approved topical tags only, and write a reviewed record to `indexes/ai-review-decisions.jsonl`.
6. Call agent: tag-steward with source context and candidate topical tags when the AI finds useful missing tags. Record missing tags in `indexes/tag-proposals.jsonl`; do not apply them to notes until they are approved.
7. Call agent: librarian when destination choice, collision resolution, existing-note merge risk, or folder placement remains ambiguous after deterministic normalization.
8. Report a chat-first summary of reviewed count, remaining queue count, target folders, tag proposals, collisions, unresolved questions, and expected link rewrites.
9. Stop before mutation unless the user explicitly approves applying reviewed decisions on a vault Git branch.
10. On approval, confirm the vault branch and run `python3 scripts/apply-vault-remap.py --indexes indexes`. The apply command reads the vault path from `config/vault.json`, validates reviewed records, refuses unsafe targets, moves files, rewrites resolvable links, updates approved tags, and reports branch/status.
11. Verify agent work by checking `indexes/`, collisions, excluded `.obsidian` paths, approved tags, unresolved references, and `git -C <configured-vault-path> status --short` plus the matching `git diff` before PR review.

## Agent Calls

- Call agent: librarian only for ambiguous rename or move decisions that remain after deterministic inventory and dry-run proposal.
- Call agent: tag-steward when useful topical tags are missing from `taxonomy/approved-tags.md` or when a reviewed file needs tag judgment beyond direct approved-tag matching.

## Output Format

Report a chat-first proposal with current path, proposed path, collision status, link-update risk, attachment risk, reviewed state, approved tags, proposed new tags, and recommended next action.

Use this structure:

1. Summary: selected scope, inventory count, reviewed count, remaining queue count, and whether apply was requested.
2. Proposed path changes: current path, proposed path, file kind, collision risk, link-update needs, attachment risks, approved tags, proposed new tags, and recommended next action.
3. Risks: collisions, existing target paths, wikilinks, embedded attachments, non-Markdown assets, unresolved questions, and excluded internals.
4. Approval needed: decisions required before deterministic apply can run on a vault Git branch.

## Review Expectations

Normalization is high-risk. Apply only after explicit approval on a Git branch and inspect the diff before merge.

The dry-run helper must leave the vault unchanged. The apply helper may mutate only reviewed decision records and must be followed by Git diff and PR review.
