#!/usr/bin/env python3
from __future__ import annotations

import argparse
import fnmatch
import json
import os
import posixpath
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath


CLASSIFIED_ROOTS = ("01-projects", "02-knowledge", "04-people")
EXCLUDED_DIRECTORY_NAMES = {".git", ".obsidian", ".codex"}
EXCLUDED_TOP_LEVEL_ROOTS = {"00-inbox", "03-sources", "05-assets", "06-templates", "07-system", "99-archive"}
INDEX_FILENAME_PATTERN = "_<folder-name>.md"
NOTES_HEADING = "## Notes"
WIKILINK_RE = re.compile(r"(!?)\[\[([^\]]+)\]\]")
MARKDOWN_LINK_RE = re.compile(r"(?<!\!)\[([^\]]+)\]\(([^\s)]+)\)")
NOTES_HEADING_RE = re.compile(r"^## Notes[ \t]*\r?$", re.MULTILINE)
SECTION_HEADING_RE = re.compile(r"^## (?!#)[^\r\n]+", re.MULTILINE)
FRONTMATTER_RE = re.compile(r"\A---\r?\n.*?\r?\n---\r?\n", re.DOTALL)
SUMMARY_METADATA_PREFIX_RE = re.compile(
    r"^(?:related|see also|parent|source|captured|created|updated|status|tags?)\s*:", re.IGNORECASE
)


class MigrationError(Exception):
    pass


@dataclass(frozen=True)
class IndexPlan:
    folder: PurePosixPath
    target: PurePosixPath
    mode: str
    notes_content: str
    owner_source: PurePosixPath | None


@dataclass(frozen=True)
class LinkMap:
    exact: dict[str, str]
    basenames: dict[str, str]


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    vault = resolve_vault(args.vault)
    try:
        require_clean_git_worktree(vault)
        private_globs = load_private_globs()
        plans, skipped_paths, private_paths_skipped = build_index_plans(vault, private_globs)
        link_map = build_link_map(plans)
        generated, rewrite_count = render_migration(vault, plans, link_map, private_globs)
        summary = build_summary(
            plans,
            generated,
            rewrite_count,
            skipped_paths,
            private_paths_skipped,
            "write" if args.write else "dry-run",
        )
        if args.write:
            apply_migration(vault, plans, generated, private_globs)
        print_summary(summary)
        return 0
    except MigrationError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create or refresh classified directory homepage indexes.")
    parser.add_argument("--vault", default=None, help="Vault path. Defaults to config/vault.json.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Report planned changes without writing them.")
    mode.add_argument("--write", action="store_true", help="Write planned directory index changes.")
    return parser.parse_args(argv)


def resolve_vault(value: str | None) -> Path:
    if value:
        vault = Path(value).expanduser().resolve()
    else:
        config_path = Path(__file__).resolve().parents[1] / "config" / "vault.json"
        try:
            vault_value = json.loads(config_path.read_text(encoding="utf-8"))["vault_path"]
        except (FileNotFoundError, KeyError, json.JSONDecodeError, TypeError) as error:
            raise MigrationError(f"could not read configured vault path: {error}") from error
        vault = Path(str(vault_value)).expanduser().resolve()
    if not vault.is_dir():
        raise MigrationError(f"vault directory does not exist: {vault}")
    return vault


def load_private_globs() -> tuple[str, ...]:
    config_path = Path(__file__).resolve().parents[1] / "config" / "runtime.json"
    try:
        parsed = json.loads(config_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError) as error:
        raise MigrationError(f"could not read runtime privacy policy: {error}") from error
    private_globs = parsed.get("private_globs") if isinstance(parsed, dict) else None
    if not isinstance(private_globs, list) or any(not isinstance(item, str) or not item for item in private_globs):
        raise MigrationError("runtime privacy policy must contain private_globs as a string list")
    return tuple(private_globs)


def require_clean_git_worktree(vault: Path) -> None:
    inside = run_git(vault, "rev-parse", "--is-inside-work-tree")
    if inside.returncode != 0 or inside.stdout.strip() != "true":
        raise MigrationError("vault is not a git repository")
    status = run_git(vault, "status", "--short")
    if status.returncode != 0:
        raise MigrationError("could not inspect vault Git status")
    if status.stdout.strip():
        raise MigrationError("vault worktree is dirty; commit or stash changes before migration")


def run_git(vault: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(vault), *args],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def build_index_plans(
    vault: Path, private_globs: tuple[str, ...]
) -> tuple[list[IndexPlan], list[str], int]:
    folders, skipped_paths, private_paths_skipped = eligible_directories(vault, private_globs)
    plans: list[IndexPlan] = []
    for folder in folders:
        target = folder / index_file_name(folder.name)
        target_path = vault / target
        owner_source = folder / f"{folder.name}.md"
        owner_path = vault / owner_source
        ensure_safe_path(vault, target_path, private_globs)
        ensure_safe_path(vault, owner_path, private_globs)
        if target_path.exists():
            if not target_path.is_file() or target_path.is_symlink():
                raise MigrationError(f"index conflict at {target.as_posix()}")
            if owner_path.exists():
                raise MigrationError(
                    f"index conflict: both {target.as_posix()} and owner note {owner_source.as_posix()} exist"
                )
            notes_content = extract_notes_content(read_text(target_path))
            if notes_content is None:
                raise MigrationError(f"index conflict: {target.as_posix()} has no {NOTES_HEADING} section")
            plans.append(IndexPlan(folder, target, "refreshed", notes_content, None))
            continue
        if owner_path.exists():
            if not owner_path.is_file() or owner_path.is_symlink():
                raise MigrationError(f"unsafe owner note path: {owner_source.as_posix()}")
            plans.append(IndexPlan(folder, target, "renamed", f"\n\n{read_text(owner_path)}", owner_source))
            continue
        plans.append(IndexPlan(folder, target, "created", "", None))
    return plans, skipped_paths, private_paths_skipped


def eligible_directories(
    vault: Path, private_globs: tuple[str, ...]
) -> tuple[list[PurePosixPath], list[str], int]:
    folders: list[PurePosixPath] = []
    skipped_paths: set[str] = set()
    private_paths_skipped = 0
    for root_name in CLASSIFIED_ROOTS:
        root = vault / root_name
        if not root.exists():
            continue
        if not root.is_dir() or root.is_symlink():
            raise MigrationError(f"unsafe classified root: {root_name}")
        for current, directory_names, file_names in os.walk(root, topdown=True, followlinks=False):
            current_path = Path(current)
            relative = PurePosixPath(current_path.relative_to(vault).as_posix())
            validate_walk_entries(vault, current_path, directory_names, file_names, private_globs)
            for name in [*directory_names, *file_names]:
                candidate = relative / name
                if is_private_path(candidate, private_globs):
                    private_paths_skipped += 1
                elif is_excluded_path(candidate):
                    skipped_paths.add(candidate.as_posix())
            directory_names[:] = sorted(
                name
                for name in directory_names
                if not is_excluded_path(relative / name, private_globs)
            )
            if len(relative.parts) >= 2:
                folders.append(relative)
    return sorted(folders, key=lambda item: item.as_posix()), sorted(skipped_paths), private_paths_skipped


def validate_walk_entries(
    vault: Path,
    current: Path,
    directories: list[str],
    files: list[str],
    private_globs: tuple[str, ...],
) -> None:
    for name in [*directories, *files]:
        candidate = current / name
        if candidate.is_symlink() and not is_excluded_path(
            PurePosixPath(candidate.relative_to(vault).as_posix()), private_globs
        ):
            raise MigrationError(f"unsafe symlink in classified vault path: {candidate.relative_to(vault).as_posix()}")


def is_excluded_path(relative: PurePosixPath, private_globs: tuple[str, ...] = ()) -> bool:
    if not relative.parts:
        return True
    if relative.parts[0] in EXCLUDED_TOP_LEVEL_ROOTS:
        return True
    if any(part in EXCLUDED_DIRECTORY_NAMES for part in relative.parts):
        return True
    return is_private_path(relative, private_globs)


def is_private_path(relative: PurePosixPath, private_globs: tuple[str, ...]) -> bool:
    normalized = relative.as_posix()
    return any(fnmatch.fnmatchcase(normalized, pattern) for pattern in private_globs)


def ensure_safe_path(vault: Path, candidate: Path, private_globs: tuple[str, ...]) -> None:
    try:
        candidate.relative_to(vault)
    except ValueError as error:
        raise MigrationError(f"path outside vault: {candidate}") from error
    relative = PurePosixPath(candidate.relative_to(vault).as_posix())
    if is_excluded_path(relative, private_globs):
        raise MigrationError(f"unsafe excluded path: {relative.as_posix()}")


def index_file_name(folder_name: str) -> str:
    return INDEX_FILENAME_PATTERN.replace("<folder-name>", folder_name)


def extract_notes_content(text: str) -> str | None:
    heading = NOTES_HEADING_RE.search(text)
    if heading is None:
        return None
    next_heading = SECTION_HEADING_RE.search(text, heading.end())
    return text[heading.end() : next_heading.start() if next_heading else len(text)]


def build_link_map(plans: list[IndexPlan]) -> LinkMap:
    exact: dict[str, str] = {}
    basename_targets: dict[str, set[str]] = {}
    for plan in plans:
        if plan.owner_source is None:
            continue
        source = without_suffix(plan.owner_source)
        target = without_suffix(plan.target)
        exact[source] = target
        basename_targets.setdefault(PurePosixPath(source).name, set()).add(target)
    basenames = {
        basename: next(iter(targets))
        for basename, targets in basename_targets.items()
        if len(targets) == 1
    }
    return LinkMap(exact=exact, basenames=basenames)


def without_suffix(value: PurePosixPath) -> str:
    return value.with_suffix("").as_posix()


def render_migration(
    vault: Path,
    plans: list[IndexPlan],
    link_map: LinkMap,
    private_globs: tuple[str, ...],
) -> tuple[dict[str, str], int]:
    folders = {plan.folder for plan in plans}
    rendered = {
        plan.target.as_posix(): render_index(vault, plan, folders, private_globs)
        for plan in plans
    }
    owner_sources = {plan.owner_source.as_posix() for plan in plans if plan.owner_source}
    existing_indexes = {plan.target.as_posix() for plan in plans if plan.mode == "refreshed"}
    output: dict[str, str] = {}
    rewrites = 0
    for relative, text in markdown_documents(vault, private_globs):
        if relative in owner_sources:
            continue
        output[relative] = text
    output.update(rendered)
    for relative, text in list(output.items()):
        if relative in existing_indexes:
            rewritten, count = rewrite_outside_notes(text, PurePosixPath(relative), link_map)
        else:
            rewritten, count = rewrite_links(text, PurePosixPath(relative), link_map)
        output[relative] = rewritten
        rewrites += count
    return output, rewrites


def markdown_documents(vault: Path, private_globs: tuple[str, ...]) -> list[tuple[str, str]]:
    documents: list[tuple[str, str]] = []
    for root_name in CLASSIFIED_ROOTS:
        root = vault / root_name
        if not root.is_dir():
            continue
        for current, directory_names, file_names in os.walk(root, topdown=True, followlinks=False):
            current_path = Path(current)
            relative = PurePosixPath(current_path.relative_to(vault).as_posix())
            directory_names[:] = sorted(
                name
                for name in directory_names
                if not is_excluded_path(relative / name, private_globs)
            )
            for name in sorted(file_names):
                candidate = current_path / name
                candidate_relative = PurePosixPath(candidate.relative_to(vault).as_posix())
                if candidate.suffix.lower() != ".md" or is_excluded_path(candidate_relative, private_globs):
                    continue
                if candidate.is_symlink():
                    raise MigrationError(f"unsafe symlink in classified vault path: {candidate_relative.as_posix()}")
                documents.append((candidate_relative.as_posix(), read_text(candidate)))
    return documents


def render_index(
    vault: Path,
    plan: IndexPlan,
    folders: set[PurePosixPath],
    private_globs: tuple[str, ...],
) -> str:
    subfolders = direct_subfolders(plan.folder, folders)
    pages = direct_pages(vault, plan, private_globs)
    lead = directory_summary(plan, subfolders, pages)
    text = f"{lead}\n\n{NOTES_HEADING}"
    if plan.notes_content:
        text += plan.notes_content
    else:
        text += "\n"
    sections: list[str] = []
    if subfolders:
        sections.append(render_subfolders(subfolders))
    if pages:
        sections.append(render_pages(pages))
    for section in sections:
        if not text.endswith(("\n", "\r")):
            text += "\n"
        text += f"\n{section}\n"
    return text if text.endswith(("\n", "\r")) else f"{text}\n"


def direct_subfolders(folder: PurePosixPath, folders: set[PurePosixPath]) -> list[PurePosixPath]:
    return sorted(
        [candidate for candidate in folders if candidate.parent == folder],
        key=lambda item: item.as_posix(),
    )


def render_subfolders(folders: list[PurePosixPath]) -> str:
    lines = ["## Subfolders", ""]
    for folder in folders:
        target = folder / index_file_name(folder.name)
        label = display_name(folder.name)
        lines.append(
            f"- [[{without_suffix(target)}|{label}]] - Contains pages and nested folders related to {label}."
        )
    return "\n".join(lines)


def direct_pages(
    vault: Path,
    plan: IndexPlan,
    private_globs: tuple[str, ...],
) -> list[tuple[PurePosixPath, str, str]]:
    folder_path = vault / plan.folder
    pages: list[tuple[PurePosixPath, str, str]] = []
    for candidate in sorted(folder_path.iterdir(), key=lambda item: item.name.lower()):
        relative = PurePosixPath(candidate.relative_to(vault).as_posix())
        if (
            not candidate.is_file()
            or candidate.is_symlink()
            or candidate.suffix.lower() != ".md"
            or is_excluded_path(relative, private_globs)
            or relative == plan.target
            or relative == plan.owner_source
        ):
            continue
        content = read_text(candidate)
        pages.append((relative, note_title(content, candidate.stem), note_summary(content, candidate.stem)))
    return pages


def render_pages(pages: list[tuple[PurePosixPath, str, str]]) -> str:
    lines = ["## Pages", ""]
    for path, title, summary in pages:
        lines.append(f"- [[{without_suffix(path)}|{title}]] - {summary}")
    return "\n".join(lines)


def directory_summary(
    plan: IndexPlan,
    subfolders: list[PurePosixPath],
    pages: list[tuple[PurePosixPath, str, str]],
) -> str:
    folder_name = display_name(plan.folder.name)
    notes_summary = first_substantive_summary(plan.notes_content)
    if notes_summary:
        return subject_summary(notes_summary, folder_name)

    topics = unique_topics(
        [display_name(folder.name) for folder in subfolders]
        + [title for _, title, _ in pages]
    )
    if topics:
        return f"{folder_name} collects notes on {natural_list(topics)}."
    return f"{folder_name} collects notes and references as they are added."


def subject_summary(summary: str, folder_name: str) -> str:
    role_prefixes = (
        f"{folder_name} hub for ",
        f"{folder_name} is a hub for ",
        f"{folder_name} index for ",
        f"{folder_name} homepage for ",
        f"{folder_name} home page for ",
        f"{folder_name} directory homepage for ",
        f"{folder_name} is a directory homepage for ",
    )
    for prefix in role_prefixes:
        if summary.casefold().startswith(prefix.casefold()):
            subject = summary[len(prefix) :].strip()
            if not subject:
                continue
            if subject[-1] not in ".!?":
                subject += "."
            return f"{folder_name} covers {subject}"

    qualified_role = re.match(
        rf"^{re.escape(folder_name)}\s+(?P<focus>.+?)\s+(?:hub|index|homepage|home page)\s+for\s+(?P<subject>.+)$",
        summary,
        re.IGNORECASE,
    )
    if qualified_role:
        focus = qualified_role.group("focus").strip().rstrip(".!?")
        subject = qualified_role.group("subject").strip().rstrip(".!?")
        if focus and subject:
            return f"{folder_name} covers {subject}, with a focus on {focus}."
    return summary


def unique_topics(topics: list[str]) -> list[str]:
    unique: list[str] = []
    seen: set[str] = set()
    for topic in topics:
        key = topic.casefold()
        if key in seen:
            continue
        seen.add(key)
        unique.append(topic)
    return unique


def natural_list(items: list[str]) -> str:
    displayed = items[:4]
    if len(items) > 4:
        displayed = items[:3] + ["related topics"]
    if len(displayed) == 1:
        return displayed[0]
    if len(displayed) == 2:
        return f"{displayed[0]} and {displayed[1]}"
    return f"{', '.join(displayed[:-1])}, and {displayed[-1]}"


def note_title(content: str, fallback: str) -> str:
    body = FRONTMATTER_RE.sub("", content, count=1)
    for line in body.splitlines():
        match = re.match(r"^# (.+?)\s*$", line)
        if match:
            return clean_inline_text(match.group(1)) or display_name(fallback)
    return display_name(fallback)


def note_summary(content: str, fallback: str) -> str:
    return first_substantive_summary(content) or f"Notes about {display_name(fallback)}."


def first_substantive_summary(content: str) -> str | None:
    body = FRONTMATTER_RE.sub("", content, count=1)
    for paragraph in content_paragraphs(body):
        if is_summary_metadata(paragraph):
            continue
        summary = clean_inline_text(paragraph)
        if summary:
            return shorten(summary, 180)
    return None


def content_paragraphs(body: str) -> list[str]:
    paragraphs: list[str] = []
    paragraph: list[str] = []
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped:
            if paragraph:
                paragraphs.append(" ".join(paragraph))
                paragraph = []
            continue
        if stripped.startswith("#") or stripped.startswith("<!--"):
            if paragraph:
                paragraphs.append(" ".join(paragraph))
                paragraph = []
            continue
        paragraph.append(stripped)
    if paragraph:
        paragraphs.append(" ".join(paragraph))
    return paragraphs


def is_summary_metadata(paragraph: str) -> bool:
    if SUMMARY_METADATA_PREFIX_RE.match(paragraph):
        return True
    without_links = WIKILINK_RE.sub("", paragraph)
    without_links = MARKDOWN_LINK_RE.sub("", without_links)
    return bool(paragraph) and not without_links.strip(" \t\r\n,;|/-*")


def clean_inline_text(value: str) -> str:
    value = re.sub(r"!?\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]", lambda match: match.group(2) or match.group(1), value)
    value = re.sub(r"\[([^\]]+)\]\([^\)]+\)", r"\1", value)
    value = re.sub(r"[`*_]", "", value)
    return re.sub(r"\s+", " ", value).strip()


def shorten(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    cut = value.rfind(" ", 0, limit - 3)
    return f"{value[:cut if cut > 0 else limit - 3].rstrip()}..."


def display_name(value: str) -> str:
    return " ".join(part.capitalize() for part in re.split(r"[-_]+", value) if part)


def rewrite_outside_notes(text: str, current: PurePosixPath, link_map: LinkMap) -> tuple[str, int]:
    heading = NOTES_HEADING_RE.search(text)
    if heading is None:
        return rewrite_links(text, current, link_map)
    next_heading = SECTION_HEADING_RE.search(text, heading.end())
    notes_end = next_heading.start() if next_heading else len(text)
    before, before_count = rewrite_links(text[: heading.end()], current, link_map)
    after, after_count = rewrite_links(text[notes_end:], current, link_map)
    return before + text[heading.end() : notes_end] + after, before_count + after_count


def rewrite_links(text: str, current: PurePosixPath, link_map: LinkMap) -> tuple[str, int]:
    rewritten_count = 0

    def replace_wikilink(match: re.Match[str]) -> str:
        nonlocal rewritten_count
        embed, inner = match.groups()
        target, separator, alias = inner.partition("|")
        target_base, anchor = split_anchor(target)
        replacement = resolve_link_target(target_base, current, link_map)
        if replacement is None:
            return match.group(0)
        rewritten_count += 1
        display = alias if separator else ("" if embed else PurePosixPath(target_base).stem)
        alias_suffix = f"|{display}" if display else ""
        return f"{embed}[[{replacement}{anchor}{alias_suffix}]]"

    def replace_markdown_link(match: re.Match[str]) -> str:
        nonlocal rewritten_count
        label, target = match.groups()
        target_base, anchor = split_anchor(target)
        replacement = resolve_link_target(target_base, current, link_map)
        if replacement is None:
            return match.group(0)
        rewritten_count += 1
        return f"[{label}]({replacement}.md{anchor})"

    text = WIKILINK_RE.sub(replace_wikilink, text)
    text = MARKDOWN_LINK_RE.sub(replace_markdown_link, text)
    return text, rewritten_count


def split_anchor(target: str) -> tuple[str, str]:
    if "#" not in target:
        return target, ""
    base, anchor = target.split("#", 1)
    return base, f"#{anchor}"


def resolve_link_target(target: str, current: PurePosixPath, link_map: LinkMap) -> str | None:
    if not target or "://" in target or target.startswith("#"):
        return None
    direct = normalize_link_path(target)
    if direct in link_map.exact:
        return link_map.exact[direct]
    if "/" not in direct:
        return link_map.basenames.get(direct)
    if target.startswith("/"):
        return None
    relative = normalize_link_path(posixpath.join(current.parent.as_posix(), target))
    return link_map.exact.get(relative)


def normalize_link_path(value: str) -> str:
    normalized = posixpath.normpath(value.strip()).lstrip("./")
    if normalized.endswith(".md"):
        normalized = normalized[:-3]
    return normalized


def apply_migration(
    vault: Path,
    plans: list[IndexPlan],
    output: dict[str, str],
    private_globs: tuple[str, ...],
) -> None:
    owner_sources = {plan.owner_source.as_posix() for plan in plans if plan.owner_source}
    for relative in sorted(output):
        target = vault / relative
        ensure_safe_path(vault, target, private_globs)
        original = read_text(target) if target.exists() else None
        if original == output[relative]:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        write_text(target, output[relative])
    for owner_source in sorted(owner_sources):
        source = vault / owner_source
        ensure_safe_path(vault, source, private_globs)
        if source.exists():
            source.unlink()


def build_summary(
    plans: list[IndexPlan],
    output: dict[str, str],
    rewrite_count: int,
    skipped_paths: list[str],
    private_paths_skipped: int,
    mode: str,
) -> dict[str, object]:
    return {
        "mode": mode,
        "eligible_directories": len(plans),
        "created_indexes": sum(plan.mode == "created" for plan in plans),
        "refreshed_indexes": sum(plan.mode == "refreshed" for plan in plans),
        "renamed_owner_notes": sum(plan.mode == "renamed" for plan in plans),
        "link_rewrites": rewrite_count,
        "changed_markdown_files": len(output),
        "skipped_paths": skipped_paths,
        "private_paths_skipped": private_paths_skipped,
        "warnings": [],
        "index_paths": [plan.target.as_posix() for plan in plans],
    }


def print_summary(summary: dict[str, object]) -> None:
    print(f"mode: {summary['mode']}")
    print(f"eligible directories: {summary['eligible_directories']}")
    print(f"created indexes: {summary['created_indexes']}")
    print(f"refreshed indexes: {summary['refreshed_indexes']}")
    print(f"renamed owner notes: {summary['renamed_owner_notes']}")
    print(f"link rewrites: {summary['link_rewrites']}")
    print(f"changed markdown files: {summary['changed_markdown_files']}")
    print(f"skipped paths: {len(summary['skipped_paths'])}")
    print(f"private paths skipped: {summary['private_paths_skipped']}")
    print(f"warnings: {len(summary['warnings'])}")
    for path in summary["skipped_paths"]:
        print(f"- skipped: {path}")
    for warning in summary["warnings"]:
        print(f"- warning: {warning}")
    print("index paths:")
    for path in summary["index_paths"]:
        print(f"- {path}")


def read_text(path: Path) -> str:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return handle.read()


def write_text(path: Path, content: str) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        handle.write(content)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
