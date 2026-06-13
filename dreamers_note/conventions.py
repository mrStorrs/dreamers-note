from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path
import re

from .paths import load_approved_tags
from .validation import ValidationError, ValidationResult, validation_error


DISALLOWED_ROOTS = {"02-areas", "03-knowledge"}
CLASSIFIED_NOTE_ROOTS = {"01-projects", "02-knowledge", "04-people"}
KEBAB_CASE_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def validate_note_conventions(
    relative_path: Path | str,
    tags: Iterable[str],
    approved_tags: set[str],
) -> ValidationResult:
    path = Path(relative_path)
    errors: list[ValidationError] = []

    if path.is_absolute():
        errors.append(validation_error("absolute_path", "note path must be vault-relative", path.as_posix()))

    root = path.parts[0] if path.parts else ""
    if root in DISALLOWED_ROOTS:
        errors.append(validation_error("disallowed_root", f"disallowed note root: {root}", path.as_posix()))

    if path.suffix.lower() == ".md" and root in CLASSIFIED_NOTE_ROOTS and len(path.parts) != 4:
        errors.append(
            validation_error(
                "classified_note_depth",
                f"{root} notes must use <root>/<main>/<sub>/<note>.md",
                path.as_posix(),
            )
        )

    segments = [*path.parts[:-1], path.stem if path.suffix else path.name]
    for segment in segments:
        if segment and segment not in CLASSIFIED_NOTE_ROOTS and not KEBAB_CASE_RE.fullmatch(segment):
            errors.append(
                validation_error(
                    "lowercase_kebab_case",
                    f"path segment must be lowercase kebab-case: {segment}",
                    path.as_posix(),
                )
            )

    for tag in sorted(set(str(tag) for tag in tags if str(tag).strip())):
        if tag not in approved_tags:
            errors.append(validation_error("unapproved_tag", f"unapproved tag: {tag}", path.as_posix()))

    return ValidationResult(tuple(errors))
