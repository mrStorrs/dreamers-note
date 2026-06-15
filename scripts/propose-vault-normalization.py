#!/usr/bin/env python3
"""Generate dry-run vault path normalization proposals."""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

from vault_remap_common import (
    default_vault_path,
    list_vault_files as list_selected_vault_files,
    proposed_path_for,
)

WIKILINK_RE = re.compile(r"!?\[\[[^\]]+\]\]")
MARKDOWN_LINK_RE = re.compile(r"!?\[[^\]]*\]\([^)]+\)")


@dataclass
class ProposalEntry:
    current_path: Path
    proposed_path: Path
    file_kind: str
    collision: bool
    collision_reason: str
    link_update_needed: bool
    attachment_risk: bool
    recommended_next_action: str


@dataclass(frozen=True)
class ReferenceIndex:
    markdown_text: dict[Path, str]

    def incoming_reference_risk(self, current_path: Path) -> tuple[bool, bool]:
        link_update_needed = False
        attachment_risk = False
        for markdown_relative, text in self.markdown_text.items():
            if markdown_relative == current_path:
                continue
            if file_references_path(text, current_path):
                link_update_needed = True
            if file_embeds_path(text, current_path):
                attachment_risk = True
        return link_update_needed, attachment_risk


def normalize_relative_path(path: Path) -> Path:
    return proposed_path_for(path)


def classify(path: Path) -> str:
    if path.suffix.lower() == ".md":
        return "markdown-note"
    return "asset-or-other"


def contains_link_risk(path: Path) -> tuple[bool, bool]:
    if path.suffix.lower() != ".md":
        return False, True

    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return False, True

    wikilinks = WIKILINK_RE.findall(text)
    markdown_links = MARKDOWN_LINK_RE.findall(text)
    link_update_needed = bool(wikilinks or markdown_links)
    attachment_risk = any(link.startswith("![[") for link in wikilinks) or any(
        link.startswith("![") for link in markdown_links
    )
    return link_update_needed, attachment_risk


def resolve_selected_paths(vault_path: Path, selected_paths: list[str]) -> list[Path]:
    return list_selected_vault_files(vault_path, selected_paths)


def reference_tokens(path: Path) -> set[str]:
    without_suffix = path.with_suffix("").as_posix()
    return {
        path.as_posix(),
        without_suffix,
        path.name,
        path.stem,
    }


def file_references_path(text: str, path: Path) -> bool:
    return any(token and token in text for token in reference_tokens(path))


def file_embeds_path(text: str, path: Path) -> bool:
    embed_links = [link for link in WIKILINK_RE.findall(text) if link.startswith("!")]
    embed_links.extend(link for link in MARKDOWN_LINK_RE.findall(text) if link.startswith("!"))
    return any(file_references_path(link, path) for link in embed_links)


def build_reference_index(vault_path: Path, markdown_files: list[Path]) -> ReferenceIndex:
    markdown_text: dict[Path, str] = {}
    for markdown_file in markdown_files:
        markdown_relative = markdown_file.relative_to(vault_path)
        try:
            markdown_text[markdown_relative] = markdown_file.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
    return ReferenceIndex(markdown_text=markdown_text)


def build_normalized_index(vault_path: Path, all_files: list[Path]) -> dict[Path, set[Path]]:
    index: dict[Path, set[Path]] = {}
    for file_path in all_files:
        current_path = file_path.relative_to(vault_path)
        normalized_path = normalize_relative_path(current_path)
        index.setdefault(normalized_path, set()).add(current_path)
    return index


def build_entries(
    vault_path: Path, files: list[Path], all_files: list[Path] | None = None
) -> list[ProposalEntry]:
    vault_files = all_files if all_files is not None else list_selected_vault_files(vault_path, ["."])
    if not vault_files:
        vault_files = files
    markdown_files = [path for path in vault_files if path.suffix.lower() == ".md"]
    reference_index = build_reference_index(vault_path, markdown_files)
    normalized_index = build_normalized_index(vault_path, vault_files)
    selected_current = {path.relative_to(vault_path) for path in files}
    proposed_paths = {
        path.relative_to(vault_path): normalize_relative_path(path.relative_to(vault_path))
        for path in files
    }
    target_counts: dict[Path, int] = {}
    for proposed_path in proposed_paths.values():
        target_counts[proposed_path] = target_counts.get(proposed_path, 0) + 1

    entries: list[ProposalEntry] = []
    for file_path in files:
        current_path = file_path.relative_to(vault_path)
        proposed_path = proposed_paths[current_path]
        collision_reasons: list[str] = []

        if target_counts[proposed_path] > 1:
            collision_reasons.append("multiple selected paths normalize to this target")

        normalized_conflicts = normalized_index.get(proposed_path, set()) - {current_path}
        if normalized_conflicts:
            formatted_conflicts = ", ".join(
                f"`{path.as_posix()}`" for path in sorted(normalized_conflicts)
            )
            collision_reasons.append(
                f"other vault paths normalize to this target: {formatted_conflicts}"
            )

        target_absolute = vault_path / proposed_path
        if (
            proposed_path != current_path
            and target_absolute.exists()
            and proposed_path not in selected_current
        ):
            collision_reasons.append("target path already exists in the vault")

        outgoing_link_risk, outgoing_attachment_risk = contains_link_risk(file_path)
        incoming_link_risk, incoming_attachment_risk = reference_index.incoming_reference_risk(current_path)
        link_update_needed = outgoing_link_risk or incoming_link_risk
        attachment_risk = outgoing_attachment_risk or incoming_attachment_risk
        collision = bool(collision_reasons)

        if collision:
            recommended_next_action = "resolve collision before any rename"
        elif current_path == proposed_path:
            recommended_next_action = "no rename needed"
        elif link_update_needed or attachment_risk:
            recommended_next_action = "check references before reviewable rename"
        else:
            recommended_next_action = "review proposed rename on a branch"

        entries.append(
            ProposalEntry(
                current_path=current_path,
                proposed_path=proposed_path,
                file_kind=classify(file_path),
                collision=collision,
                collision_reason="; ".join(collision_reasons) if collision_reasons else "none",
                link_update_needed=link_update_needed,
                attachment_risk=attachment_risk,
                recommended_next_action=recommended_next_action,
            )
        )

    return entries


def render_markdown(vault_path: Path, entries: list[ProposalEntry]) -> str:
    lines = [
        "# vault normalization proposal",
        "",
        "## summary",
        "",
        f"- vault: `{vault_path}`",
        f"- scanned files: {len(entries)}",
        "- mode: dry-run only",
        "- apply support: not available in this workflow",
        "",
        "## proposed path changes",
        "",
        "| current path | proposed path | kind | collision risk | link-update needs | attachment risks | recommended next action |",
        "|---|---|---|---|---|---|---|",
    ]

    for entry in entries:
        collision_text = (
            f"yes: {entry.collision_reason}" if entry.collision else "no"
        )
        if entry.collision and entry.link_update_needed:
            link_text = "yes: blocked by collision; references still need review"
        elif entry.link_update_needed:
            link_text = "yes: link references must be checked or updated before apply"
        else:
            link_text = "no"

        if entry.collision and entry.attachment_risk:
            attachment_text = "yes: blocked by collision; attachments still need review"
        elif entry.attachment_risk:
            attachment_text = "yes: attachment references must be checked or updated before apply"
        else:
            attachment_text = "no"
        lines.append(
            "| "
            f"`{entry.current_path.as_posix()}` | "
            f"`{entry.proposed_path.as_posix()}` | "
            f"{entry.file_kind} | "
            f"{collision_text} | "
            f"{link_text} | "
            f"{attachment_text} | "
            f"{entry.recommended_next_action} |"
        )

    collision_count = sum(1 for entry in entries if entry.collision)
    link_count = sum(1 for entry in entries if entry.link_update_needed)
    attachment_count = sum(1 for entry in entries if entry.attachment_risk)

    lines.extend(
        [
            "",
            "## risks",
            "",
            f"- collision risks: {collision_count}",
            f"- link-update needs: {link_count}",
            f"- attachment risks: {attachment_count}",
            "- `.obsidian` and `.git` internals were excluded.",
            "",
            "## approval needed",
            "",
            "- Review this proposal in chat before creating any branch that changes vault paths.",
            "- Resolve every collision before any rename is attempted.",
            "- Inspect link and attachment references before any approved apply workflow.",
        ]
    )
    return "\n".join(lines) + "\n"


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate a dry-run proposal for lowercase kebab-case vault paths."
    )
    parser.add_argument(
        "paths",
        nargs="+",
        help="Vault-relative or absolute files/folders to inspect.",
    )
    parser.add_argument(
        "--vault",
        default=None,
        help="Vault path. Defaults to config/vault.json.",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    vault_path = Path(args.vault).expanduser().resolve() if args.vault else default_vault_path()

    try:
        files = resolve_selected_paths(vault_path, args.paths)
    except (FileNotFoundError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    entries = build_entries(vault_path, files, list_selected_vault_files(vault_path, ["."]))
    print(render_markdown(vault_path, entries), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
