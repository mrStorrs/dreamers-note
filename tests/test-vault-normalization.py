#!/usr/bin/env python3
from __future__ import annotations

import unittest
from pathlib import Path

try:
    from helpers.script_fixtures import ROOT, ScriptWorkspace, load_script_module
except ModuleNotFoundError:
    from tests.helpers.script_fixtures import ROOT, ScriptWorkspace, load_script_module

SCRIPT = ROOT / "scripts" / "propose-vault-normalization.py"

normalization = load_script_module("propose_vault_normalization", SCRIPT)


class VaultNormalizationTest(unittest.TestCase):
    def test_normalizes_relative_paths_to_lowercase_kebab_case(self) -> None:
        self.assertEqual(
            normalization.normalize_relative_path(Path("Projects/My AI Note.md")),
            Path("01-projects/uncategorized/general/my-ai-note.md"),
        )
        self.assertEqual(
            normalization.normalize_relative_path(Path("Projects/AI/Obsidian/My AI Note.md")),
            Path("01-projects/ai/obsidian/my-ai-note.md"),
        )
        self.assertEqual(
            normalization.normalize_relative_path(Path("Family/Immediate/Jane Doe.md")),
            Path("04-people/family/immediate/jane-doe.md"),
        )
        self.assertEqual(
            normalization.normalize_relative_path(Path("Broad Topics/Recipe Ideas.PNG")),
            Path("05-assets/broad-topics/recipe-ideas.png"),
        )
        self.assertEqual(
            normalization.normalize_relative_path(Path("Knowledge/AI/Agents/Skill Routing.md")),
            Path("02-knowledge/ai/agents/skill-routing.md"),
        )
        self.assertEqual(
            normalization.normalize_relative_path(Path("Knowledge/AI/Agents/Codex/Skill Routing.md")),
            Path("02-knowledge/ai/agents/codex-skill-routing.md"),
        )

    def test_flags_target_collisions_without_apply_recommendation(self) -> None:
        with ScriptWorkspace() as workspace:
            vault = workspace.vault
            workspace.write_text("A B.md", "[[linked note]]\n")
            workspace.write_text("a-b.md", "second\n")

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
        with ScriptWorkspace() as workspace:
            vault = workspace.vault
            workspace.write_text("A B.md", "first\n")
            workspace.write_text("02-knowledge/uncategorized/general/a-b.md", "already here\n")

            entries = normalization.build_entries(vault, [vault / "A B.md"])

            self.assertEqual(len(entries), 1)
            self.assertTrue(entries[0].collision)
            self.assertIn("target path already exists in the vault", entries[0].collision_reason)

    def test_flags_unselected_normalized_path_collision(self) -> None:
        with ScriptWorkspace() as workspace:
            vault = workspace.vault
            workspace.write_text("A B.md", "first\n")
            workspace.write_text("a_b.md", "already here\n")

            entries = normalization.build_entries(vault, [vault / "A B.md"])

            self.assertEqual(len(entries), 1)
            self.assertTrue(entries[0].collision)
            self.assertIn("other vault paths normalize to this target", entries[0].collision_reason)

    def test_reports_link_and_attachment_risks_in_chat_proposal(self) -> None:
        with ScriptWorkspace() as workspace:
            vault = workspace.vault
            workspace.write_text(
                "Projects/My Note.md",
                "[[Other Note]]\n![[Pasted image.png]]\n![diagram](assets/Diagram One.png)\n",
            )

            result = workspace.run_python(SCRIPT, "--vault", vault, "Projects")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(
                "| current path | proposed path | kind | collision risk | link-update needs | attachment risks | recommended next action |",
                result.stdout,
            )
            self.assertIn("`Projects/My Note.md`", result.stdout)
            self.assertIn("`01-projects/uncategorized/general/my-note.md`", result.stdout)
            self.assertIn("markdown-note", result.stdout)
            self.assertIn("no | yes: link references", result.stdout)
            self.assertIn("link references must be checked or updated before apply", result.stdout)
            self.assertIn("attachment references must be checked or updated before apply", result.stdout)
            self.assertIn("check references before reviewable rename", result.stdout)

    def test_reports_incoming_link_risks(self) -> None:
        with ScriptWorkspace() as workspace:
            vault = workspace.vault
            workspace.write_text("Projects/My Note.md", "body\n")
            workspace.write_text("Areas/Index.md", "[[My Note]]\n")

            entries = normalization.build_entries(vault, [vault / "Projects" / "My Note.md"])

            self.assertEqual(len(entries), 1)
            self.assertTrue(entries[0].link_update_needed)

    def test_builds_one_reference_index_for_multi_file_selection(self) -> None:
        with ScriptWorkspace() as workspace:
            vault = workspace.vault
            first = workspace.write_text("Projects/First Note.md", "body\n")
            second = workspace.write_text("Projects/Second Note.md", "body\n")
            workspace.write_text("Areas/Index.md", "[[First Note]]\n[[Second Note]]\n")
            calls = 0
            original = normalization.build_reference_index

            def counting_reference_index(vault_path: Path, markdown_files: list[Path]):
                nonlocal calls
                calls += 1
                return original(vault_path, markdown_files)

            normalization.build_reference_index = counting_reference_index
            try:
                entries = normalization.build_entries(
                    vault,
                    [first, second],
                    normalization.resolve_selected_paths(vault, ["."]),
                )
            finally:
                normalization.build_reference_index = original

            self.assertEqual(calls, 1)
            self.assertEqual(len(entries), 2)
            self.assertTrue(all(entry.link_update_needed for entry in entries))

    def test_dry_run_does_not_mutate_vault_files(self) -> None:
        with ScriptWorkspace() as workspace:
            vault = workspace.vault
            original = workspace.write_text("Projects/My Note.md", "body\n")

            result = workspace.run_python(SCRIPT, "--vault", vault, "Projects")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(original.exists())
            self.assertFalse((vault / "01-projects" / "my-note.md").exists())
            self.assertEqual(original.read_text(encoding="utf-8"), "body\n")

    def test_documented_workflow_does_not_mutate_vault_tree_or_content(self) -> None:
        with ScriptWorkspace() as workspace:
            vault = workspace.vault
            workspace.write_text("Projects/My Note.md", "---\ntags:\n  - ai\n---\nbody\n")
            workspace.write_text("Areas/Index.md", "[[My Note]]\n")
            (vault / "Assets").mkdir()
            (vault / "Assets" / "Pasted Image.PNG").write_bytes(b"image")
            before = {
                path.relative_to(vault).as_posix(): path.read_bytes()
                for path in sorted(vault.rglob("*"))
                if path.is_file()
            }

            result = workspace.run_python(SCRIPT, "--vault", vault, "Projects", "Areas", "Assets")

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
        with ScriptWorkspace() as workspace:
            vault = workspace.vault
            workspace.write_text(".obsidian/Plugin State.md", "settings\n")
            workspace.write_text("Projects/My Note.md", "body\n")

            result = workspace.run_python(SCRIPT, "--vault", vault, ".")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("`Projects/My Note.md`", result.stdout)
            self.assertNotIn("Plugin State", result.stdout)

    def test_skips_symlinked_files(self) -> None:
        with ScriptWorkspace() as workspace:
            vault = workspace.vault
            outside = workspace.root / "outside"
            outside.write_text("secret\n", encoding="utf-8")
            (vault / "Projects").mkdir()
            (vault / "Projects" / "outside.md").symlink_to(outside)
            workspace.write_text("Projects/My Note.md", "body\n")

            result = workspace.run_python(SCRIPT, "--vault", vault, "Projects")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("`Projects/My Note.md`", result.stdout)
            self.assertNotIn("outside.md", result.stdout)


if __name__ == "__main__":
    unittest.main()
