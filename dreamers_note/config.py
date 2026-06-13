from __future__ import annotations

import json
import os
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .validation import ValidationError, ValidationResult, validation_error


def framework_root() -> Path:
    return Path(__file__).resolve().parents[1]


def default_config_path() -> Path:
    return framework_root() / "config" / "vault.json"


def default_runtime_dir() -> Path:
    return framework_root() / ".dreamers" / "runtime"


@dataclass(frozen=True)
class VaultConfig:
    config_path: Path
    vault_path: Path
    runtime_dir: Path
    raw: dict[str, Any]


def load_vault_config(
    config_path: Path | str | None = None,
    *,
    vault_path: Path | str | None = None,
    runtime_dir: Path | str | None = None,
) -> VaultConfig:
    resolved_config_path = Path(config_path).expanduser().resolve() if config_path else default_config_path()
    raw = json.loads(resolved_config_path.read_text(encoding="utf-8"))
    configured_vault = vault_path if vault_path is not None else raw["vault_path"]
    configured_runtime = runtime_dir if runtime_dir is not None else raw.get("runtime_dir", default_runtime_dir())
    return VaultConfig(
        config_path=resolved_config_path,
        vault_path=Path(configured_vault).expanduser().resolve(),
        runtime_dir=Path(configured_runtime).expanduser().resolve(),
        raw=raw,
    )


def _has_read_bit(path: Path) -> bool:
    mode = stat.S_IMODE(path.stat().st_mode)
    return bool(mode & (stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH))


def validate_vault_config(
    config: VaultConfig,
    *,
    expected_root: Path | str | None = None,
) -> ValidationResult:
    errors: list[ValidationError] = []
    vault_path = config.vault_path

    if not vault_path.exists():
        errors.append(
            validation_error(
                "vault_path_missing",
                f"vault path does not exist: {vault_path}",
                str(vault_path),
            )
        )
    elif not vault_path.is_dir():
        errors.append(
            validation_error(
                "vault_path_not_directory",
                f"vault path is not a directory: {vault_path}",
                str(vault_path),
            )
        )
    elif not os.access(vault_path, os.R_OK | os.X_OK) or not _has_read_bit(vault_path):
        errors.append(
            validation_error(
                "vault_path_unreadable",
                f"vault path is not readable: {vault_path}",
                str(vault_path),
            )
        )

    if expected_root is not None:
        resolved_expected = Path(expected_root).expanduser().resolve()
        try:
            vault_path.relative_to(resolved_expected)
        except ValueError:
            errors.append(
                validation_error(
                    "vault_path_outside_expected_root",
                    f"vault path is outside expected root {resolved_expected}: {vault_path}",
                    str(vault_path),
                )
            )

    return ValidationResult(tuple(errors))
