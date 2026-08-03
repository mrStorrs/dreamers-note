from __future__ import annotations

import hashlib
import json
import fnmatch
from functools import lru_cache
import re
from pathlib import Path
from typing import Iterable


EXCLUDED_DIRS = {".git", ".obsidian", ".codex"}
TARGET_FOLDERS = {
    "00-inbox",
    "01-projects",
    "02-knowledge",
    "03-sources",
    "04-people",
    "05-assets",
    "06-templates",
    "07-system",
    "99-archive",
}
TOP_LEVEL_MAP = {
    "00-inbox": "00-inbox",
    "01-projects": "01-projects",
    "02-areas": "02-knowledge",
    "02-knowledge": "02-knowledge",
    "03-knowledge": "02-knowledge",
    "03-sources": "03-sources",
    "04-sources": "03-sources",
    "04-people": "04-people",
    "05-people": "04-people",
    "05-assets": "05-assets",
    "06-assets": "05-assets",
    "06-templates": "06-templates",
    "07-templates": "06-templates",
    "07-system": "07-system",
    "08-system": "07-system",
    "99-archive": "99-archive",
    "archive": "99-archive",
    "areas": "02-knowledge",
    "broad-topics": "02-knowledge",
    "family": "04-people",
    "inbox": "00-inbox",
    "knowledge": "02-knowledge",
    "people": "04-people",
    "projects": "01-projects",
    "resources": "02-knowledge",
    "sources": "03-sources",
    "assets": "05-assets",
    "templates": "06-templates",
    "system": "07-system",
}
AREA_ALIASES = {"02-areas", "02-knowledge", "03-knowledge", "areas", "broad-topics", "knowledge", "resources"}
CLASSIFIED_NOTE_FOLDERS = {"01-projects", "02-knowledge", "04-people"}
LEGACY_AREA_ALIASES = {"03-knowledge", "broad-topics", "knowledge", "resources"}
PEOPLE_ALIASES = {"family"}
NON_KEBAB_RE = re.compile(r"[^a-z0-9]+")
WIKILINK_RE = re.compile(r"!?\[\[([^\]]+)\]\]")
MARKDOWN_LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
HASHTAG_RE = re.compile(r"(?<!\w)#([A-Za-z0-9][A-Za-z0-9_-]*)")


def framework_root() -> Path:
    return Path(__file__).resolve().parents[1]


def default_vault_path() -> Path:
    config_path = framework_root() / "config" / "vault.local.json"
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"could not read local vault configuration: {config_path}") from exc
    configured_path = config.get("vault_path") if isinstance(config, dict) else None
    if not isinstance(configured_path, str) or not configured_path.strip():
        raise ValueError("local vault configuration requires a non-empty vault_path")
    expanded_path = Path(configured_path).expanduser()
    if not expanded_path.is_absolute():
        raise ValueError("local vault configuration vault_path must be absolute")
    return expanded_path.resolve()


def ensure_external_indexes_path(indexes_path: Path) -> Path:
    resolved = indexes_path.expanduser().resolve()
    try:
        resolved.relative_to(framework_root())
    except ValueError:
        return resolved
    raise ValueError("indexes output must be outside the framework repository")


@lru_cache(maxsize=1)
def private_globs() -> tuple[str, ...]:
    config_path = framework_root() / "config" / "runtime.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    globs = config.get("private_globs", [])
    if not isinstance(globs, list) or any(not isinstance(item, str) for item in globs):
        raise ValueError("runtime private_globs must be a string array")
    return tuple(globs)


def normalize_segment(segment: str) -> str:
    normalized = NON_KEBAB_RE.sub("-", segment.lower()).strip("-")
    return normalized or "untitled"


def normalize_file_name(name: str) -> str:
    path = Path(name)
    suffix = path.suffix.lower()
    stem = path.name[: -len(path.suffix)] if path.suffix else path.name
    return f"{normalize_segment(stem)}{suffix}"


def is_excluded(path: Path) -> bool:
    normalized = path.as_posix().lstrip("./")
    return any(part in EXCLUDED_DIRS for part in path.parts) or any(
        private_glob_matches(normalized, pattern) for pattern in private_globs()
    )


def private_glob_matches(normalized_path: str, pattern: str) -> bool:
    normalized_pattern = pattern.lstrip("./")
    if normalized_pattern.endswith("/**"):
        prefix = normalized_pattern[:-3].rstrip("/")
        return normalized_path == prefix or normalized_path.startswith(f"{prefix}/")
    return fnmatch.fnmatchcase(normalized_path, normalized_pattern)


def load_approved_tags(tags_path: Path) -> set[str]:
    tags: set[str] = set()
    for line in tags_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("- "):
            tag = stripped[2:].strip()
            if tag and not tag.startswith("**"):
                tags.add(tag)
    return tags


def read_jsonl_records(
    path: Path,
    *,
    required_fields: Iterable[str] = (),
    record_name: str = "record",
) -> list[dict[str, object]]:
    if not path.exists():
        raise FileNotFoundError(f"missing {record_name} file: {path}")
    records: list[dict[str, object]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid {record_name} JSON on line {line_number}: {exc.msg}") from exc
        if not isinstance(record, dict):
            raise ValueError(f"invalid {record_name} on line {line_number}: expected object")
        missing = [field for field in required_fields if field not in record]
        if missing:
            raise ValueError(
                f"invalid {record_name} on line {line_number}: missing {', '.join(missing)}"
            )
        records.append(record)
    return records


def write_jsonl_records(path: Path, records: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(record, sort_keys=True) + "\n" for record in records),
        encoding="utf-8",
    )


def list_vault_files(vault_path: Path, selected_paths: list[str]) -> list[Path]:
    files: list[Path] = []
    for selected in selected_paths:
        raw_path = Path(selected).expanduser()
        selected_path = raw_path if raw_path.is_absolute() else vault_path / raw_path
        if selected_path.is_symlink():
            continue
        absolute_path = selected_path.resolve()
        absolute_path.relative_to(vault_path)
        if not absolute_path.exists():
            raise FileNotFoundError(f"selected path does not exist: {selected}")
        relative = absolute_path.relative_to(vault_path)
        if is_excluded(relative):
            continue
        if absolute_path.is_file():
            files.append(absolute_path)
            continue
        for candidate in sorted(absolute_path.rglob("*")):
            if candidate.is_symlink() or not candidate.is_file():
                continue
            candidate_relative = candidate.resolve().relative_to(vault_path)
            if not is_excluded(candidate_relative):
                files.append(candidate)
    return sorted(set(files), key=lambda path: path.relative_to(vault_path).as_posix())


def proposed_path_for(relative_path: Path) -> Path:
    normalized_parts = [normalize_segment(part) for part in relative_path.parts[:-1]]
    normalized_name = normalize_file_name(relative_path.name)
    if not normalized_parts:
        if relative_path.suffix.lower() == ".md":
            return Path("02-knowledge", "uncategorized", "general", normalized_name)
        return Path("05-assets") / normalized_name
    first = TOP_LEVEL_MAP.get(normalized_parts[0], normalized_parts[0])
    if relative_path.suffix.lower() != ".md" and normalized_parts[0] in LEGACY_AREA_ALIASES:
        return Path("05-assets", *normalized_parts, normalized_name)
    if relative_path.suffix.lower() == ".md" and normalized_parts[0] in AREA_ALIASES:
        return classified_note_path_for("02-knowledge", normalized_parts[1:], normalized_name)
    if relative_path.suffix.lower() == ".md" and normalized_parts[0] in PEOPLE_ALIASES:
        return classified_note_path_for("04-people", normalized_parts, normalized_name)
    if relative_path.suffix.lower() == ".md" and first not in TARGET_FOLDERS:
        return classified_note_path_for("02-knowledge", normalized_parts, normalized_name)
    if first not in TARGET_FOLDERS:
        return Path("05-assets", *normalized_parts, normalized_name)
    if relative_path.suffix.lower() == ".md" and first in CLASSIFIED_NOTE_FOLDERS:
        return classified_note_path_for(first, normalized_parts[1:], normalized_name)
    return Path(first, *normalized_parts[1:], normalized_name)


def classified_note_path_for(root: str, topic_parts: list[str], normalized_name: str) -> Path:
    if not topic_parts:
        main = "uncategorized"
        sub = "general"
        filename = normalized_name
    elif len(topic_parts) == 1:
        main = topic_parts[0]
        sub = "general"
        filename = normalized_name
    else:
        main = topic_parts[0]
        sub = topic_parts[1]
        filename = normalized_name
        if len(topic_parts) > 2:
            filename_stem = Path(normalized_name).stem
            filename_suffix = Path(normalized_name).suffix
            filename = f"{'-'.join(topic_parts[2:])}-{filename_stem}{filename_suffix}"
    return Path(root, main, sub, filename)


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_text_lossy(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return ""


def extract_tags(text: str) -> list[str]:
    tags: list[str] = []
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end != -1:
            frontmatter = text[4:end].splitlines()
            in_tags = False
            for line in frontmatter:
                stripped = line.strip()
                if stripped == "tags:":
                    in_tags = True
                    continue
                if in_tags and stripped.startswith("- "):
                    tags.append(stripped[2:].strip())
                    continue
                if in_tags and stripped and not stripped.startswith("#"):
                    in_tags = False
                if stripped.startswith("tags:") and stripped != "tags:":
                    raw_tags = stripped.split(":", 1)[1].strip().strip("[]")
                    tags.extend(tag.strip().strip("'\"") for tag in raw_tags.split(",") if tag.strip())
    tags.extend(match.group(1) for match in HASHTAG_RE.finditer(text))
    return sorted(set(tag for tag in tags if tag))


def split_approved_tags(tags: list[str], approved: set[str]) -> tuple[list[str], list[str]]:
    approved_tags = sorted(tag for tag in tags if tag in approved)
    unapproved_tags = sorted(tag for tag in tags if tag not in approved)
    return approved_tags, unapproved_tags


def extract_wikilinks(text: str) -> list[str]:
    return sorted({match.group(1).split("|", 1)[0].split("#", 1)[0] for match in WIKILINK_RE.finditer(text)})


def extract_markdown_links(text: str) -> list[str]:
    return sorted({match.group(1).split("#", 1)[0] for match in MARKDOWN_LINK_RE.finditer(text)})


def ensure_inside_vault(vault_path: Path, path: Path) -> Path:
    resolved = path.resolve()
    resolved.relative_to(vault_path)
    return resolved
