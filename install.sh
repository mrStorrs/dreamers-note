#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
SKILLS_HOME="${SKILLS_HOME:-$CODEX_HOME/skills}"
PROJECT_SKILLS_DIR="$ROOT/.codex/skills"
GLOBAL_SOURCE_DIR="$ROOT/global-skills"
PROJECT_MANAGED_FILE="$PROJECT_SKILLS_DIR/.dreamers-note-managed-skills"
MANAGED_FILE="$SKILLS_HOME/.dreamers-note-managed-skills"
PROJECT_MANAGED_SKILLS=(
  daily-capture
  daily-triage
  tag-steward
  vault-normalization
)
LEGACY_MANAGED_SKILLS=(
  dreamers-note-capture
  dreamers-note-triage
  dreamers-note-normalize
  dreamers-note-tags
)

usage() {
  cat <<'USAGE'
usage: ./install.sh [--dry-run]

Installs dreamers-note project skills into .codex/skills and global
launcher skills into $CODEX_HOME/skills.

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

[ -d "$PROJECT_SKILLS_DIR" ] || fail "missing .codex/skills directory"
[ -d "$GLOBAL_SOURCE_DIR" ] || fail "missing global-skills directory"

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
  shift
  for current in "$@"; do
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

project_skills=()

for skill_name in "${PROJECT_MANAGED_SKILLS[@]}"; do
  is_safe_skill_name "$skill_name" || fail "unsafe project skill name: $skill_name"
  [ -f "$PROJECT_SKILLS_DIR/$skill_name/SKILL.md" ] || fail "missing project skill: $PROJECT_SKILLS_DIR/$skill_name/SKILL.md"
  project_skills+=("$skill_name")
done

project_managed_candidates=()

if [ -f "$PROJECT_MANAGED_FILE" ]; then
  while IFS= read -r skill_name; do
    [ -n "$skill_name" ] || continue
    is_safe_skill_name "$skill_name" || fail "unsafe managed project skill name: $skill_name"
    project_managed_candidates+=("$skill_name")
  done <"$PROJECT_MANAGED_FILE"
fi

stale_project_skills=()

for skill_name in "${project_managed_candidates[@]}"; do
  if ! has_current_skill "$skill_name" "${project_skills[@]}" && [ -e "$PROJECT_SKILLS_DIR/$skill_name" ]; then
    stale_project_skills+=("$skill_name")
  fi
done

global_skills=()

for skill_dir in "$GLOBAL_SOURCE_DIR"/*; do
  [ -d "$skill_dir" ] || continue
  [ -f "$skill_dir/SKILL.md" ] || fail "missing SKILL.md in $skill_dir"
  skill_name="$(basename "$skill_dir")"
  is_safe_skill_name "$skill_name" || fail "unsafe skill directory name: $skill_name"
  global_skills+=("$skill_name")
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
  if ! has_current_skill "$skill_name" "${global_skills[@]}" && [ -e "$SKILLS_HOME/$skill_name" ]; then
    stale_skills+=("$skill_name")
  fi
done

printf 'project skills install to: %s\n' "$PROJECT_SKILLS_DIR"
printf 'global launchers install to: %s\n' "$SKILLS_HOME"

if [ "$dry_run" -eq 1 ]; then
  for skill_name in "${stale_project_skills[@]}"; do
    printf 'would remove stale managed project skill: %s\n' "$skill_name"
  done
  for skill_name in "${project_skills[@]}"; do
    printf 'would install project skill: %s\n' "$skill_name"
  done
  for skill_name in "${stale_skills[@]}"; do
    printf 'would remove stale managed skill: %s\n' "$skill_name"
  done
  for skill_dir in "$GLOBAL_SOURCE_DIR"/*; do
    [ -d "$skill_dir" ] || continue
    printf 'would install: %s\n' "$(basename "$skill_dir")"
  done
  exit 0
fi

mkdir -p "$SKILLS_HOME"

for skill_name in "${stale_project_skills[@]}"; do
  rm -rf -- "$PROJECT_SKILLS_DIR/$skill_name"
  printf 'removed stale managed project skill: %s\n' "$PROJECT_SKILLS_DIR/$skill_name"
done

for skill_name in "${project_skills[@]}"; do
  printf 'installed project skill: %s\n' "$PROJECT_SKILLS_DIR/$skill_name"
done

printf '%s\n' "${project_skills[@]}" >"$PROJECT_MANAGED_FILE"

for skill_name in "${stale_skills[@]}"; do
  rm -rf -- "$SKILLS_HOME/$skill_name"
  printf 'removed stale managed skill: %s\n' "$SKILLS_HOME/$skill_name"
done

for skill_dir in "$GLOBAL_SOURCE_DIR"/*; do
  [ -d "$skill_dir" ] || continue
  skill_name="$(basename "$skill_dir")"
  dest="$SKILLS_HOME/$skill_name"
  mkdir -p "$dest"
  cp "$skill_dir/SKILL.md" "$dest/SKILL.md"
  printf 'installed: %s\n' "$dest"
done

printf '%s\n' "${global_skills[@]}" >"$MANAGED_FILE"

printf 'done. restart codex or open a new session for newly installed skills to appear in the skill list.\n'
