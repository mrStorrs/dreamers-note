#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "propose-daily-triage.py"
TAGS = ROOT / "taxonomy" / "approved-tags.md"


def load_module():
    spec = importlib.util.spec_from_file_location("propose_daily_triage", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


TRIAGE = load_module()


class DailyTriageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.vault = Path(self.temp.name) / "vault"
        self.vault.mkdir()
        subprocess.run(["git", "-C", str(self.vault), "init", "-q"], check=True)
        note_dir = self.vault / "00-inbox" / "daily-notes"
        note_dir.mkdir(parents=True)
        self.note = note_dir / "2026-05-31.md"
        self.note.write_text(
            "\n".join(
                [
                    "# 2026-05-31",
                    "",
                    "## project: recipe ai planner",
                    "Build a planner that connects dinner ideas to shopping lists. #ai #recipes #cooking",
                    "",
                    "## area: obsidian/tags/topical tag retrieval",
                    "Tags should describe retrieval intent across the vault. tags: obsidian, gardening",
                    "",
                    "## source: local first note article",
                    "An article argued that local-first notes work well with Git review. #local-first #research",
                    "",
                ]
            ),
            encoding="utf-8",
        )
        subprocess.run(["git", "-C", str(self.vault), "add", "."], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(self.vault),
                "-c",
                "user.name=dreamers-test",
                "-c",
                "user.email=dreamers-test@example.invalid",
                "commit",
                "-qm",
                "baseline",
            ],
            check=True,
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_extracts_project_area_and_source_destinations(self) -> None:
        approved = TRIAGE.load_approved_tags(TAGS)
        fragments = TRIAGE.parse_fragments(self.vault, self.note, approved)

        self.assertEqual(
            [fragment.destination.as_posix() for fragment in fragments],
            [
                "01-projects/uncategorized/general/recipe-ai-planner.md",
                "02-knowledge/obsidian/tags/topical-tag-retrieval.md",
                "03-sources/local-first-note-article.md",
            ],
        )

    def test_applies_only_approved_tags_and_reports_new_tags_separately(self) -> None:
        proposal = self.run_script("00-inbox/daily-notes/2026-05-31.md")

        self.assertIn("| `00-inbox/daily-notes/2026-05-31.md` | project | recipe ai planner |", proposal)
        self.assertIn("| new note | ai, recipes | cooking |", proposal)
        self.assertIn("| new note | obsidian | gardening |", proposal)
        self.assertIn("| new note | local-first | research |", proposal)

    def test_existing_destination_is_reported_as_reviewable_diff_risk(self) -> None:
        destination = self.vault / "01-projects" / "uncategorized" / "general" / "recipe-ai-planner.md"
        destination.parent.mkdir(parents=True)
        destination.write_text("existing project note\n", encoding="utf-8")

        proposal = self.run_script("00-inbox/daily-notes/2026-05-31.md")

        self.assertIn("exists - preserve reviewable diff", proposal)

    def test_proposal_includes_backlinks_and_source_context(self) -> None:
        proposal = self.run_script("00-inbox/daily-notes/2026-05-31.md")

        self.assertIn("[[2026-05-31]]", proposal)
        self.assertIn("Build a planner that connects dinner ideas", proposal)
        self.assertIn("source: [[2026-05-31]]", proposal)
        project_stub = self.note_stub("01-projects/uncategorized/general/recipe-ai-planner.md", proposal)
        self.assertNotIn("#cooking", project_stub)
        self.assertIn("#ai", project_stub)

    def test_archive_is_blocked_until_extraction_is_visible_in_git(self) -> None:
        proposal = self.run_script("--archive", "00-inbox/daily-notes/2026-05-31.md")

        self.assertIn("blocked: keep `00-inbox/daily-notes/2026-05-31.md` in place", proposal)
        self.assertIn("until extracted destination changes are visible in Git status or diff", proposal)

    def test_archive_is_ready_when_all_destination_changes_are_visible(self) -> None:
        destinations = [
            self.vault / "01-projects" / "uncategorized" / "general" / "recipe-ai-planner.md",
            self.vault / "02-knowledge" / "obsidian" / "tags" / "topical-tag-retrieval.md",
            self.vault / "03-sources" / "local-first-note-article.md",
        ]
        for destination in destinations:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text("draft extraction\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(self.vault), "add", "."], check=True)

        proposal = self.run_script("--archive", "00-inbox/daily-notes/2026-05-31.md")

        self.assertIn("ready after review: move `00-inbox/daily-notes/2026-05-31.md`", proposal)
        self.assertIn("99-archive/daily-notes/2026-05-31.md", proposal)

    def test_archive_is_ready_when_destination_changes_are_untracked(self) -> None:
        destinations = [
            self.vault / "01-projects" / "uncategorized" / "general" / "recipe-ai-planner.md",
            self.vault / "02-knowledge" / "obsidian" / "tags" / "topical-tag-retrieval.md",
            self.vault / "03-sources" / "local-first-note-article.md",
        ]
        for destination in destinations:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text("draft extraction\n", encoding="utf-8")

        proposal = self.run_script("--archive", "00-inbox/daily-notes/2026-05-31.md")

        self.assertIn("ready after review: move `00-inbox/daily-notes/2026-05-31.md`", proposal)

    def test_defaults_to_all_inbox_daily_notes(self) -> None:
        second_note = self.vault / "00-inbox" / "daily-notes" / "2026-06-01.md"
        second_note.write_text(
            "\n".join(
                [
                    "# 2026-06-01",
                    "",
                    "## project: linux install steam mounts",
                    "Keep Steam libraries mounted before Steam starts. #linux",
                    "",
                ]
            ),
            encoding="utf-8",
        )

        proposal = self.run_script()

        self.assertIn("- `00-inbox/daily-notes/2026-05-31.md`", proposal)
        self.assertIn("- `00-inbox/daily-notes/2026-06-01.md`", proposal)
        self.assertIn("linux install steam mounts", proposal)

    def run_script(self, *args: str) -> str:
        result = subprocess.run(
            ["python3", str(SCRIPT), "--vault", str(self.vault), "--tags", str(TAGS), *args],
            text=True,
            capture_output=True,
            check=True,
        )
        return result.stdout

    def note_stub(self, destination: str, proposal: str) -> str:
        marker = f"### `{destination}`"
        start = proposal.index(marker)
        block_start = proposal.index("```markdown", start) + len("```markdown")
        block_end = proposal.index("```", block_start)
        return proposal[block_start:block_end]


if __name__ == "__main__":
    unittest.main()
