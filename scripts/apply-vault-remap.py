#!/usr/bin/env python3
"""Apply reviewed AI vault remap decisions deterministically."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

from vault_remap_common import (
    TARGET_FOLDERS,
    WIKILINK_RE,
    default_vault_path,
    ensure_inside_vault,
    extract_markdown_links,
    extract_wikilinks,
    is_excluded,
    load_approved_tags,
)


MARKDOWN_LINK_FULL_RE = re.compile(r"(!?)\[([^\]]*)\]\(([^)]+)\)")
REQUIRED_REVIEW_SCOPE = {"placement", "tags", "links", "content"}
CLASSIFIED_NOTE_FOLDERS = {
    "01-projects": "project notes must use 01-projects/<main>/<sub>/<note>.md",
    "02-knowledge": "knowledge notes must use 02-knowledge/<main>/<sub>/<note>.md",
    "05-people": "people notes must use 05-people/<main>/<sub>/<note>.md",
}


def framework_root() -> Path:
    return Path(__file__).resolve().parents[1]


def default_indexes_path() -> Path:
    return framework_root() / "indexes"


def run_git(vault_path: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(vault_path), *args],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def git_info(vault_path: Path) -> tuple[str, str] | None:
    inside = run_git(vault_path, "rev-parse", "--is-inside-work-tree")
    if inside.returncode != 0 or inside.stdout.strip() != "true":
        return None
    branch = run_git(vault_path, "branch", "--show-current")
    status = run_git(vault_path, "status", "--short")
    return branch.stdout.strip() or "detached-head", status.stdout.rstrip()


def read_jsonl(path: Path) -> list[dict[str, object]]:
    if not path.exists():
        raise FileNotFoundError(f"missing decisions file: {path}")
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def write_jsonl(path: Path, records: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(record, sort_keys=True) + "\n" for record in records),
        encoding="utf-8",
    )


def reviewed_decisions(records: list[dict[str, object]]) -> list[dict[str, object]]:
    return [record for record in records if record.get("reviewed") is True]


def validate_classified_note_target(target_path: Path) -> str | None:
    if not target_path.parts or target_path.parts[0] not in CLASSIFIED_NOTE_FOLDERS:
        return None
    if target_path.suffix.lower() == ".md" and len(target_path.parts) != 4:
        return CLASSIFIED_NOTE_FOLDERS[target_path.parts[0]]
    if len(target_path.parts) > 4:
        return f"{target_path.parts[0]} targets cannot nest deeper than main/sub"
    return None


def validate_review_scope(decision: dict[str, object], source: str) -> list[str]:
    scope = set(str(item) for item in decision.get("reviewed_scope", []))
    missing = sorted(REQUIRED_REVIEW_SCOPE - scope)
    if missing:
        return [f"reviewed decision for {source} missing scope: {', '.join(missing)}"]
    return []


def validate_target_path(target: str) -> list[str]:
    errors: list[str] = []
    target_path = Path(target)
    if not target_path.parts or target_path.parts[0] not in TARGET_FOLDERS:
        errors.append(f"target outside approved folders: {target}")
    classified_error = validate_classified_note_target(target_path)
    if classified_error:
        errors.append(f"{classified_error}: {target}")
    return errors


def validate_extracted_notes(
    vault_path: Path,
    decision: dict[str, object],
    approved_tags: set[str],
    extraction_targets: set[str],
    move_targets: dict[str, str],
) -> list[str]:
    errors: list[str] = []
    source = str(decision.get("source_path", ""))
    for note in decision.get("extracted_notes", []):
        if not isinstance(note, dict):
            errors.append(f"invalid extracted note for {source}")
            continue
        target = str(note.get("target_path", ""))
        if not target:
            errors.append(f"extracted note missing target_path for {source}")
            continue
        errors.extend(validate_target_path(target))
        if Path(target).suffix.lower() != ".md":
            errors.append(f"extracted note target must be markdown: {target}")
        try:
            ensure_inside_vault(vault_path, vault_path / target)
        except ValueError:
            errors.append(f"extracted note outside vault: {target}")
        if (vault_path / target).exists():
            errors.append(f"extracted note target already exists: {target}")
        if target in move_targets:
            errors.append(f"extracted note target collides with move target: {target}")
        if target in extraction_targets:
            errors.append(f"extracted note target collision: {target}")
        extraction_targets.add(target)
        if not str(note.get("title", "")).strip():
            errors.append(f"extracted note missing title: {target}")
        if not str(note.get("body", "")).strip():
            errors.append(f"extracted note missing body: {target}")
        for tag in note.get("approved_tags", []):
            if tag not in approved_tags:
                errors.append(f"unapproved tag in extracted note for {source}: {tag}")
    return errors


def validate_decisions(
    vault_path: Path, decisions: list[dict[str, object]], approved_tags: set[str]
) -> list[str]:
    errors: list[str] = []
    targets: dict[str, str] = {}
    extraction_targets: set[str] = set()
    for decision in decisions:
        source = str(decision.get("source_path", ""))
        target = str(decision.get("target_path", ""))
        if not source or not target:
            errors.append("decision missing source_path or target_path")
            continue
        errors.extend(validate_review_scope(decision, source))
        questions = decision.get("unresolved_questions", [])
        if questions:
            errors.append(f"unresolved questions for {source}")
        errors.extend(validate_target_path(target))
        if target in targets and targets[target] != source:
            errors.append(f"target collision: {target}")
        targets[target] = source
        source_abs = vault_path / source
        target_abs = vault_path / target
        try:
            ensure_inside_vault(vault_path, source_abs)
            ensure_inside_vault(vault_path, target_abs)
        except ValueError:
            errors.append(f"path outside vault: {source} -> {target}")
            continue
        if not source_abs.exists():
            errors.append(f"missing source file: {source}")
        if target_abs.exists() and source_abs.resolve() != target_abs.resolve():
            errors.append(f"target already exists: {target}")
        for tag in decision.get("approved_tags", []):
            if tag not in approved_tags:
                errors.append(f"unapproved tag in decision for {source}: {tag}")
        for link in decision.get("links_to_add", []):
            if not str(link).strip():
                errors.append(f"blank link target in decision for {source}")
        errors.extend(
            validate_extracted_notes(
                vault_path, decision, approved_tags, extraction_targets, targets
            )
        )
    return errors


def note_tokens(source_path: str) -> set[str]:
    path = Path(source_path)
    without_suffix = path.with_suffix("").as_posix()
    return {source_path, without_suffix, path.name, path.stem}


def asset_tokens(source_path: str) -> set[str]:
    path = Path(source_path)
    return {source_path, path.name}


def build_reference_maps(
    decisions: list[dict[str, object]]
) -> tuple[dict[str, str], dict[str, str], dict[str, str]]:
    note_map: dict[str, str] = {}
    asset_map: dict[str, str] = {}
    basename_aliases: dict[str, str] = {}
    for decision in decisions:
        source = str(decision["source_path"])
        target = str(decision["target_path"])
        source_path = Path(source)
        if source_path.suffix.lower() == ".md":
            target_without_suffix = Path(target).with_suffix("").as_posix()
            for token in note_tokens(source):
                note_map[token] = target_without_suffix
            basename_aliases[source_path.stem] = source_path.stem
        else:
            for token in asset_tokens(source):
                asset_map[token] = target
    return note_map, asset_map, basename_aliases


def rewrite_wikilinks(text: str, note_map: dict[str, str], asset_map: dict[str, str]) -> str:
    def replace(match: re.Match[str]) -> str:
        raw = match.group(0)
        inner = match.group(1)
        target_part, *alias_part = inner.split("|", 1)
        anchor = ""
        if "#" in target_part:
            target_base, anchor = target_part.split("#", 1)
            anchor = f"#{anchor}"
        else:
            target_base = target_part
        replacement = asset_map.get(target_base)
        is_embed = raw.startswith("!")
        if replacement is None:
            replacement = note_map.get(target_base)
        if replacement is None:
            return raw
        alias = alias_part[0] if alias_part else ""
        if not alias and not is_embed and Path(target_base).suffix.lower() != ".md":
            alias = Path(target_base).stem
        alias_text = f"|{alias}" if alias else ""
        return f"{'!' if is_embed else ''}[[{replacement}{anchor}{alias_text}]]"

    return WIKILINK_RE.sub(replace, text)


def rewrite_markdown_links(text: str, note_map: dict[str, str], asset_map: dict[str, str]) -> str:
    def replace(match: re.Match[str]) -> str:
        prefix, label, target = match.groups()
        anchor = ""
        target_base = target
        if "#" in target:
            target_base, anchor = target.split("#", 1)
            anchor = f"#{anchor}"
        replacement = asset_map.get(target_base)
        if replacement is None:
            replacement = asset_map.get(Path(target_base).name)
        if replacement is None:
            note_replacement = note_map.get(target_base)
            if note_replacement is not None:
                replacement = f"{note_replacement}.md"
        if replacement is None:
            note_replacement = note_map.get(Path(target_base).with_suffix("").as_posix())
            if note_replacement is not None:
                replacement = f"{note_replacement}.md"
        if replacement is None:
            return match.group(0)
        return f"{prefix}[{label}]({replacement}{anchor})"

    return MARKDOWN_LINK_FULL_RE.sub(replace, text)


def set_frontmatter_tags(text: str, tags: list[str]) -> str:
    tag_lines = ["tags:", *[f"  - {tag}" for tag in sorted(tags)]]
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end != -1:
            frontmatter = text[4:end].splitlines()
            new_frontmatter: list[str] = []
            skip_tags = False
            for line in frontmatter:
                stripped = line.strip()
                if stripped == "tags:" or stripped.startswith("tags:"):
                    skip_tags = True
                    continue
                if skip_tags and stripped.startswith("- "):
                    continue
                skip_tags = False
                new_frontmatter.append(line)
            new_frontmatter.extend(tag_lines)
            return "---\n" + "\n".join(new_frontmatter).strip() + "\n---\n" + text[end + 5 :]
    return "---\n" + "\n".join(tag_lines) + "\n---\n" + text


def wikilink_for(target: str) -> str:
    stripped = target.strip()
    if stripped.startswith("[[") and stripped.endswith("]]"):
        return stripped
    return f"[[{Path(stripped).with_suffix('').as_posix()}]]"


def append_links(text: str, links: list[str]) -> str:
    bullets = [f"- {wikilink_for(link)}" for link in links if str(link).strip()]
    missing = [bullet for bullet in bullets if bullet not in text]
    if not missing:
        return text
    addition = "\n".join(missing)
    if "## links" in text:
        return text.rstrip() + "\n" + addition + "\n"
    return text.rstrip() + "\n\n## links\n\n" + addition + "\n"


def move_files(vault_path: Path, decisions: list[dict[str, object]]) -> None:
    for decision in sorted(
        decisions, key=lambda item: len(Path(str(item["source_path"])).parts), reverse=True
    ):
        source = vault_path / str(decision["source_path"])
        target = vault_path / str(decision["target_path"])
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(source), str(target))


def render_extracted_note(note: dict[str, object], source_target: str) -> str:
    tags = [str(tag) for tag in note.get("approved_tags", [])]
    lines: list[str] = []
    if tags:
        lines.extend(["---", "tags:"])
        lines.extend(f"  - {tag}" for tag in sorted(tags))
        lines.extend(["---", ""])
    lines.extend(
        [
            f"# {str(note['title']).strip()}",
            "",
            f"source: {wikilink_for(source_target)}",
            "",
            "## notes",
            "",
            str(note["body"]).strip(),
        ]
    )
    links = [str(link) for link in note.get("links_to_add", [])]
    if links:
        lines.extend(["", "## links", ""])
        lines.extend(f"- {wikilink_for(link)}" for link in links)
    return "\n".join(lines).rstrip() + "\n"


def create_extracted_notes(vault_path: Path, decisions: list[dict[str, object]]) -> None:
    for decision in decisions:
        source_target = str(decision["target_path"])
        for note in decision.get("extracted_notes", []):
            target = vault_path / str(note["target_path"])
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(render_extracted_note(note, source_target), encoding="utf-8")


def rewrite_markdown_files(
    vault_path: Path,
    decisions: list[dict[str, object]],
    note_map: dict[str, str],
    asset_map: dict[str, str],
) -> int:
    tag_updates = {
        str(decision["target_path"]): list(decision.get("approved_tags", []))
        for decision in decisions
        if Path(str(decision["target_path"])).suffix.lower() == ".md"
        and decision.get("approved_tags")
    }
    link_updates = {
        str(decision["target_path"]): [str(link) for link in decision.get("links_to_add", [])]
        for decision in decisions
        if Path(str(decision["target_path"])).suffix.lower() == ".md"
    }
    unresolved_references = 0
    old_tokens = set(note_map) | set(asset_map)
    for markdown_file in sorted(vault_path.rglob("*.md")):
        if is_excluded(markdown_file.relative_to(vault_path)):
            continue
        relative = markdown_file.relative_to(vault_path).as_posix()
        text = markdown_file.read_text(encoding="utf-8")
        text = rewrite_wikilinks(text, note_map, asset_map)
        text = rewrite_markdown_links(text, note_map, asset_map)
        if relative in tag_updates:
            text = set_frontmatter_tags(text, tag_updates[relative])
        if relative in link_updates:
            text = append_links(text, link_updates[relative])
        unresolved_references += sum(
            1
            for reference in [*extract_wikilinks(text), *extract_markdown_links(text)]
            if reference in old_tokens or Path(reference).name in old_tokens
        )
        markdown_file.write_text(text, encoding="utf-8")
    return unresolved_references


def collect_tag_proposals(
    decisions: list[dict[str, object]], existing_records: list[dict[str, object]]
) -> list[dict[str, object]]:
    proposals: dict[str, dict[str, object]] = {}
    for record in existing_records:
        tag = str(record.get("tag", ""))
        if not tag:
            continue
        source_paths = [
            str(source_path)
            for source_path in record.get("source_paths", [])
            if str(source_path)
        ]
        proposals[tag] = {
            "tag": tag,
            "source_paths": source_paths,
            "status": str(record.get("status", "proposed")),
        }
    for decision in decisions:
        for tag in decision.get("proposed_new_tags", []):
            proposals.setdefault(
                str(tag),
                {
                    "tag": str(tag),
                    "source_paths": [],
                    "status": "proposed",
                },
            )
            source_paths = proposals[str(tag)]["source_paths"]
            source_path = str(decision["source_path"])
            if source_path not in source_paths:
                source_paths.append(source_path)
        for note in decision.get("extracted_notes", []):
            if not isinstance(note, dict):
                continue
            for tag in note.get("proposed_new_tags", []):
                proposals.setdefault(
                    str(tag),
                    {
                        "tag": str(tag),
                        "source_paths": [],
                        "status": "proposed",
                    },
                )
                source_paths = proposals[str(tag)]["source_paths"]
                source_path = str(decision["source_path"])
                if source_path not in source_paths:
                    source_paths.append(source_path)
    return [proposals[tag] for tag in sorted(proposals)]


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Apply reviewed vault remap decisions.")
    parser.add_argument("--vault", default=None, help="Vault path. Defaults to config/vault.json.")
    parser.add_argument("--indexes", default=None, help="Index directory. Defaults to indexes/.")
    parser.add_argument(
        "--tags",
        default=str(framework_root() / "taxonomy" / "approved-tags.md"),
        help="Approved tags markdown file.",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    vault_path = Path(args.vault).expanduser().resolve() if args.vault else default_vault_path()
    indexes_path = Path(args.indexes).expanduser().resolve() if args.indexes else default_indexes_path()
    git_state = git_info(vault_path)
    if git_state is None:
        print("error: vault is not a git repository", file=sys.stderr)
        return 2
    branch, status = git_state
    print(f"vault branch: {branch}")
    print("vault status: clean" if not status else f"vault status:\n{status}")
    try:
        records = read_jsonl(indexes_path / "ai-review-decisions.jsonl")
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    decisions = reviewed_decisions(records)
    approved_tags = load_approved_tags(Path(args.tags).expanduser().resolve())
    errors = validate_decisions(vault_path, decisions, approved_tags)
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 2
    note_map, asset_map, _ = build_reference_maps(decisions)
    move_files(vault_path, decisions)
    create_extracted_notes(vault_path, decisions)
    unresolved_references = rewrite_markdown_files(vault_path, decisions, note_map, asset_map)
    tag_proposals_path = indexes_path / "tag-proposals.jsonl"
    existing_tag_proposals = read_jsonl(tag_proposals_path) if tag_proposals_path.exists() else []
    write_jsonl(
        tag_proposals_path,
        collect_tag_proposals(decisions, existing_tag_proposals),
    )
    print(f"applied decisions: {len(decisions)}")
    print(f"unresolved references: {unresolved_references}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
