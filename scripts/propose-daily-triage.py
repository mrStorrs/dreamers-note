#!/usr/bin/env python3
"""Dry-run proposal helper for daily-note triage."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


FRAGMENT_HEADING = re.compile(r"^##\s+(project|knowledge|area|source|person):\s+(.+?)\s*$", re.IGNORECASE)
HASHTAG = re.compile(r"(?<!\w)#([a-zA-Z][a-zA-Z0-9_-]*)")
TAGS_LINE = re.compile(r"\btags?\s*:\s*(.+)$", re.IGNORECASE | re.MULTILINE)
DESTINATION_DIRS = {
    "project": "01-projects",
    "source": "04-sources",
    "person": "05-people",
}
CLASSIFIED_NOTE_DIRS = {"project", "person"}


def framework_root() -> Path:
    return Path(__file__).resolve().parents[1]


def default_vault_path() -> Path:
    config_path = framework_root() / "config" / "vault.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    return Path(config["vault_path"]).expanduser().resolve()


@dataclass(frozen=True)
class Fragment:
    source_path: Path
    kind: str
    title: str
    body: str
    destination: Path
    approved_tags: tuple[str, ...]
    proposed_tags: tuple[str, ...]

    @property
    def excerpt(self) -> str:
        compact = " ".join(self.body.split())
        return compact[:180] + ("..." if len(compact) > 180 else "")

    @property
    def backlink(self) -> str:
        return f"[[{self.source_path.stem}]]"


def slugify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    value = re.sub(r"-{2,}", "-", value).strip("-")
    return value or "untitled"


def load_approved_tags(path: Path) -> set[str]:
    tags: set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("- "):
            tag = stripped[2:].strip()
            if tag and not tag.startswith("["):
                tags.add(tag)
    return tags


def extract_candidate_tags(body: str) -> list[str]:
    candidates: list[str] = []
    candidates.extend(match.group(1).lower() for match in HASHTAG.finditer(body))
    for match in TAGS_LINE.finditer(body):
        parts = re.split(r"[,#\s]+", match.group(1))
        candidates.extend(part.strip().lower() for part in parts if part.strip())
    return sorted(set(candidates))


def area_destination(title: str) -> Path:
    return classified_note_destination("02-knowledge", title)


def classified_note_destination(root: str, title: str) -> Path:
    parts = [slugify(part) for part in title.split("/") if part.strip()]
    if len(parts) >= 3:
        main = parts[0]
        sub = parts[1]
        note_name = "-".join(parts[2:])
    elif len(parts) == 2:
        main = parts[0]
        sub = "general"
        note_name = parts[1]
    elif len(parts) == 1:
        main = "uncategorized"
        sub = "general"
        note_name = parts[0]
    else:
        main = "uncategorized"
        sub = "general"
        note_name = "untitled"
    return Path(root) / main / sub / f"{note_name}.md"


def fragment_destination(kind: str, title: str) -> Path:
    if kind in {"knowledge", "area"}:
        return area_destination(title)
    if kind in CLASSIFIED_NOTE_DIRS:
        return classified_note_destination(DESTINATION_DIRS[kind], title)
    return Path(DESTINATION_DIRS[kind]) / f"{slugify(title)}.md"


def resolve_note_path(vault: Path, raw_path: str) -> Path:
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = vault / path
    resolved = path.resolve()
    try:
        resolved.relative_to(vault)
    except ValueError as exc:
        raise ValueError(f"selected note is outside the vault: {raw_path}") from exc
    if not resolved.is_file():
        raise ValueError(f"selected note does not exist: {raw_path}")
    if resolved.suffix.lower() != ".md":
        raise ValueError(f"selected note is not markdown: {raw_path}")
    return resolved


def parse_fragments(vault: Path, note_path: Path, approved_tags: set[str]) -> list[Fragment]:
    lines = note_path.read_text(encoding="utf-8").splitlines()
    starts: list[tuple[int, str, str]] = []
    for index, line in enumerate(lines):
        match = FRAGMENT_HEADING.match(line)
        if match:
            starts.append((index, match.group(1).lower(), match.group(2).strip()))

    fragments: list[Fragment] = []
    for position, (start, kind, title) in enumerate(starts):
        end = starts[position + 1][0] if position + 1 < len(starts) else len(lines)
        body = "\n".join(lines[start + 1 : end]).strip()
        candidates = extract_candidate_tags(body)
        approved = tuple(tag for tag in candidates if tag in approved_tags)
        proposed = tuple(tag for tag in candidates if tag not in approved_tags)
        destination = fragment_destination(kind, title)
        fragments.append(
            Fragment(
                source_path=note_path.relative_to(vault),
                kind=kind,
                title=title,
                body=body,
                destination=destination,
                approved_tags=approved,
                proposed_tags=proposed,
            )
        )
    return fragments


def git_changed_paths(vault: Path) -> set[str]:
    changed: set[str] = set()
    result = subprocess.run(
        ["git", "-C", str(vault), "diff", "--name-only", "HEAD", "--"],
        check=False,
        text=True,
        capture_output=True,
    )
    if result.returncode == 0:
        changed.update(line.strip() for line in result.stdout.splitlines() if line.strip())
    return changed


def remove_unapproved_hashtags(body: str, approved_tags: tuple[str, ...]) -> str:
    approved = set(approved_tags)

    def replace(match: re.Match[str]) -> str:
        tag = match.group(1).lower()
        return match.group(0) if tag in approved else tag

    return HASHTAG.sub(replace, body)


def render_note_stub(fragment: Fragment) -> str:
    lines = [f"# {fragment.title}", "", f"source: {fragment.backlink}"]
    if fragment.approved_tags:
        lines.extend(["", "tags:"])
        lines.extend(f"- {tag}" for tag in fragment.approved_tags)
    lines.extend(["", "## notes", "", remove_unapproved_hashtags(fragment.body.strip(), fragment.approved_tags)])
    return "\n".join(lines).rstrip() + "\n"


def render_proposal(vault: Path, notes: list[Path], fragments: list[Fragment], archive: bool) -> str:
    changed = git_changed_paths(vault) if archive else set()
    lines = [
        "# daily triage proposal",
        "",
        "## source notes",
    ]
    for note in notes:
        lines.append(f"- `{note.relative_to(vault)}`")

    lines.extend(
        [
            "",
            "## extracted fragments",
            "",
            "| source | kind | title | proposed destination | destination state | approved tags | proposed new tags | backlink |",
            "|---|---|---|---|---|---|---|---|",
        ]
    )
    if not fragments:
        lines.append("| - | - | - | - | - | - | - | - |")
    for fragment in fragments:
        approved = ", ".join(fragment.approved_tags) or "-"
        proposed = ", ".join(fragment.proposed_tags) or "-"
        destination_state = (
            "exists - preserve reviewable diff"
            if (vault / fragment.destination).exists()
            else "new note"
        )
        lines.append(
            "| "
            f"`{fragment.source_path}` | {fragment.kind} | {fragment.title} | "
            f"`{fragment.destination}` | {destination_state} | {approved} | {proposed} | {fragment.backlink} |"
        )

    lines.extend(["", "## source context"])
    for fragment in fragments:
        lines.append(f"- `{fragment.source_path}` -> `{fragment.destination}`: {fragment.excerpt or '(empty section)'}")

    lines.extend(["", "## proposed note stubs"])
    for fragment in fragments:
        lines.extend([f"### `{fragment.destination}`", "", "```markdown", render_note_stub(fragment).rstrip(), "```"])

    lines.extend(["", "## archive"])
    if not archive:
        lines.append("- not requested; keep selected daily notes in place.")
    else:
        destinations = {fragment.destination.as_posix() for fragment in fragments}
        destinations_visible = bool(destinations) and destinations.issubset(changed)
        for note in notes:
            archive_path = Path("99-archive/daily") / note.name
            if destinations_visible:
                lines.append(
                    f"- ready after review: move `{note.relative_to(vault)}` to `{archive_path}` because extracted destinations are visible in Git."
                )
            else:
                lines.append(
                    f"- blocked: keep `{note.relative_to(vault)}` in place until extracted destination changes are visible in Git diff."
                )

    lines.extend(
        [
            "",
            "## review gate",
            "- apply only approved topical tags listed in the approved tag file.",
            "- handle proposed new tags separately through tag-steward review.",
            "- review Git diff before moving any daily note to archive.",
        ]
    )
    return "\n".join(lines) + "\n"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Produce a daily-triage dry-run proposal for explicit daily notes.")
    parser.add_argument("notes", nargs="+", help="explicit daily note paths, relative to the vault or absolute")
    parser.add_argument("--vault", default=None, help="path to the Obsidian vault. Defaults to config/vault.json")
    parser.add_argument("--tags", default="taxonomy/approved-tags.md", help="approved topical tags file")
    parser.add_argument("--archive", action="store_true", help="include archive readiness checks")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    vault = Path(args.vault).expanduser().resolve() if args.vault else default_vault_path()
    tags_path = Path(args.tags).expanduser()
    if not tags_path.is_absolute():
        tags_path = Path.cwd() / tags_path

    try:
        approved_tags = load_approved_tags(tags_path)
        notes = [resolve_note_path(vault, raw_path) for raw_path in args.notes]
        fragments: list[Fragment] = []
        for note in notes:
            fragments.extend(parse_fragments(vault, note, approved_tags))
    except (OSError, ValueError) as exc:
        parser.error(str(exc))

    sys.stdout.write(render_proposal(vault, notes, fragments, args.archive))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
