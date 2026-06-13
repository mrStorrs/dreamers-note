from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class RuntimeState:
    runtime_dir: Path
    database_path: Path
    wal_path: Path
    log_path: Path


def _touch_private(path: Path) -> None:
    descriptor = os.open(path, os.O_CREAT | os.O_APPEND, 0o600)
    os.close(descriptor)
    path.chmod(0o600)


def initialize_runtime_dir(runtime_dir: Path | str) -> RuntimeState:
    resolved_runtime_dir = Path(runtime_dir).expanduser().resolve()
    resolved_runtime_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    resolved_runtime_dir.chmod(0o700)
    gitignore = resolved_runtime_dir / ".gitignore"
    gitignore.write_text("*\n!.gitignore\n", encoding="utf-8")
    gitignore.chmod(0o600)

    state = RuntimeState(
        runtime_dir=resolved_runtime_dir,
        database_path=resolved_runtime_dir / "dreamers-note.sqlite3",
        wal_path=resolved_runtime_dir / "dreamers-note.sqlite3-wal",
        log_path=resolved_runtime_dir / "dreamers-note.log",
    )
    for path in (state.database_path, state.wal_path, state.log_path):
        _touch_private(path)
    return state
