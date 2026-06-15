#!/usr/bin/env python3
from __future__ import annotations

import json
import unittest
from pathlib import Path

try:
    from helpers.script_fixtures import ROOT, ScriptWorkspace
except ModuleNotFoundError:
    from tests.helpers.script_fixtures import ROOT, ScriptWorkspace

INVENTORY_SCRIPT = ROOT / "scripts" / "build-vault-inventory.py"
APPLY_SCRIPT = ROOT / "scripts" / "apply-vault-remap.py"
APPROVED_TAGS = ROOT / "taxonomy" / "approved-tags.md"


class VaultRemapTest(unittest.TestCase):
    def run_inventory(
        self, workspace: ScriptWorkspace, *paths: str
    ):
        return workspace.run_python(
            INVENTORY_SCRIPT,
            "--vault",
            workspace.vault,
            "--indexes",
            workspace.indexes,
            "--tags",
            APPROVED_TAGS,
            *paths,
        )

    def run_apply(
        self, workspace: ScriptWorkspace, *extra_args: str
    ):
        return workspace.run_python(
            APPLY_SCRIPT,
            "--vault",
            workspace.vault,
            "--indexes",
            workspace.indexes,
            "--tags",
            APPROVED_TAGS,
            *extra_args,
        )

    def test_inventory_writes_committed_jsonl_state_and_excludes_internals(self) -> None:
        with ScriptWorkspace() as workspace:
            workspace.write_text(
                "Projects/My AI Note.md",
                "---\ntags:\n  - ai\n  - missing-tag\n---\n[[Other Note]]\n![[Pasted Image.PNG]]\n",
            )
            workspace.write_binary("Pasted Image.PNG", b"image")
            workspace.write_text(".obsidian/Plugin State.md", "state\n")
            workspace.write_text(".git/ignored", "git internals\n")

            result = self.run_inventory(workspace, ".")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("inventory records: 2", result.stdout)
            inventory = workspace.read_jsonl(workspace.indexes / "vault-inventory.jsonl")
            queue = workspace.read_jsonl(workspace.indexes / "remap-queue.jsonl")
            self.assertEqual(
                [record["source_path"] for record in inventory],
                ["Pasted Image.PNG", "Projects/My AI Note.md"],
            )
            note_record = next(
                record for record in inventory if record["source_path"] == "Projects/My AI Note.md"
            )
            self.assertEqual(note_record["proposed_path"], "01-projects/uncategorized/general/my-ai-note.md")
            self.assertEqual(note_record["approved_tags"], ["ai"])
            self.assertEqual(note_record["unapproved_tag_candidates"], ["missing-tag"])
            self.assertEqual(note_record["wikilinks"], ["Other Note", "Pasted Image.PNG"])
            self.assertEqual(note_record["required_review_scope"], ["placement", "tags", "links", "content"])
            self.assertTrue(note_record["ai_review_required"])
            self.assertTrue(note_record["review_required"])
            self.assertTrue(queue[0]["must_read_file"])
            self.assertEqual(len(queue), 2)
            self.assertFalse(any(".obsidian" in str(record) for record in inventory))
            self.assertFalse(any(".git" in str(record) for record in inventory))

    def test_apply_uses_only_reviewed_decisions_updates_tags_and_rewrites_links(self) -> None:
        with ScriptWorkspace() as workspace:
            vault = workspace.vault
            workspace.write_text(
                "Projects/My AI Note.md",
                "---\ntags:\n  - recipes\n---\n# My AI Note\n\n![[Pasted Image.PNG]]\n",
            )
            workspace.write_text(
                "Areas/Index.md",
                "[[My AI Note]]\n[project](Projects/My AI Note.md)\n![pic](Pasted Image.PNG)\n",
            )
            workspace.write_binary("Pasted Image.PNG", b"image")
            workspace.init_git(branch="remap-fixture")
            workspace.indexes.mkdir()
            decisions = [
                {
                    "source_path": "Projects/My AI Note.md",
                    "target_path": "01-projects/ai/recipes/my-ai-note.md",
                    "reviewed": True,
                    "reviewed_scope": ["placement", "tags", "links", "content"],
                    "approved_tags": ["ai", "recipes"],
                    "proposed_new_tags": ["private-cooking"],
                    "links_to_add": ["02-knowledge/food/recipes/ai-recipe-prompts.md"],
                    "extracted_notes": [
                        {
                            "target_path": "02-knowledge/food/recipes/ai-recipe-prompts.md",
                            "title": "ai recipe prompts",
                            "body": "Prompt patterns for recipe planning.",
                            "approved_tags": ["ai", "recipes"],
                            "proposed_new_tags": ["prompt-cooking"],
                            "links_to_add": ["01-projects/ai/recipes/my-ai-note.md"],
                        }
                    ],
                    "confidence": "high",
                    "reason": "project note about ai recipes",
                    "unresolved_questions": [],
                },
                {
                    "source_path": "Pasted Image.PNG",
                    "target_path": "05-assets/pasted-image.png",
                    "reviewed": True,
                    "reviewed_scope": ["placement", "tags", "links", "content"],
                    "approved_tags": [],
                    "proposed_new_tags": [],
                    "confidence": "high",
                    "reason": "embedded asset",
                    "unresolved_questions": [],
                },
                {
                    "source_path": "Areas/Index.md",
                    "target_path": "02-knowledge/general/topic/index.md",
                    "reviewed": False,
                    "approved_tags": ["ai"],
                    "proposed_new_tags": [],
                    "confidence": "low",
                    "reason": "leave alone",
                    "unresolved_questions": [],
                },
            ]
            (workspace.indexes / "ai-review-decisions.jsonl").write_text(
                "\n".join(json.dumps(decision) for decision in decisions) + "\n",
                encoding="utf-8",
            )
            (workspace.indexes / "tag-proposals.jsonl").write_text(
                json.dumps(
                    {
                        "tag": "existing-topic",
                        "source_paths": ["old-note.md"],
                        "status": "proposed",
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            result = self.run_apply(workspace)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("vault branch: remap-fixture", result.stdout)
            self.assertIn("applied decisions: 2", result.stdout)
            self.assertIn("unresolved references: 0", result.stdout)
            self.assertTrue((vault / "01-projects/ai/recipes/my-ai-note.md").exists())
            self.assertTrue((vault / "05-assets/pasted-image.png").exists())
            self.assertFalse((vault / "Projects/My AI Note.md").exists())
            self.assertTrue((vault / "Areas/Index.md").exists())
            moved_note = (vault / "01-projects/ai/recipes/my-ai-note.md").read_text(encoding="utf-8")
            self.assertIn("  - ai\n  - recipes\n", moved_note)
            self.assertIn("[[02-knowledge/food/recipes/ai-recipe-prompts]]", moved_note)
            extracted_note = (
                vault / "02-knowledge" / "food" / "recipes" / "ai-recipe-prompts.md"
            ).read_text(encoding="utf-8")
            self.assertIn("# ai recipe prompts", extracted_note)
            self.assertIn("source: [[01-projects/ai/recipes/my-ai-note]]", extracted_note)
            self.assertIn("Prompt patterns for recipe planning.", extracted_note)
            index_text = (vault / "Areas/Index.md").read_text(encoding="utf-8")
            self.assertIn("[[01-projects/ai/recipes/my-ai-note|My AI Note]]", index_text)
            self.assertIn("[project](01-projects/ai/recipes/my-ai-note.md)", index_text)
            self.assertIn("![pic](05-assets/pasted-image.png)", index_text)
            tag_proposals = workspace.read_jsonl(workspace.indexes / "tag-proposals.jsonl")
            self.assertEqual(
                [record["tag"] for record in tag_proposals],
                ["existing-topic", "private-cooking", "prompt-cooking"],
            )

    def test_apply_blocks_collisions_outside_targets_and_unresolved_questions(self) -> None:
        with ScriptWorkspace() as workspace:
            vault = workspace.vault
            workspace.write_text("A.md", "a\n")
            workspace.write_text("B.md", "b\n")
            workspace.init_git(branch="remap-fixture")
            workspace.indexes.mkdir()
            decisions = [
                {
                    "source_path": "A.md",
                    "target_path": "02-knowledge/general/topic/same.md",
                    "reviewed": True,
                    "reviewed_scope": ["placement", "tags", "links", "content"],
                    "approved_tags": [],
                    "proposed_new_tags": [],
                    "unresolved_questions": [],
                },
                {
                    "source_path": "B.md",
                    "target_path": "02-knowledge/general/topic/same.md",
                    "reviewed": True,
                    "reviewed_scope": ["placement", "tags", "links", "content"],
                    "approved_tags": [],
                    "proposed_new_tags": [],
                    "unresolved_questions": [],
                },
            ]
            (workspace.indexes / "ai-review-decisions.jsonl").write_text(
                "\n".join(json.dumps(decision) for decision in decisions) + "\n",
                encoding="utf-8",
            )

            result = self.run_apply(workspace)

            self.assertEqual(result.returncode, 2)
            self.assertIn("target collision", result.stderr)
            self.assertTrue((vault / "A.md").exists())
            self.assertTrue((vault / "B.md").exists())

            decisions[1]["target_path"] = "../outside.md"
            (workspace.indexes / "ai-review-decisions.jsonl").write_text(
                "\n".join(json.dumps(decision) for decision in decisions) + "\n",
                encoding="utf-8",
            )
            result = self.run_apply(workspace)
            self.assertEqual(result.returncode, 2)
            self.assertIn("target outside approved folders", result.stderr)

            decisions[1]["target_path"] = "02-knowledge/topic.md"
            (workspace.indexes / "ai-review-decisions.jsonl").write_text(
                "\n".join(json.dumps(decision) for decision in decisions) + "\n",
                encoding="utf-8",
            )
            result = self.run_apply(workspace)
            self.assertEqual(result.returncode, 2)
            self.assertIn("knowledge notes must use 02-knowledge/<main>/<sub>/<note>.md", result.stderr)

            decisions[1]["target_path"] = "01-projects/topic.md"
            (workspace.indexes / "ai-review-decisions.jsonl").write_text(
                "\n".join(json.dumps(decision) for decision in decisions) + "\n",
                encoding="utf-8",
            )
            result = self.run_apply(workspace)
            self.assertEqual(result.returncode, 2)
            self.assertIn("project notes must use 01-projects/<main>/<sub>/<note>.md", result.stderr)

            decisions[1]["target_path"] = "04-people/family.md"
            (workspace.indexes / "ai-review-decisions.jsonl").write_text(
                "\n".join(json.dumps(decision) for decision in decisions) + "\n",
                encoding="utf-8",
            )
            result = self.run_apply(workspace)
            self.assertEqual(result.returncode, 2)
            self.assertIn("people notes must use 04-people/<main>/<sub>/<note>.md", result.stderr)

            decisions[1]["target_path"] = "02-knowledge/general/topic/b.md"
            decisions[1]["unresolved_questions"] = ["which folder?"]
            (workspace.indexes / "ai-review-decisions.jsonl").write_text(
                "\n".join(json.dumps(decision) for decision in decisions) + "\n",
                encoding="utf-8",
            )
            result = self.run_apply(workspace)
            self.assertEqual(result.returncode, 2)
            self.assertIn("unresolved questions", result.stderr)

    def test_apply_refuses_non_git_vault(self) -> None:
        with ScriptWorkspace() as workspace:
            workspace.write_text("A.md", "a\n")
            workspace.indexes.mkdir()
            (workspace.indexes / "ai-review-decisions.jsonl").write_text(
                json.dumps(
                    {
                        "source_path": "A.md",
                        "target_path": "02-knowledge/general/topic/a.md",
                        "reviewed": True,
                        "reviewed_scope": ["placement", "tags", "links", "content"],
                        "approved_tags": [],
                        "proposed_new_tags": [],
                        "unresolved_questions": [],
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            result = self.run_apply(workspace)

            self.assertEqual(result.returncode, 2)
            self.assertIn("vault is not a git repository", result.stderr)


if __name__ == "__main__":
    unittest.main()
