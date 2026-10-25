---
name: "note-vault-refactor"
description: "Run an explicit branch-scoped vault refactor or normalization through read-only note-review workers and exact change lifecycle records."
---

# note-vault-refactor

Use this skill for an explicitly scoped batch refactor or normalization, not for a one-note review. The invoking branch scope authorizes the orchestrator to apply reviewed exact changes without a second mid-run approval; the pull request is the review surface.

Resolve the framework root/CLI through the checked-in repository or installed locator, then read the shared workflow policy at `<framework_root>/docs/note-workflow-policy.md`.

1. Require an explicit vault scope and branch. Inspect Git status and preserve unrelated changes. Use `vault inventory`, `vault normalize`, `context` commands, and `review` commands only for bounded planning evidence.
2. Delegate each single-note assessment to `note-review` in worker mode. Workers are read-only and return only their structured report.
3. Synthesize path, tag, link, body, split, merge, and directory-index decisions. Keep uncertain or destructive recommendations in `not_applied`.
4. Build an exact multi-file change with `change create --input -`, inspect `change show --id`, and apply only that recorded revision with `change apply --id <id> --revision <sha256>`.
5. Verify the vault Git diff. Open a PR whose summary has `reviewer_attention` and `not_applied` sections, citing risky moves, splits, merges, tag changes, or low-confidence judgments.

Never run on an implicit/broad scope, permit workers to mutate, apply an unreviewed revision, touch excluded paths, or use a direct writer outside `change apply`.
