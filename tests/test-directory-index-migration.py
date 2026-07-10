#!/usr/bin/env python3
from __future__ import annotations

import unittest

try:
    from helpers.script_fixtures import ROOT, ScriptWorkspace
except ModuleNotFoundError:
    from tests.helpers.script_fixtures import ROOT, ScriptWorkspace


MIGRATION_SCRIPT = ROOT / "scripts" / "migrate-directory-indexes.py"


class DirectoryIndexMigrationTest(unittest.TestCase):
    def run_migration(self, workspace: ScriptWorkspace, *args: str):
        return workspace.run_python(
            MIGRATION_SCRIPT,
            "--vault",
            workspace.vault,
            *args,
        )

    def test_dry_run_reports_recursive_indexes_without_mutating_the_vault(self) -> None:
        with ScriptWorkspace() as workspace:
            workspace.write_text(
                "01-projects/linux-install/install-plan.md",
                "Install notes for a Linux workstation.\n",
            )
            workspace.write_text(
                "02-knowledge/games/project-zomboid/project-zomboid.md",
                "Project Zomboid owner notes.\n",
            )
            workspace.init_git(branch="directory-index-fixture")

            result = self.run_migration(workspace, "--dry-run")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("mode: dry-run", result.stdout)
            self.assertIn("eligible directories: 3", result.stdout)
            self.assertIn("created indexes: 2", result.stdout)
            self.assertIn("renamed owner notes: 1", result.stdout)
            self.assertIn("02-knowledge/games/_games.md", result.stdout)
            self.assertIn("02-knowledge/games/project-zomboid/_project-zomboid.md", result.stdout)
            self.assertTrue((workspace.vault / "02-knowledge/games/project-zomboid/project-zomboid.md").exists())
            self.assertFalse((workspace.vault / "02-knowledge/games/_games.md").exists())
            self.assertEqual(workspace.git(["status", "--short"]).stdout, "")

    def test_write_renames_owner_notes_and_rewrites_wiki_and_markdown_links(self) -> None:
        with ScriptWorkspace() as workspace:
            owner_body = (
                "# Project Zomboid\n\nRelated: [[games]]\n\n"
                "Project Zomboid hub for run planning, spawn notes, Lua commands, and helper references.\n\n"
                "## Build\n\nUseful setup details.\n"
            )
            workspace.write_text(
                "02-knowledge/games/project-zomboid/project-zomboid.md",
                owner_body,
            )
            workspace.write_text(
                "02-knowledge/games/project-zomboid/sandbox-settings.md",
                "Sandbox settings cover population and loot tuning.\n",
            )
            workspace.write_text(
                "02-knowledge/games/links.md",
                "[[project-zomboid]]\n[[02-knowledge/games/project-zomboid/project-zomboid#Build|Build notes]]\n[guide](02-knowledge/games/project-zomboid/project-zomboid.md#Build)\n",
            )
            workspace.init_git(branch="directory-index-fixture")

            result = self.run_migration(workspace, "--write")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("mode: write", result.stdout)
            self.assertIn("renamed owner notes: 1", result.stdout)
            index_path = workspace.vault / "02-knowledge/games/project-zomboid/_project-zomboid.md"
            self.assertFalse((workspace.vault / "02-knowledge/games/project-zomboid/project-zomboid.md").exists())
            self.assertTrue(index_path.exists())
            index_text = index_path.read_text(encoding="utf-8")
            self.assertEqual(
                index_text.splitlines()[0],
                "Project Zomboid covers run planning, spawn notes, Lua commands, and helper references.",
            )
            self.assertNotIn("directory homepage", index_text.splitlines()[0].lower())
            self.assertFalse(index_text.lstrip().startswith("#"))
            self.assertIn(f"## Notes\n\n{owner_body}", index_text)
            self.assertIn("## Pages", index_text)
            self.assertIn("[[02-knowledge/games/project-zomboid/sandbox-settings|Sandbox Settings]]", index_text)
            links_text = (workspace.vault / "02-knowledge/games/links.md").read_text(encoding="utf-8")
            self.assertIn("[[02-knowledge/games/project-zomboid/_project-zomboid|project-zomboid]]", links_text)
            self.assertIn(
                "[[02-knowledge/games/project-zomboid/_project-zomboid#Build|Build notes]]",
                links_text,
            )
            self.assertIn(
                "[guide](02-knowledge/games/project-zomboid/_project-zomboid.md#Build)",
                links_text,
            )

    def test_new_index_lead_summarizes_direct_topics(self) -> None:
        with ScriptWorkspace() as workspace:
            workspace.write_text(
                "02-knowledge/games/board-games.md",
                "Board game notes cover strategy and recommendations.\n",
            )
            workspace.write_text(
                "02-knowledge/games/project-zomboid/servers.md",
                "Server notes cover hosting.\n",
            )
            workspace.init_git(branch="directory-index-fixture")

            result = self.run_migration(workspace, "--write")

            self.assertEqual(result.returncode, 0, result.stderr)
            index = (workspace.vault / "02-knowledge/games/_games.md").read_text(encoding="utf-8")
            self.assertEqual(
                index.splitlines()[0],
                "Games collects notes on Project Zomboid and Board Games.",
            )
            self.assertNotIn("directory homepage", index.splitlines()[0].lower())

    def test_owner_summary_removes_qualified_hub_role_language(self) -> None:
        with ScriptWorkspace() as workspace:
            workspace.write_text(
                "02-knowledge/games/disgaea-6/disgaea-6.md",
                "Disgaea 6 mechanics hub for evilities and Item World planning.\n",
            )
            workspace.init_git(branch="directory-index-fixture")

            result = self.run_migration(workspace, "--write")

            self.assertEqual(result.returncode, 0, result.stderr)
            index = (workspace.vault / "02-knowledge/games/disgaea-6/_disgaea-6.md").read_text(
                encoding="utf-8"
            )
            self.assertEqual(
                index.splitlines()[0],
                "Disgaea 6 covers evilities and Item World planning, with a focus on mechanics.",
            )
            self.assertNotIn("hub for", index.splitlines()[0].lower())

    def test_dry_run_lists_internal_paths_it_skips(self) -> None:
        with ScriptWorkspace() as workspace:
            workspace.write_text("02-knowledge/games/board-games.md", "Board game notes.\n")
            workspace.write_text("02-knowledge/games/.obsidian/state.md", "internal state\n")
            workspace.write_text("00-inbox/daily-notes/2026-07-09.md", "Daily note\n")
            workspace.init_git(branch="directory-index-fixture")

            result = self.run_migration(workspace, "--dry-run")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("skipped paths: 1", result.stdout)
            self.assertIn("- skipped: 02-knowledge/games/.obsidian", result.stdout)
            self.assertNotIn("02-knowledge/games/.obsidian/_", result.stdout)

    def test_refresh_preserves_existing_notes_while_regenerating_homepage_sections(self) -> None:
        with ScriptWorkspace() as workspace:
            preserved_notes = "\n\nKeep this human-owned summary exactly as written.\n\n### Detail\n\nThe nested detail must also remain.\n"
            workspace.write_text(
                "02-knowledge/games/_games.md",
                "Old generated lead.\n\n## Notes" + preserved_notes + "\n## Pages\n\n- stale page\n",
            )
            workspace.write_text(
                "02-knowledge/games/board-games.md",
                "Board game notes cover strategy and recommendations.\n",
            )
            workspace.write_text(
                "02-knowledge/games/project-zomboid/servers.md",
                "Server notes cover hosting.\n",
            )
            workspace.init_git(branch="directory-index-fixture")

            result = self.run_migration(workspace, "--write")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("refreshed indexes: 1", result.stdout)
            refreshed = (workspace.vault / "02-knowledge/games/_games.md").read_text(encoding="utf-8")
            self.assertNotIn("Old generated lead.", refreshed)
            self.assertIn(preserved_notes, refreshed)
            self.assertIn("## Subfolders", refreshed)
            self.assertIn("[[02-knowledge/games/project-zomboid/_project-zomboid|Project Zomboid]]", refreshed)
            self.assertIn("## Pages", refreshed)
            self.assertIn("[[02-knowledge/games/board-games|Board Games]]", refreshed)

    def test_page_summary_skips_related_metadata_for_substantive_description(self) -> None:
        with ScriptWorkspace() as workspace:
            workspace.write_text(
                "02-knowledge/games/project-zomboid/more-traits-antique-collector-loot-rate.md",
                "Related: [[project-zomboid]]\n\nCaptured: 2026-07-04\n\n"
                "Adjust antique collector loot rates for More Traits in Project Zomboid.\n",
            )
            workspace.init_git(branch="directory-index-fixture")

            result = self.run_migration(workspace, "--write")

            self.assertEqual(result.returncode, 0, result.stderr)
            index = (
                workspace.vault / "02-knowledge/games/project-zomboid/_project-zomboid.md"
            ).read_text(encoding="utf-8")
            self.assertIn(
                "[[02-knowledge/games/project-zomboid/more-traits-antique-collector-loot-rate|"
                "More Traits Antique Collector Loot Rate]] - Adjust antique collector loot rates for "
                "More Traits in Project Zomboid.",
                index,
            )
            self.assertNotIn("- Related: Project Zomboid", index)
            self.assertNotIn("- Captured: 2026-07-04", index)

    def test_migration_rejects_dirty_vaults_before_creating_indexes(self) -> None:
        with ScriptWorkspace() as workspace:
            workspace.write_text("02-knowledge/games/board-games.md", "Board game notes.\n")
            workspace.init_git(branch="directory-index-fixture")
            workspace.write_text("unrelated.md", "uncommitted work\n")

            result = self.run_migration(workspace, "--dry-run")

            self.assertEqual(result.returncode, 2)
            self.assertIn("vault worktree is dirty", result.stderr)
            self.assertFalse((workspace.vault / "02-knowledge/games/_games.md").exists())

    def test_migration_rejects_existing_indexes_without_a_notes_section(self) -> None:
        with ScriptWorkspace() as workspace:
            index_path = workspace.write_text(
                "02-knowledge/games/_games.md",
                "Unstructured content that must not be replaced.\n",
            )
            workspace.write_text("02-knowledge/games/board-games.md", "Board game notes.\n")
            workspace.init_git(branch="directory-index-fixture")

            result = self.run_migration(workspace, "--write")

            self.assertEqual(result.returncode, 2)
            self.assertIn("index conflict", result.stderr)
            self.assertEqual(index_path.read_text(encoding="utf-8"), "Unstructured content that must not be replaced.\n")


if __name__ == "__main__":
    unittest.main()
