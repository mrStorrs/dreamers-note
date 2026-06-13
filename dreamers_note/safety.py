from __future__ import annotations

import fnmatch
import unicodedata
from dataclasses import dataclass
from pathlib import Path


EXCLUDED_ROOTS = {".git", ".obsidian", ".codex"}
ENCODED_SEPARATORS = ("%2f", "%5c")


@dataclass(frozen=True)
class PathSafetyResult:
    allowed: bool
    reason: str
    relative_path: Path | None = None
    normalized_path: Path | None = None
    absolute_path: Path | None = None
    message: str = ""


def _reject(reason: str, message: str = "") -> PathSafetyResult:
    return PathSafetyResult(allowed=False, reason=reason, message=message)


def _normalize_path(path: Path) -> Path:
    return Path(*[unicodedata.normalize("NFC", part) for part in path.parts])


def _has_control_character(value: str) -> bool:
    return any(ord(character) < 32 or ord(character) == 127 for character in value)


def _has_boundary_space(path: Path) -> bool:
    return any(part != part.strip() for part in path.parts if part not in {path.anchor, ""})


def _has_symlink(candidate: Path, vault_path: Path) -> bool:
    paths = [candidate, *candidate.parents]
    for path in paths:
        if path == vault_path.parent or path == path.parent:
            break
        if path.is_symlink():
            return True
    return False


def _collision_reason(vault_path: Path, relative_path: Path) -> str | None:
    if not vault_path.exists():
        return None
    requested = relative_path.as_posix()
    requested_nfc = unicodedata.normalize("NFC", requested)
    requested_casefold = requested_nfc.casefold()
    for existing in vault_path.rglob("*"):
        try:
            existing_relative = existing.relative_to(vault_path)
        except ValueError:
            continue
        existing_text = existing_relative.as_posix()
        if existing_text == requested:
            continue
        existing_nfc = unicodedata.normalize("NFC", existing_text)
        if existing_nfc == requested_nfc:
            return "unicode_normalization_collision"
        if existing_nfc.casefold() == requested_casefold:
            return "case_collision"
    return None


def classify_vault_path(
    vault_path: Path | str,
    raw_path: Path | str,
    *,
    private_globs: list[str] | tuple[str, ...] | None = None,
) -> PathSafetyResult:
    raw_text = str(raw_path)
    if _has_control_character(raw_text):
        return _reject("control_character", "path contains a control character")
    if any(separator in raw_text.lower() for separator in ENCODED_SEPARATORS):
        return _reject("encoded_separator", "path contains an encoded path separator")

    path = Path(raw_path).expanduser()
    if ".." in path.parts:
        return _reject("parent_traversal", "path contains parent-directory traversal")
    if _has_boundary_space(path):
        return _reject("boundary_space", "path segment has leading or trailing space")

    resolved_vault = Path(vault_path).expanduser().resolve()
    candidate = path if path.is_absolute() else resolved_vault / path
    if _has_symlink(candidate, resolved_vault):
        return _reject("symlink", "path crosses a symlink")

    resolved_candidate = candidate.resolve(strict=False)
    try:
        relative_path = resolved_candidate.relative_to(resolved_vault)
    except ValueError:
        return _reject("outside_vault", f"path is outside vault: {raw_text}")

    if any(part in EXCLUDED_ROOTS for part in relative_path.parts):
        return _reject("excluded_root", "path is inside an excluded root")
    if relative_path.parts[:2] == ("07-system", "secrets"):
        return _reject("private_path", "path is inside private system secrets")

    relative_text = relative_path.as_posix()
    for pattern in private_globs or ():
        if fnmatch.fnmatch(relative_text, pattern):
            return _reject("private_glob", f"path matches private glob: {pattern}")

    collision = _collision_reason(resolved_vault, relative_path)
    if collision:
        return _reject(collision, "path collides with an existing vault path")

    normalized_path = _normalize_path(relative_path)
    return PathSafetyResult(
        allowed=True,
        reason="allowed",
        relative_path=relative_path,
        normalized_path=normalized_path,
        absolute_path=resolved_vault / normalized_path,
    )
