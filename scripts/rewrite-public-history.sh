#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 --dry-run --source <local-git-clone> --email <github-noreply-email>" >&2
  exit 2
}

[ "${1:-}" = "--dry-run" ] || usage
shift

source_clone=""
noreply_email=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --source)
      [ "$#" -ge 2 ] || usage
      source_clone="$2"
      shift 2
      ;;
    --email)
      [ "$#" -ge 2 ] || usage
      noreply_email="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

[ -n "$source_clone" ] && [ -n "$noreply_email" ] || usage
[[ "$noreply_email" =~ ^[0-9A-Za-z+_.-]+@users\.noreply\.github\.com$ ]] || {
  echo "--email must be a GitHub no-reply address" >&2
  exit 2
}
git -C "$source_clone" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "--source must be an existing local Git work tree" >&2
  exit 2
}
command -v git-filter-repo >/dev/null || {
  echo "git-filter-repo is required; install it outside this repository before proceeding." >&2
  exit 2
}

script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work_root="$(mktemp -d "${TMPDIR:-/tmp}/dreamers-note-public-history.XXXXXX")"
trap 'rm -rf "$work_root"' EXIT
rewrite_clone="$work_root/rewrite"
replacements="$work_root/replacements.txt"

git clone --no-local --quiet "$source_clone" "$rewrite_clone"
printf '%s\n' \
  'regex:/home/[A-Za-z0-9_.-]+/==><local-home>/' \
  'regex:/Users/[A-Za-z0-9_.-]+/==><local-home>/' \
  'regex:/tmp/[A-Za-z0-9_.-]+/==><temporary>/' \
  > "$replacements"
git -C "$rewrite_clone" filter-repo --force --invert-paths \
  --path indexes \
  --path config/vault.json \
  --path config/vault.local.json \
  --path .dreamers-note-runtime \
  --replace-text "$replacements" \
  --commit-callback "commit.author_name = b'dreamers-note contributors'; commit.committer_name = b'dreamers-note contributors'; commit.author_email = b'$noreply_email'; commit.committer_email = b'$noreply_email'"
node "$script_root/check-public-release.mjs" --history "$rewrite_clone"

echo "Disposable rewrite verified and removed: $work_root"
echo "No source clone or remote was changed. Use docs/public-release.md for the separate approval gate before any force-push."
