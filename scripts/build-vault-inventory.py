#!/usr/bin/env python3
"""Build ignored JSONL state for AI-assisted vault remapping."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from vault_remap_common import (
    default_vault_path,
    ensure_external_indexes_path,
    extract_markdown_links,
    extract_tags,
    extract_wikilinks,
    file_hash,
    list_vault_files,
    load_approved_tags,
    proposed_path_for,
    read_text_lossy,
    split_approved_tags,
    write_jsonl_records,
)


def framework_root() -> Path:
    return Path(__file__).resolve().parents[1]


def build_record(vault_path: Path, file_path: Path, approved_tags: set[str]) -> dict[str, object]:
    relative_path = file_path.relative_to(vault_path)
    text = read_text_lossy(file_path) if file_path.suffix.lower() == ".md" else ""
    tags, unapproved_tags = split_approved_tags(extract_tags(text), approved_tags)
    proposed_path = proposed_path_for(relative_path)
    return {
        "source_path": relative_path.as_posix(),
        "proposed_path": proposed_path.as_posix(),
        "file_kind": "markdown-note" if file_path.suffix.lower() == ".md" else "asset-or-other",
        "sha256": file_hash(file_path),
        "approved_tags": tags,
        "unapproved_tag_candidates": unapproved_tags,
        "wikilinks": extract_wikilinks(text),
        "markdown_links": extract_markdown_links(text),
        "asset_references": [
            reference
            for reference in [*extract_wikilinks(text), *extract_markdown_links(text)]
            if Path(reference).suffix
        ],
        "ai_review_required": True,
        "required_review_scope": ["placement", "tags", "links", "content"],
        "review_state": "unreviewed",
        "review_required": True,
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build vault remap inventory JSONL files.")
    parser.add_argument("paths", nargs="+", help="Vault-relative or absolute files/folders to inspect.")
    parser.add_argument("--vault", default=None, help="Vault path. Defaults to config/vault.local.json.")
    parser.add_argument("--indexes", required=True, help="Ignored index output directory.")
    parser.add_argument(
        "--tags",
        default=str(framework_root() / "taxonomy" / "approved-tags.md"),
        help="Approved tags markdown file.",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        vault_path = Path(args.vault).expanduser().resolve() if args.vault else default_vault_path()
        indexes_path = ensure_external_indexes_path(Path(args.indexes))
        files = list_vault_files(vault_path, args.paths)
    except (FileNotFoundError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    approved_tags = load_approved_tags(Path(args.tags).expanduser().resolve())
    records = [build_record(vault_path, file_path, approved_tags) for file_path in files]
    write_jsonl_records(indexes_path / "vault-inventory.jsonl", records)
    queue_records = [
        {
            "source_path": record["source_path"],
            "proposed_path": record["proposed_path"],
            "required_review_scope": record["required_review_scope"],
            "must_read_file": True,
            "review_state": "unreviewed",
        }
        for record in records
    ]
    write_jsonl_records(indexes_path / "remap-queue.jsonl", queue_records)
    for filename in ("ai-review-decisions.jsonl", "tag-proposals.jsonl"):
        path = indexes_path / filename
        if not path.exists():
            path.write_text("", encoding="utf-8")
    print(f"inventory records: {len(records)}")
    print(f"indexes: {indexes_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
