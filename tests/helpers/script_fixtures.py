from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from types import ModuleType
from typing import Any


ROOT = Path(__file__).resolve().parents[2]


def load_script_module(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    if spec.loader is None:
        raise RuntimeError(f"cannot load script module: {path}")
    sys.modules[spec.name] = module
    script_dir = str(path.parent)
    added_path = script_dir not in sys.path
    if added_path:
        sys.path.insert(0, script_dir)
    try:
        spec.loader.exec_module(module)
    finally:
        if added_path:
            sys.path.remove(script_dir)
    return module


class ScriptWorkspace:
    def __init__(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.root = Path(self._temp.name)
        self.vault = self.root / "vault"
        self.indexes = self.root / "indexes"
        self.vault.mkdir()

    def __enter__(self) -> "ScriptWorkspace":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.cleanup()

    def cleanup(self) -> None:
        self._temp.cleanup()

    def path(self, relative_path: str | Path, *, base: Path | None = None) -> Path:
        return (base or self.vault) / relative_path

    def write_text(self, relative_path: str | Path, text: str, *, base: Path | None = None) -> Path:
        path = self.path(relative_path, base=base)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def write_binary(self, relative_path: str | Path, content: bytes, *, base: Path | None = None) -> Path:
        path = self.path(relative_path, base=base)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    def write_jsonl(self, relative_path: str | Path, records: list[dict[str, Any]], *, base: Path | None = None) -> Path:
        path = self.path(relative_path, base=base or self.root)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            "".join(json.dumps(record, sort_keys=True) + "\n" for record in records),
            encoding="utf-8",
        )
        return path

    def read_jsonl(self, relative_path: str | Path, *, base: Path | None = None) -> list[dict[str, Any]]:
        path = self.path(relative_path, base=base or self.root)
        return [
            json.loads(line)
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def init_git(self, *, branch: str | None = None, message: str = "baseline") -> None:
        self.git(["init", "-q"], check=True)
        if branch:
            self.git(["checkout", "-qb", branch], check=True)
        self.git(["add", "."], check=True)
        if not self.git(["status", "--short"]).stdout.strip():
            return
        self.git(
            [
                "-c",
                "user.name=dreamers-test",
                "-c",
                "user.email=dreamers-test@example.invalid",
                "commit",
                "-qm",
                message,
            ],
            check=True,
        )

    def git(self, args: list[str], *, check: bool = False) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", "-C", str(self.vault), *args],
            check=check,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def run_python(
        self,
        script: Path,
        *args: object,
        check: bool = False,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["python3", str(script), *[str(arg) for arg in args]],
            check=check,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
