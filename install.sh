#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
SKILLS_HOME="${SKILLS_HOME:-$CODEX_HOME/skills}"
COPILOT_HOME="${COPILOT_HOME:-$HOME/.copilot}"
COPILOT_SKILLS_HOME="${COPILOT_SKILLS_HOME:-$COPILOT_HOME/skills}"
COPILOT_MCP_CONFIG="${COPILOT_MCP_CONFIG:-$COPILOT_HOME/mcp-config.json}"
COPILOT_MCP_TOOLS_FILE="${COPILOT_MCP_TOOLS_FILE:-$ROOT/config/copilot-mcp-tools.json}"
VAULT_PATH="${VAULT_PATH:-$(python3 -c 'import json, pathlib; print(json.loads((pathlib.Path("'"$ROOT"'") / "config" / "vault.json").read_text())["vault_path"])')}"
PROJECT_SOURCE_DIR="$ROOT/.codex/skills"
PROJECT_SKILLS_DIR="$VAULT_PATH/.codex/skills"
GLOBAL_SOURCE_DIR="$ROOT/global-skills"
COPILOT_SOURCE_DIR="$ROOT/.github/skills"
PROJECT_MANAGED_FILE="$PROJECT_SKILLS_DIR/.dreamers-note-managed-skills"
MANAGED_FILE="$SKILLS_HOME/.dreamers-note-managed-skills"
COPILOT_MANAGED_FILE="$COPILOT_SKILLS_HOME/.dreamers-note-managed-skills"

PROJECT_MANAGED_SKILLS=(
  daily-capture
  daily-triage
  note-add
  note-import
  tag-steward
  vault-normalization
)
LEGACY_MANAGED_SKILLS=(
  dreamers-note-add
  dreamers-note-capture
  dreamers-note-triage
  dreamers-note-normalize
  dreamers-note-tags
)
COPILOT_MANAGED_SKILLS=(
  daily-capture
  daily-triage
  note-add
  note-import
  tag-steward
  vault-normalization
)

usage() {
  cat <<'USAGE'
usage: ./install.sh [--dry-run] [--copilot-mcp]

Installs dreamers-note project skills into the configured vault's
.codex/skills directory, global launcher skills into $CODEX_HOME/skills,
and Copilot project-skill wrappers into $COPILOT_HOME/skills.

Use --copilot-mcp to also create or update the dreamers-note entry in
$COPILOT_HOME/mcp-config.json with a safe non-apply tool allowlist from
config/copilot-mcp-tools.json.

Environment:
  CODEX_HOME             Defaults to $HOME/.codex.
  SKILLS_HOME            Defaults to $CODEX_HOME/skills.
  COPILOT_HOME           Defaults to $HOME/.copilot.
  COPILOT_SKILLS_HOME    Defaults to $COPILOT_HOME/skills.
  COPILOT_MCP_CONFIG     Defaults to $COPILOT_HOME/mcp-config.json.
  COPILOT_MCP_TOOLS_FILE Defaults to config/copilot-mcp-tools.json.
  VAULT_PATH             Defaults to config/vault.json.
USAGE
}

dry_run=0
write_copilot_mcp=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      dry_run=1
      ;;
    --copilot-mcp)
      write_copilot_mcp=1
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

[ -d "$PROJECT_SOURCE_DIR" ] || fail "missing project skill source directory: $PROJECT_SOURCE_DIR"
[ -d "$GLOBAL_SOURCE_DIR" ] || fail "missing global-skills directory"
[ -d "$COPILOT_SOURCE_DIR" ] || fail "missing Copilot skill source directory: $COPILOT_SOURCE_DIR"
[ -f "$COPILOT_MCP_TOOLS_FILE" ] || fail "missing Copilot MCP tools file: $COPILOT_MCP_TOOLS_FILE"
[ -d "$VAULT_PATH" ] || fail "configured vault does not exist: $VAULT_PATH"

is_safe_skill_name() {
  case "$1" in
    ''|*/*|.*|*' '*)
      return 1
      ;;
  esac
}

array_contains() {
  local candidate="$1"
  local current
  shift
  for current in "$@"; do
    [ "$candidate" = "$current" ] && return 0
  done
  return 1
}

append_unique_named() {
  local array_name="$1"
  local value="$2"
  local -n target="$array_name"
  if ! array_contains "$value" "${target[@]}"; then
    target+=("$value")
  fi
}

read_managed_file() {
  local manifest="$1"
  local array_name="$2"
  local -n target="$array_name"
  local skill_name

  [ -f "$manifest" ] || return 0

  while IFS= read -r skill_name; do
    [ -n "$skill_name" ] || continue
    is_safe_skill_name "$skill_name" || fail "unsafe managed skill name: $skill_name"
    append_unique_named "$array_name" "$skill_name"
  done <"$manifest"
}

validate_skill_sources() {
  local label="$1"
  local source_dir="$2"
  local array_name="$3"
  local -n skills="$array_name"
  local skill_name

  for skill_name in "${skills[@]}"; do
    is_safe_skill_name "$skill_name" || fail "unsafe $label skill name: $skill_name"
    [ -f "$source_dir/$skill_name/SKILL.md" ] || fail "missing $label skill: $source_dir/$skill_name/SKILL.md"
  done
}

discover_global_skills() {
  local skill_dir
  local skill_name

  global_skills=()
  for skill_dir in "$GLOBAL_SOURCE_DIR"/*; do
    [ -d "$skill_dir" ] || continue
    [ -f "$skill_dir/SKILL.md" ] || fail "missing SKILL.md in $skill_dir"
    skill_name="$(basename "$skill_dir")"
    is_safe_skill_name "$skill_name" || fail "unsafe skill directory name: $skill_name"
    global_skills+=("$skill_name")
  done
}

compute_stale_skills() {
  local dest_dir="$1"
  local current_array_name="$2"
  local managed_array_name="$3"
  local stale_array_name="$4"
  local -n current_skills="$current_array_name"
  local -n managed_skills="$managed_array_name"
  local -n stale_result="$stale_array_name"
  local skill_name

  stale_result=()
  for skill_name in "${managed_skills[@]}"; do
    if ! array_contains "$skill_name" "${current_skills[@]}" && [ -e "$dest_dir/$skill_name" ]; then
      stale_result+=("$skill_name")
    fi
  done
}

ensure_no_unmanaged_conflicts() {
  local label="$1"
  local dest_dir="$2"
  local current_array_name="$3"
  local managed_array_name="$4"
  local -n current_skills="$current_array_name"
  local -n managed_skills="$managed_array_name"
  local skill_name

  for skill_name in "${current_skills[@]}"; do
    if [ -e "$dest_dir/$skill_name" ] && ! array_contains "$skill_name" "${managed_skills[@]}"; then
      fail "$label skill exists but is not managed by dreamers-note: $dest_dir/$skill_name"
    fi
  done
}

print_sync_plan() {
  local install_prefix="$1"
  local remove_prefix="$2"
  local current_array_name="$3"
  local stale_array_name="$4"
  local -n current_skills="$current_array_name"
  local -n stale_plan="$stale_array_name"
  local skill_name

  for skill_name in "${stale_plan[@]}"; do
    printf 'would %s %s\n' "$remove_prefix" "$skill_name"
  done
  for skill_name in "${current_skills[@]}"; do
    printf 'would %s %s\n' "$install_prefix" "$skill_name"
  done
}

sync_managed_skill_set() {
  local source_dir="$1"
  local dest_dir="$2"
  local manifest="$3"
  local current_array_name="$4"
  local stale_array_name="$5"
  local install_prefix="$6"
  local remove_prefix="$7"
  local -n current_skills="$current_array_name"
  local -n stale_sync="$stale_array_name"
  local skill_name
  local dest

  mkdir -p "$dest_dir"

  for skill_name in "${stale_sync[@]}"; do
    rm -rf -- "$dest_dir/$skill_name"
    printf '%s %s\n' "$remove_prefix" "$dest_dir/$skill_name"
  done

  for skill_name in "${current_skills[@]}"; do
    dest="$dest_dir/$skill_name"
    mkdir -p "$dest"
    cp "$source_dir/$skill_name/SKILL.md" "$dest/SKILL.md"
    printf '%s %s\n' "$install_prefix" "$dest"
  done

  printf '%s\n' "${current_skills[@]}" >"$manifest"
}

read_copilot_tools_json() {
  DREAMERS_NOTE_COPILOT_TOOLS_FILE="$COPILOT_MCP_TOOLS_FILE" python3 - <<'PY'
import json
import os
import pathlib
import sys

path = pathlib.Path(os.environ["DREAMERS_NOTE_COPILOT_TOOLS_FILE"])
try:
    tools = json.loads(path.read_text(encoding="utf-8"))
except json.JSONDecodeError as exc:
    print(f"invalid Copilot MCP tools JSON in {path}: {exc}", file=sys.stderr)
    sys.exit(1)

if (
    not isinstance(tools, list)
    or not tools
    or any(not isinstance(tool, str) or not tool for tool in tools)
):
    print(f"Copilot MCP tools file must be a non-empty JSON string array: {path}", file=sys.stderr)
    sys.exit(1)

print("\n".join(tools))
PY
}

write_copilot_mcp_config() {
  DREAMERS_NOTE_COPILOT_MCP_CONFIG="$COPILOT_MCP_CONFIG" \
    DREAMERS_NOTE_COPILOT_ROOT="$ROOT" \
    DREAMERS_NOTE_COPILOT_TOOLS_FILE="$COPILOT_MCP_TOOLS_FILE" \
    python3 - <<'PY'
import json
import os
import pathlib
import sys

config_path = pathlib.Path(os.environ["DREAMERS_NOTE_COPILOT_MCP_CONFIG"]).expanduser()
root = os.environ["DREAMERS_NOTE_COPILOT_ROOT"]
tools_path = pathlib.Path(os.environ["DREAMERS_NOTE_COPILOT_TOOLS_FILE"])

try:
    tools = json.loads(tools_path.read_text(encoding="utf-8"))
except json.JSONDecodeError as exc:
    print(f"invalid Copilot MCP tools JSON in {tools_path}: {exc}", file=sys.stderr)
    sys.exit(1)

if (
    not isinstance(tools, list)
    or not tools
    or any(not isinstance(tool, str) or not tool for tool in tools)
):
    print(f"Copilot MCP tools file must be a non-empty JSON string array: {tools_path}", file=sys.stderr)
    sys.exit(1)

if config_path.exists():
    try:
        data = json.loads(config_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"invalid Copilot MCP JSON in {config_path}: {exc}", file=sys.stderr)
        sys.exit(1)
    if not isinstance(data, dict):
        print(f"Copilot MCP config must be a JSON object: {config_path}", file=sys.stderr)
        sys.exit(1)
else:
    data = {}

servers = data.get("mcpServers")
if servers is None:
    servers = {}
elif not isinstance(servers, dict):
    print(f"Copilot MCP config mcpServers must be an object: {config_path}", file=sys.stderr)
    sys.exit(1)

servers["dreamers-note"] = {
    "type": "stdio",
    "command": "node",
    "args": [str(pathlib.Path(root) / "dist" / "cli.js"), "mcp", "--root", root],
    "tools": tools,
}
data["mcpServers"] = servers

config_path.parent.mkdir(parents=True, exist_ok=True)
config_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
}

validate_copilot_mcp_config() {
  DREAMERS_NOTE_COPILOT_MCP_CONFIG="$COPILOT_MCP_CONFIG" \
    DREAMERS_NOTE_COPILOT_TOOLS_FILE="$COPILOT_MCP_TOOLS_FILE" \
    python3 - <<'PY'
import json
import os
import pathlib
import sys

config_path = pathlib.Path(os.environ["DREAMERS_NOTE_COPILOT_MCP_CONFIG"]).expanduser()
tools_path = pathlib.Path(os.environ["DREAMERS_NOTE_COPILOT_TOOLS_FILE"])

try:
    tools = json.loads(tools_path.read_text(encoding="utf-8"))
except json.JSONDecodeError as exc:
    print(f"invalid Copilot MCP tools JSON in {tools_path}: {exc}", file=sys.stderr)
    sys.exit(1)

if (
    not isinstance(tools, list)
    or not tools
    or any(not isinstance(tool, str) or not tool for tool in tools)
):
    print(f"Copilot MCP tools file must be a non-empty JSON string array: {tools_path}", file=sys.stderr)
    sys.exit(1)

if not config_path.exists():
    sys.exit(0)

try:
    data = json.loads(config_path.read_text(encoding="utf-8"))
except json.JSONDecodeError as exc:
    print(f"invalid Copilot MCP JSON in {config_path}: {exc}", file=sys.stderr)
    sys.exit(1)

if not isinstance(data, dict):
    print(f"Copilot MCP config must be a JSON object: {config_path}", file=sys.stderr)
    sys.exit(1)

servers = data.get("mcpServers")
if servers is not None and not isinstance(servers, dict):
    print(f"Copilot MCP config mcpServers must be an object: {config_path}", file=sys.stderr)
    sys.exit(1)
PY
}

project_skills=("${PROJECT_MANAGED_SKILLS[@]}")
copilot_skills=("${COPILOT_MANAGED_SKILLS[@]}")
discover_global_skills
validate_skill_sources "project" "$PROJECT_SOURCE_DIR" project_skills
validate_skill_sources "Copilot" "$COPILOT_SOURCE_DIR" copilot_skills

project_managed_candidates=()
global_managed_candidates=()
copilot_managed_candidates=()

read_managed_file "$PROJECT_MANAGED_FILE" project_managed_candidates
for skill_name in "${LEGACY_MANAGED_SKILLS[@]}"; do
  append_unique_named global_managed_candidates "$skill_name"
done
read_managed_file "$MANAGED_FILE" global_managed_candidates
read_managed_file "$COPILOT_MANAGED_FILE" copilot_managed_candidates

compute_stale_skills "$PROJECT_SKILLS_DIR" project_skills project_managed_candidates stale_project_skills
compute_stale_skills "$SKILLS_HOME" global_skills global_managed_candidates stale_skills
compute_stale_skills "$COPILOT_SKILLS_HOME" copilot_skills copilot_managed_candidates stale_copilot_skills
ensure_no_unmanaged_conflicts "Copilot" "$COPILOT_SKILLS_HOME" copilot_skills copilot_managed_candidates
read_copilot_tools_json >/dev/null
empty_skills=()

if [ "$write_copilot_mcp" -eq 1 ]; then
  validate_copilot_mcp_config
fi

printf 'project skills install to: %s\n' "$PROJECT_SKILLS_DIR"
printf 'global launchers install to: %s\n' "$SKILLS_HOME"
printf 'Copilot skills install to: %s\n' "$COPILOT_SKILLS_HOME"
if [ "$write_copilot_mcp" -eq 1 ]; then
  printf 'Copilot MCP config: %s\n' "$COPILOT_MCP_CONFIG"
fi

if [ "$dry_run" -eq 1 ]; then
  print_sync_plan "install project skill:" "remove stale managed project skill:" project_skills stale_project_skills
  print_sync_plan "install:" "remove stale managed skill:" global_skills stale_skills
  print_sync_plan "install Copilot skill:" "remove stale managed Copilot skill:" copilot_skills stale_copilot_skills
  if [ "$write_copilot_mcp" -eq 1 ]; then
    printf 'would update Copilot MCP config: %s\n' "$COPILOT_MCP_CONFIG"
  fi
  exit 0
fi

sync_managed_skill_set "$PROJECT_SOURCE_DIR" "$PROJECT_SKILLS_DIR" "$PROJECT_MANAGED_FILE" project_skills stale_project_skills "installed project skill:" "removed stale managed project skill:"
sync_managed_skill_set "$GLOBAL_SOURCE_DIR" "$SKILLS_HOME" "$MANAGED_FILE" global_skills stale_skills "installed:" "removed stale managed skill:"
sync_managed_skill_set "$COPILOT_SOURCE_DIR" "$COPILOT_SKILLS_HOME" "$COPILOT_MANAGED_FILE" copilot_skills stale_copilot_skills "installed Copilot skill:" "removed stale managed Copilot skill:"

if [ "$write_copilot_mcp" -eq 1 ]; then
  write_copilot_mcp_config
  printf 'updated Copilot MCP config: %s\n' "$COPILOT_MCP_CONFIG"
fi

printf 'done. restart codex, copilot, or open a new session for newly installed skills to appear in the skill list.\n'
