from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from dreamers_note.paths import (
    AREA_ALIASES,
    CLASSIFIED_NOTE_FOLDERS,
    EXCLUDED_DIRS,
    HASHTAG_RE,
    LEGACY_AREA_ALIASES,
    MARKDOWN_LINK_RE,
    NON_KEBAB_RE,
    PEOPLE_ALIASES,
    TARGET_FOLDERS,
    TOP_LEVEL_MAP,
    WIKILINK_RE,
    classified_note_path_for,
    default_vault_path,
    ensure_inside_vault,
    extract_markdown_links,
    extract_tags,
    extract_wikilinks,
    file_hash,
    framework_root,
    is_excluded,
    list_vault_files,
    load_approved_tags,
    normalize_file_name,
    normalize_segment,
    proposed_path_for,
    read_text_lossy,
    split_approved_tags,
)


__all__ = [
    "AREA_ALIASES",
    "CLASSIFIED_NOTE_FOLDERS",
    "EXCLUDED_DIRS",
    "HASHTAG_RE",
    "LEGACY_AREA_ALIASES",
    "MARKDOWN_LINK_RE",
    "NON_KEBAB_RE",
    "PEOPLE_ALIASES",
    "TARGET_FOLDERS",
    "TOP_LEVEL_MAP",
    "WIKILINK_RE",
    "classified_note_path_for",
    "default_vault_path",
    "ensure_inside_vault",
    "extract_markdown_links",
    "extract_tags",
    "extract_wikilinks",
    "file_hash",
    "framework_root",
    "is_excluded",
    "list_vault_files",
    "load_approved_tags",
    "normalize_file_name",
    "normalize_segment",
    "proposed_path_for",
    "read_text_lossy",
    "split_approved_tags",
]
