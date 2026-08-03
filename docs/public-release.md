# Public release procedure

This repository is an MIT-licensed source release. npm publication remains disabled.

1. Run `node scripts/check-public-release.mjs` on the candidate branch.
2. Install `git-filter-repo` outside this repository, then run `bash scripts/rewrite-public-history.sh --dry-run --source <local-clone> --email <github-noreply-email>`. It rewrites only a temporary clone, removes historical index state and `config/vault.json`, maps author and committer emails, and runs the history gate. It never contacts a remote.
3. Verify that the dry-run history gate reported no failures. The disposable clone is deleted automatically; do not use `git push --mirror`.
4. Obtain explicit approval for each remote action below. First list every remote ref and compare it with the verified rewritten refs: `git ls-remote --heads --tags origin`. Then force-update only each reviewed branch with `git push --force-with-lease origin <branch>`, delete each specifically approved obsolete ref with `git push origin --delete <ref>`, and only then change repository visibility in GitHub. Collaborators must re-clone or reset their local clones.
5. Review the original vault/account stores and rotate any credential that may have been represented by removed metadata.

Do not publish until every step succeeds.
