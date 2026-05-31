#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
SKILLS_HOME="${SKILLS_HOME:-$CODEX_HOME/skills}"
SOURCE_DIR="$ROOT/global-skills"

usage() {
  cat <<'USAGE'
usage: ./install.sh [--dry-run]

Installs dreamers-note global launcher skills into $CODEX_HOME/skills.
Project-specific skills remain in this repository under .codex/skills/.

Environment:
  CODEX_HOME   Defaults to $HOME/.codex.
  SKILLS_HOME  Defaults to $CODEX_HOME/skills.
USAGE
}

dry_run=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      dry_run=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

fail() {
  printf 'install failed: %s\n' "$1" >&2
  exit 1
}

[ -d "$SOURCE_DIR" ] || fail "missing global-skills directory"

for skill_dir in "$SOURCE_DIR"/*; do
  [ -d "$skill_dir" ] || continue
  [ -f "$skill_dir/SKILL.md" ] || fail "missing SKILL.md in $skill_dir"
done

printf 'project skills stay in: %s/.codex/skills\n' "$ROOT"
printf 'global launchers install to: %s\n' "$SKILLS_HOME"

if [ "$dry_run" -eq 1 ]; then
  for skill_dir in "$SOURCE_DIR"/*; do
    [ -d "$skill_dir" ] || continue
    printf 'would install: %s\n' "$(basename "$skill_dir")"
  done
  exit 0
fi

mkdir -p "$SKILLS_HOME"

for skill_dir in "$SOURCE_DIR"/*; do
  [ -d "$skill_dir" ] || continue
  skill_name="$(basename "$skill_dir")"
  dest="$SKILLS_HOME/$skill_name"
  mkdir -p "$dest"
  cp "$skill_dir/SKILL.md" "$dest/SKILL.md"
  printf 'installed: %s\n' "$dest"
done

printf 'done. restart codex or open a new session for newly installed skills to appear in the skill list.\n'
