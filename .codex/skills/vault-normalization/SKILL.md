---
name: "vault-normalization"
description: "Project-local skill for phase-gated AI review of every selected file in the configured cyborg Obsidian vault: each file is read or inspected individually, assigned to project, knowledge, people, or another approved folder, tagged with approved topical tags, linked, optionally split into extracted notes, then applied through reviewed Git/PR changes."
---

# vault-normalization

## Purpose

Normalize and remap selected vault paths through a phase-gated workflow: inventory, one-file-at-a-time AI content review, explicit decisions for placement/tags/links/content extraction, deterministic apply, and Git/PR review.

## Inputs

- Explicit vault paths or folders to inspect.
- Vault path from `/home/cjstorrs/projects/dreamers-note/config/vault.json`.
- Naming conventions from `docs/conventions.md`.
- Optional deterministic dry-run output from `scripts/propose-vault-normalization.py` for mechanical rename risks only.
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
- Do not mark a record reviewed until the AI has read the file content or inspected the asset context and decided placement, tags, links, and content actions.
- Do not apply tags outside `taxonomy/approved-tags.md`; record missing useful tags in `indexes/tag-proposals.jsonl`.
- Do not run deterministic apply outside a vault Git repository.
- Do not target `02-areas` or `03-knowledge`; durable topical notes belong under `02-knowledge/<main>/<sub>/`.
- Do not put family notes under knowledge; family belongs under `04-people/family/<sub>/`.
- Do not nest project, knowledge, or people notes deeper than `main/sub`; fold extra imported path context into the filename.

## Phases

1. Select explicit vault paths or folders to inspect.
2. From `/home/cjstorrs/projects/dreamers-note`, run `python3 scripts/propose-vault-normalization.py <selected-paths>` to get mechanical rename, collision, link, and attachment risks. This output is context, not the decision.
3. Build committed project state with `python3 scripts/build-vault-inventory.py --indexes indexes <selected-paths>`. This writes `indexes/vault-inventory.jsonl`, `indexes/remap-queue.jsonl`, and placeholder decision/tag proposal files. Every queue item has `must_read_file: true` and requires review scope `placement`, `tags`, `links`, and `content`.
4. Review `indexes/remap-queue.jsonl` one file at a time. For each unreviewed record, the AI must read the Markdown note or inspect asset usage/context before writing any reviewed decision.
5. For each file, decide all of the following:
   - final `target_path`
   - approved topical `approved_tags`
   - missing useful `proposed_new_tags`
   - `links_to_add` that improve retrieval
   - `extracted_notes` when part of the source belongs in separate project, knowledge, or people notes
   - unresolved questions, confidence, and reason
6. Write exactly one reviewed decision record per reviewed source file to `indexes/ai-review-decisions.jsonl`. Include `reviewed: true` and `reviewed_scope: ["placement", "tags", "links", "content"]`. Project, knowledge, and people notes must target `<root>/<main>/<sub>/<note-name>.md`; do not leave reviewed knowledge in `02-areas` or `03-knowledge`.
7. Call agent: tag-steward with source context and candidate topical tags when the AI finds useful missing tags. Record missing tags in `indexes/tag-proposals.jsonl`; do not apply them to notes until they are approved.
8. Call agent: librarian when destination choice, collision resolution, existing-note merge risk, folder placement, split decisions, or link targets remain ambiguous after reading the file.
9. Report a chat-first summary of reviewed count, remaining queue count, target folders, extracted notes, links to add, tag proposals, collisions, unresolved questions, and expected link rewrites.
10. Stop before mutation unless the user explicitly approves applying reviewed decisions on a vault Git branch.
11. On approval, confirm the vault branch and run `python3 scripts/apply-vault-remap.py --indexes indexes`. The apply command reads the vault path from `config/vault.json`, validates reviewed records and full review scope, refuses unsafe targets, moves files, rewrites resolvable links, updates approved tags, creates reviewed extracted notes, adds reviewed links, and reports branch/status.
12. Verify agent work by checking `indexes/`, one decision per reviewed file, collisions, extracted notes, excluded `.obsidian` paths, approved tags, new-tag proposals, unresolved references, and `git -C <configured-vault-path> status --short` plus the matching `git diff` before PR review.

## Agent Calls

- Call agent: librarian for ambiguous destination, split, merge, or link decisions that remain after reading the source file.
- Call agent: tag-steward when useful topical tags are missing from `taxonomy/approved-tags.md` or when a reviewed file needs tag judgment beyond direct approved-tag matching.

## Output Format

Report a chat-first proposal with current path, final target path, collision status, link-update risk, attachment risk, reviewed state, approved tags, proposed new tags, links to add, extracted notes, and recommended next action.

Use this structure:

1. Summary: selected scope, inventory count, reviewed count, remaining queue count, and whether apply was requested.
2. Reviewed decisions: current path, target path, file kind, review scope, approved tags, proposed new tags, links to add, extracted notes, content action, confidence, and reason.
3. Risks: collisions, existing target paths, wikilinks, embedded attachments, non-Markdown assets, unresolved questions, and excluded internals.
4. Approval needed: decisions required before deterministic apply can run on a vault Git branch.

## Decision Record Shape

Each reviewed source file must produce a JSONL record shaped like:

```json
{"source_path":"old.md","target_path":"02-knowledge/main/sub/new.md","reviewed":true,"reviewed_scope":["placement","tags","links","content"],"approved_tags":["ai"],"proposed_new_tags":[],"links_to_add":["02-knowledge/related/topics/topic.md"],"extracted_notes":[],"confidence":"high","reason":"content belongs in the ai knowledge area","unresolved_questions":[]}
```

Use `extracted_notes` when part of the source should become its own note:

```json
{"target_path":"02-knowledge/food/recipes/chicken-stock.md","title":"chicken stock","body":"owned note text extracted from the source","approved_tags":["recipes"],"proposed_new_tags":[],"links_to_add":["02-knowledge/food/meal-planning/menu-planning.md"]}
```

## Placement Rules

- Use `01-projects/<main>/<sub>/<note-name>.md` for active project material.
- Use `02-knowledge/<main>/<sub>/<note-name>.md` for reusable knowledge, concepts, practices, recipes, references-to-self, and other non-project topical material.
- Use `04-people/<main>/<sub>/<note-name>.md` for people and relationship notes. Family material belongs in `04-people/family/<sub>/`.
- Keep exactly two classification directories below `01-projects`, `02-knowledge`, and `04-people`: `main` and `sub`.
- If the source has only a broad topic, use that topic as `main` and choose a useful `sub`; use `general` only as a temporary low-confidence fallback.
- If the source has deeper nesting, preserve the most useful first two directories as `main/sub` and fold remaining context into the filename.
- Keep projects in `01-projects`, sources in `03-sources`, people in `04-people`, assets in `05-assets`, templates in `06-templates`, system files in `07-system`, and inactive material in `99-archive`.

## Review Expectations

Normalization is high-risk. Apply only after explicit approval on a Git branch and inspect the diff before merge.

The dry-run helper must leave the vault unchanged. The apply helper may mutate only reviewed decision records and must be followed by Git diff and PR review.
