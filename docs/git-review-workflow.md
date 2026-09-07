# Git review workflow

All vault changes use a reviewable Git flow.

1. Work on an explicit branch or preserve unrelated changes.
2. Use a matching `note-*` skill and bounded CLI evidence.
3. Create a complete exact change with `change create --input`.
4. Inspect its id, revision, and diff with `change show`.
5. Obtain the required approval, or use only an explicit branch-scoped refactor authorization.
6. Apply only that id and revision with `change apply`.
7. Inspect the relevant `git diff` and report changed files.

Do not direct-write vault files, hide broad moves/merges/deletions, expose private content, or treat confidence as a substitute for the diff. Batch refactors include `reviewer_attention` and `not_applied` sections in their pull request summary.
