#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


class PackageFoundationTests(unittest.TestCase):
    def write_config(self, directory: Path, vault_path: Path) -> Path:
        config = directory / "vault.json"
        config.write_text(json.dumps({"vault_path": str(vault_path)}) + "\n", encoding="utf-8")
        return config

    def assert_rejected(self, vault: Path, raw_path: str, reason: str) -> None:
        from dreamers_note.safety import classify_vault_path

        result = classify_vault_path(vault, raw_path, private_globs=["private/**"])

        self.assertFalse(result.allowed, raw_path)
        self.assertEqual(result.reason, reason)

    def test_pyproject_declares_package_and_cli_metadata(self) -> None:
        metadata = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))

        self.assertEqual(metadata["project"]["name"], "dreamers-note")
        self.assertEqual(metadata["project"]["requires-python"], ">=3.12")
        self.assertEqual(metadata["project"]["scripts"]["dreamers-note"], "dreamers_note.cli:main")

    def test_cli_status_reads_config_without_mutating_vault(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            vault = root / "vault"
            runtime = root / "runtime"
            vault.mkdir()
            sentinel = vault / "sentinel.md"
            sentinel.write_text("keep\n", encoding="utf-8")
            config = self.write_config(root, vault)
            before = {
                path.relative_to(vault).as_posix(): path.read_bytes()
                for path in sorted(vault.rglob("*"))
                if path.is_file()
            }

            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "dreamers_note",
                    "status",
                    "--config",
                    str(config),
                    "--runtime-dir",
                    str(runtime),
                    "--no-init-runtime",
                ],
                cwd=ROOT,
                check=False,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )

            after = {
                path.relative_to(vault).as_posix(): path.read_bytes()
                for path in sorted(vault.rglob("*"))
                if path.is_file()
            }
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(f"vault_path: {vault}", result.stdout)
            self.assertIn(f"runtime_dir: {runtime}", result.stdout)
            self.assertEqual(before, after)
            self.assertFalse(runtime.exists())

    def test_vault_config_validation_returns_structured_errors(self) -> None:
        from dreamers_note.config import load_vault_config, validate_vault_config

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            expected_root = root / "vaults"
            expected_root.mkdir()

            missing_config = self.write_config(root, root / "missing")
            missing = validate_vault_config(
                load_vault_config(missing_config),
                expected_root=expected_root,
            )
            self.assertFalse(missing.ok)
            self.assertIn("vault_path_missing", [error.reason for error in missing.errors])

            outside_vault = root / "outside-vault"
            outside_vault.mkdir()
            outside_config = self.write_config(root, outside_vault)
            outside = validate_vault_config(
                load_vault_config(outside_config),
                expected_root=expected_root,
            )
            self.assertFalse(outside.ok)
            self.assertIn("vault_path_outside_expected_root", [error.reason for error in outside.errors])

            unreadable_vault = expected_root / "unreadable"
            unreadable_vault.mkdir()
            unreadable_config = self.write_config(root, unreadable_vault)
            original_mode = unreadable_vault.stat().st_mode
            unreadable_vault.chmod(0)
            try:
                unreadable = validate_vault_config(
                    load_vault_config(unreadable_config),
                    expected_root=expected_root,
                )
            finally:
                unreadable_vault.chmod(original_mode)
            self.assertFalse(unreadable.ok)
            self.assertIn("vault_path_unreadable", [error.reason for error in unreadable.errors])

    def test_path_safety_rejects_private_escape_and_ambiguous_paths(self) -> None:
        from dreamers_note.safety import classify_vault_path

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            vault = root / "vault"
            outside = root / "outside.md"
            vault.mkdir()
            outside.write_text("outside\n", encoding="utf-8")
            (vault / ".git").mkdir()
            (vault / ".obsidian").mkdir()
            (vault / ".codex").mkdir()
            (vault / "07-system" / "secrets").mkdir(parents=True)
            (vault / "private").mkdir()
            (vault / "Topic.md").write_text("case\n", encoding="utf-8")
            (vault / "cafe\u0301.md").write_text("unicode\n", encoding="utf-8")
            (vault / "linked.md").symlink_to(outside)

            self.assert_rejected(vault, ".git/config", "excluded_root")
            self.assert_rejected(vault, ".obsidian/workspace.json", "excluded_root")
            self.assert_rejected(vault, ".codex/skills/local.md", "excluded_root")
            self.assert_rejected(vault, "07-system/secrets/key.md", "private_path")
            self.assert_rejected(vault, "linked.md", "symlink")
            self.assert_rejected(vault, "private/note.md", "private_glob")
            self.assert_rejected(vault, "../outside.md", "parent_traversal")
            self.assert_rejected(vault, str(outside), "outside_vault")
            self.assert_rejected(vault, "folder%2Fsecret.md", "encoded_separator")
            self.assert_rejected(vault, "folder/with\ncontrol.md", "control_character")
            self.assert_rejected(vault, " folder/note.md", "boundary_space")
            self.assert_rejected(vault, "folder/note.md ", "boundary_space")
            self.assert_rejected(vault, "topic.md", "case_collision")
            self.assert_rejected(vault, "café.md", "unicode_normalization_collision")

            allowed = classify_vault_path(vault, "02-knowledge/ai/agents/note.md")
            self.assertTrue(allowed.allowed, allowed.reason)
            self.assertEqual(allowed.relative_path, Path("02-knowledge/ai/agents/note.md"))

    def test_vault_file_listing_uses_path_safety_rules(self) -> None:
        from dreamers_note.paths import list_vault_files

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            vault = root / "vault"
            outside = root / "outside.md"
            vault.mkdir()
            outside.write_text("outside\n", encoding="utf-8")
            (vault / "02-knowledge" / "ai" / "agents").mkdir(parents=True)
            (vault / "02-knowledge" / "ai" / "agents" / "safe.md").write_text(
                "safe\n",
                encoding="utf-8",
            )
            (vault / ".codex" / "skills").mkdir(parents=True)
            (vault / ".codex" / "skills" / "local.md").write_text("skill\n", encoding="utf-8")
            (vault / "07-system" / "secrets").mkdir(parents=True)
            (vault / "07-system" / "secrets" / "key.md").write_text("secret\n", encoding="utf-8")
            (vault / "private").mkdir()
            (vault / "private" / "note.md").write_text("private\n", encoding="utf-8")
            (vault / "02-knowledge" / "ai" / "agents" / "linked.md").symlink_to(outside)

            files = list_vault_files(vault, ["."], private_globs=["private/**"])

            self.assertEqual(
                [path.relative_to(vault).as_posix() for path in files],
                ["02-knowledge/ai/agents/safe.md"],
            )

    def test_convention_validation_rejects_legacy_roots_and_unapproved_tags(self) -> None:
        from dreamers_note.conventions import validate_note_conventions

        approved = {"ai", "recipes"}

        for valid_path in [
            Path("01-projects/ai/agents/note.md"),
            Path("02-knowledge/ai/agents/note.md"),
            Path("04-people/family/friends/jane-doe.md"),
        ]:
            self.assertTrue(
                validate_note_conventions(valid_path, ["ai"], approved).ok,
                valid_path.as_posix(),
            )

        legacy_area = validate_note_conventions(
            Path("02-areas/ai/agents/note.md"),
            ["ai"],
            approved,
        )
        legacy_knowledge = validate_note_conventions(
            Path("03-knowledge/ai/agents/note.md"),
            ["ai"],
            approved,
        )
        shallow = validate_note_conventions(Path("02-knowledge/ai/note.md"), ["ai"], approved)
        bad_tags = validate_note_conventions(
            Path("02-knowledge/ai/agents/note.md"),
            ["ai", "private-cooking"],
            approved,
        )
        uppercase = validate_note_conventions(
            Path("02-knowledge/AI/agents/note.md"),
            ["ai"],
            approved,
        )
        spaces = validate_note_conventions(
            Path("02-knowledge/ai/Bad Name/note.md"),
            ["ai"],
            approved,
        )

        self.assertIn("disallowed_root", [error.reason for error in legacy_area.errors])
        self.assertIn("disallowed_root", [error.reason for error in legacy_knowledge.errors])
        self.assertIn("classified_note_depth", [error.reason for error in shallow.errors])
        self.assertIn("unapproved_tag", [error.reason for error in bad_tags.errors])
        self.assertIn("lowercase_kebab_case", [error.reason for error in uppercase.errors])
        self.assertIn("lowercase_kebab_case", [error.reason for error in spaces.errors])

    def test_runtime_initialization_is_private_and_git_ignored(self) -> None:
        from dreamers_note.runtime import initialize_runtime_dir

        with tempfile.TemporaryDirectory() as temp_dir:
            runtime_dir = Path(temp_dir) / ".dreamers" / "runtime"

            state = initialize_runtime_dir(runtime_dir)

            self.assertTrue(state.runtime_dir.is_dir())
            self.assertEqual(stat.S_IMODE(state.runtime_dir.stat().st_mode), 0o700)
            self.assertEqual((state.runtime_dir / ".gitignore").read_text(encoding="utf-8"), "*\n!.gitignore\n")
            for path in [state.database_path, state.wal_path, state.log_path]:
                self.assertTrue(path.exists(), path)
                self.assertEqual(stat.S_IMODE(path.stat().st_mode) & stat.S_IRWXO, 0)
                self.assertEqual(stat.S_IMODE(path.stat().st_mode) & stat.S_IRWXG, 0)

    def test_vault_remap_common_is_package_facade(self) -> None:
        sys.path.insert(0, str(ROOT / "scripts"))
        try:
            import vault_remap_common
            from dreamers_note import paths

            self.assertIs(vault_remap_common.proposed_path_for, paths.proposed_path_for)
            self.assertEqual(
                vault_remap_common.proposed_path_for(Path("Projects/AI Note.md")),
                Path("01-projects/uncategorized/general/ai-note.md"),
            )
            self.assertEqual(
                vault_remap_common.extract_wikilinks("[[Note|alias]] ![[Asset.png]]"),
                ["Asset.png", "Note"],
            )
        finally:
            sys.path.pop(0)


if __name__ == "__main__":
    unittest.main()
