# git-review-workflow

All AI-made vault changes happen through Git review.

## default flow

1. Start from a clean branch.
2. Run the relevant skill against explicit input paths.
3. Review the chat-first proposal.
4. Approve, edit, or reject the proposal.
5. Apply approved changes on a Git branch.
6. Inspect `git diff`.
7. Merge only after the diff matches the intended change.

## review rules

- Do not apply broad moves, renames, merges, deletes, or retags without an inspectable diff.
- Do not send private vault content to external services unless the user explicitly chooses that path.
- Do not store API keys or provider secrets in notes, templates, logs, scripts, or config.
- Do not use AI confidence as a substitute for diff review.

## chat-first proposals

The default proposal surface is chat. File output is reserved for long batch work, async work, or user-requested saved proposals.
