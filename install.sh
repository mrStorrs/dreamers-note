#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
SKILLS_HOME="${SKILLS_HOME:-$CODEX_HOME/skills}"
SOURCE_DIR="$ROOT/global-skills"
MANAGED_FILE="$SKILLS_HOME/.dreamers-note-managed-skills"
LEGACY_MANAGED_SKILLS=(
  dreamers-note-capture
  dreamers-note-triage
  dreamers-note-normalize
  dreamers-note-tags
)

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

is_safe_skill_name() {
  case "$1" in
    ''|*/*|.*|*' '*)
      return 1
      ;;
  esac
}

has_current_skill() {
  local candidate="$1"
  local current
  for current in "${current_skills[@]}"; do
    [ "$candidate" = "$current" ] && return 0
  done
  return 1
}

append_unique() {
  local value="$1"
  local existing
  for existing in "${managed_candidates[@]}"; do
    [ "$value" = "$existing" ] && return 0
  done
  managed_candidates+=("$value")
}

current_skills=()

for skill_dir in "$SOURCE_DIR"/*; do
  [ -d "$skill_dir" ] || continue
  [ -f "$skill_dir/SKILL.md" ] || fail "missing SKILL.md in $skill_dir"
  skill_name="$(basename "$skill_dir")"
  is_safe_skill_name "$skill_name" || fail "unsafe skill directory name: $skill_name"
  current_skills+=("$skill_name")
done

managed_candidates=()

for skill_name in "${LEGACY_MANAGED_SKILLS[@]}"; do
  append_unique "$skill_name"
done

if [ -f "$MANAGED_FILE" ]; then
  while IFS= read -r skill_name; do
    [ -n "$skill_name" ] || continue
    is_safe_skill_name "$skill_name" || fail "unsafe managed skill name: $skill_name"
    append_unique "$skill_name"
  done <"$MANAGED_FILE"
fi

stale_skills=()

for skill_name in "${managed_candidates[@]}"; do
  if ! has_current_skill "$skill_name" && [ -e "$SKILLS_HOME/$skill_name" ]; then
    stale_skills+=("$skill_name")
  fi
done

printf 'project skills stay in: %s/.codex/skills\n' "$ROOT"
printf 'global launchers install to: %s\n' "$SKILLS_HOME"

if [ "$dry_run" -eq 1 ]; then
  for skill_name in "${stale_skills[@]}"; do
    printf 'would remove stale managed skill: %s\n' "$skill_name"
  done
  for skill_dir in "$SOURCE_DIR"/*; do
    [ -d "$skill_dir" ] || continue
    printf 'would install: %s\n' "$(basename "$skill_dir")"
  done
  exit 0
fi

mkdir -p "$SKILLS_HOME"

for skill_name in "${stale_skills[@]}"; do
  rm -rf -- "$SKILLS_HOME/$skill_name"
  printf 'removed stale managed skill: %s\n' "$SKILLS_HOME/$skill_name"
done

for skill_dir in "$SOURCE_DIR"/*; do
  [ -d "$skill_dir" ] || continue
  skill_name="$(basename "$skill_dir")"
  dest="$SKILLS_HOME/$skill_name"
  mkdir -p "$dest"
  cp "$skill_dir/SKILL.md" "$dest/SKILL.md"
  printf 'installed: %s\n' "$dest"
done

printf '%s\n' "${current_skills[@]}" >"$MANAGED_FILE"

printf 'done. restart codex or open a new session for newly installed skills to appear in the skill list.\n'
