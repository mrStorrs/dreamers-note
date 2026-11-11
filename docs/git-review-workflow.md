# Git review workflow

1. Inspect vault Git status and preserve unrelated changes.
2. Use the matching `note-*` skill to read relevant notes and propose concrete edits.
3. Obtain required approval, or work within the user's explicitly authorized refactor scope on its branch.
4. Re-read affected files and edit them directly. Verify extracted content before archiving a daily source.
5. Refresh `note-index.md` after path changes, then inspect the relevant diff and new files.
6. Report changed paths and any partial or unapplied work. Commit, push, and open a PR only when requested.

A batch refactor's report or PR includes `reviewer_attention` and `not_applied`. Git supplies the history and review surface; no runtime change records are created.
