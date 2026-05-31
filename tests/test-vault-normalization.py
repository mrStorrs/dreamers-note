#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "propose-vault-normalization.py"

spec = importlib.util.spec_from_file_location("propose_vault_normalization", SCRIPT)
normalization = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules["propose_vault_normalization"] = normalization
spec.loader.exec_module(normalization)


class VaultNormalizationTest(unittest.TestCase):
    def write_note(self, vault: Path, relative_path: str, text: str) -> Path:
        path = vault / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def run_script(self, vault: Path, *paths: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["python3", str(SCRIPT), "--vault", str(vault), *paths],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def test_normalizes_relative_paths_to_lowercase_kebab_case(self) -> None:
        self.assertEqual(
            normalization.normalize_relative_path(Path("Projects/My AI Note.md")),
            Path("01-projects/my-ai-note.md"),
        )
        self.assertEqual(
            normalization.normalize_relative_path(Path("Broad Topics/Recipe Ideas.PNG")),
            Path("06-assets/broad-topics/recipe-ideas.png"),
        )
        self.assertEqual(
            normalization.normalize_relative_path(Path("Knowledge/AI/Agents/Skill Routing.md")),
            Path("02-areas/ai/agents/skill-routing.md"),
        )
        self.assertEqual(
            normalization.normalize_relative_path(Path("Knowledge/AI/Agents/Codex/Skill Routing.md")),
            Path("02-areas/ai/agents/codex-skill-routing.md"),
        )

    def test_flags_target_collisions_without_apply_recommendation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            vault = Path(temp_dir)
            self.write_note(vault, "A B.md", "[[linked note]]\n")
            self.write_note(vault, "a-b.md", "second\n")

            entries = normalization.build_entries(
                vault,
                [vault / "A B.md", vault / "a-b.md"],
            )
            proposal = normalization.render_markdown(vault, entries)

            self.assertTrue(all(entry.collision for entry in entries))
            self.assertTrue(
                all(
                    entry.recommended_next_action == "resolve collision before any rename"
                    for entry in entries
                )
            )
            collision_rows = [
                line for line in proposal.splitlines() if line.startswith("| `")
            ]
            self.assertTrue(
                all("resolve collision before any rename" in line for line in collision_rows)
            )
            self.assertTrue(
                all("review proposed rename on a branch" not in line for line in collision_rows)
            )
            self.assertTrue(all("apply" not in line for line in collision_rows))

    def test_flags_existing_target_path_collision(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            vault = Path(temp_dir)
            self.write_note(vault, "A B.md", "first\n")
            self.write_note(vault, "02-areas/uncategorized/general/a-b.md", "already here\n")

            entries = normalization.build_entries(vault, [vault / "A B.md"])

            self.assertEqual(len(entries), 1)
            self.assertTrue(entries[0].collision)
            self.assertIn("target path already exists in the vault", entries[0].collision_reason)

    def test_flags_unselected_normalized_path_collision(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            vault = Path(temp_dir)
            self.write_note(vault, "A B.md", "first\n")
            self.write_note(vault, "a_b.md", "already here\n")

            entries = normalization.build_entries(vault, [vault / "A B.md"])

            self.assertEqual(len(entries), 1)
            self.assertTrue(entries[0].collision)
            self.assertIn("other vault paths normalize to this target", entries[0].collision_reason)

    def test_reports_link_and_attachment_risks_in_chat_proposal(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            vault = Path(temp_dir)
            self.write_note(
                vault,
                "Projects/My Note.md",
                "[[Other Note]]\n![[Pasted image.png]]\n![diagram](assets/Diagram One.png)\n",
            )

            result = self.run_script(vault, "Projects")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(
                "| current path | proposed path | kind | collision risk | link-update needs | attachment risks | recommended next action |",
                result.stdout,
            )
            self.assertIn("`Projects/My Note.md`", result.stdout)
            self.assertIn("`01-projects/my-note.md`", result.stdout)
            self.assertIn("markdown-note", result.stdout)
            self.assertIn("no | yes: link references", result.stdout)
            self.assertIn("link references must be checked or updated before apply", result.stdout)
            self.assertIn("attachment references must be checked or updated before apply", result.stdout)
            self.assertIn("check references before reviewable rename", result.stdout)

    def test_reports_incoming_link_risks(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            vault = Path(temp_dir)
            self.write_note(vault, "Projects/My Note.md", "body\n")
            self.write_note(vault, "Areas/Index.md", "[[My Note]]\n")

            entries = normalization.build_entries(vault, [vault / "Projects" / "My Note.md"])

            self.assertEqual(len(entries), 1)
            self.assertTrue(entries[0].link_update_needed)

    def test_dry_run_does_not_mutate_vault_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            vault = Path(temp_dir)
            original = self.write_note(vault, "Projects/My Note.md", "body\n")

            result = self.run_script(vault, "Projects")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(original.exists())
            self.assertFalse((vault / "01-projects" / "my-note.md").exists())
            self.assertEqual(original.read_text(encoding="utf-8"), "body\n")

    def test_documented_workflow_does_not_mutate_vault_tree_or_content(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            vault = Path(temp_dir)
            self.write_note(vault, "Projects/My Note.md", "---\ntags:\n  - ai\n---\nbody\n")
            self.write_note(vault, "Areas/Index.md", "[[My Note]]\n")
            (vault / "Assets").mkdir()
            (vault / "Assets" / "Pasted Image.PNG").write_bytes(b"image")
            before = {
                path.relative_to(vault).as_posix(): path.read_bytes()
                for path in sorted(vault.rglob("*"))
                if path.is_file()
            }

            result = self.run_script(vault, "Projects", "Areas", "Assets")

            after = {
                path.relative_to(vault).as_posix(): path.read_bytes()
                for path in sorted(vault.rglob("*"))
                if path.is_file()
            }
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(before, after)
            self.assertFalse((vault / "projects").exists())
            self.assertNotIn("apply mode", result.stdout.lower())

    def test_excludes_obsidian_internals(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            vault = Path(temp_dir)
            self.write_note(vault, ".obsidian/Plugin State.md", "settings\n")
            self.write_note(vault, "Projects/My Note.md", "body\n")

            result = self.run_script(vault, ".")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("`Projects/My Note.md`", result.stdout)
            self.assertNotIn("Plugin State", result.stdout)

    def test_skips_symlinked_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            vault = Path(temp_dir) / "vault"
            outside = Path(temp_dir) / "outside"
            vault.mkdir()
            outside.write_text("secret\n", encoding="utf-8")
            (vault / "Projects").mkdir()
            (vault / "Projects" / "outside.md").symlink_to(outside)
            self.write_note(vault, "Projects/My Note.md", "body\n")

            result = self.run_script(vault, "Projects")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("`Projects/My Note.md`", result.stdout)
            self.assertNotIn("outside.md", result.stdout)


if __name__ == "__main__":
    unittest.main()
