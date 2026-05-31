#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INVENTORY_SCRIPT = ROOT / "scripts" / "build-vault-inventory.py"
APPLY_SCRIPT = ROOT / "scripts" / "apply-vault-remap.py"
APPROVED_TAGS = ROOT / "taxonomy" / "approved-tags.md"


class VaultRemapTest(unittest.TestCase):
    def write_text(self, vault: Path, relative_path: str, text: str) -> Path:
        path = vault / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def write_binary(self, vault: Path, relative_path: str, content: bytes) -> Path:
        path = vault / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    def run_inventory(
        self, vault: Path, index_dir: Path, *paths: str
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                "python3",
                str(INVENTORY_SCRIPT),
                "--vault",
                str(vault),
                "--indexes",
                str(index_dir),
                "--tags",
                str(APPROVED_TAGS),
                *paths,
            ],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def run_apply(
        self, vault: Path, index_dir: Path, *extra_args: str
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                "python3",
                str(APPLY_SCRIPT),
                "--vault",
                str(vault),
                "--indexes",
                str(index_dir),
                "--tags",
                str(APPROVED_TAGS),
                *extra_args,
            ],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def read_jsonl(self, path: Path) -> list[dict[str, object]]:
        return [
            json.loads(line)
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def init_git_vault(self, vault: Path) -> None:
        subprocess.run(["git", "-C", str(vault), "init", "-q"], check=True)
        subprocess.run(["git", "-C", str(vault), "checkout", "-qb", "remap-fixture"], check=True)
        subprocess.run(["git", "-C", str(vault), "add", "."], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(vault),
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

    def test_inventory_writes_committed_jsonl_state_and_excludes_internals(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            vault = root / "vault"
            indexes = root / "indexes"
            vault.mkdir()
            self.write_text(
                vault,
                "Projects/My AI Note.md",
                "---\ntags:\n  - ai\n  - missing-tag\n---\n[[Other Note]]\n![[Pasted Image.PNG]]\n",
            )
            self.write_binary(vault, "Pasted Image.PNG", b"image")
            self.write_text(vault, ".obsidian/Plugin State.md", "state\n")
            self.write_text(vault, ".git/ignored", "git internals\n")

            result = self.run_inventory(vault, indexes, ".")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("inventory records: 2", result.stdout)
            inventory = self.read_jsonl(indexes / "vault-inventory.jsonl")
            queue = self.read_jsonl(indexes / "remap-queue.jsonl")
            self.assertEqual(
                [record["source_path"] for record in inventory],
                ["Pasted Image.PNG", "Projects/My AI Note.md"],
            )
            note_record = next(
                record for record in inventory if record["source_path"] == "Projects/My AI Note.md"
            )
            self.assertEqual(note_record["proposed_path"], "01-projects/my-ai-note.md")
            self.assertEqual(note_record["approved_tags"], ["ai"])
            self.assertEqual(note_record["unapproved_tag_candidates"], ["missing-tag"])
            self.assertEqual(note_record["wikilinks"], ["Other Note", "Pasted Image.PNG"])
            self.assertTrue(note_record["review_required"])
            self.assertEqual(len(queue), 2)
            self.assertFalse(any(".obsidian" in str(record) for record in inventory))
            self.assertFalse(any(".git" in str(record) for record in inventory))

    def test_apply_uses_only_reviewed_decisions_updates_tags_and_rewrites_links(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            vault = root / "vault"
            indexes = root / "indexes"
            vault.mkdir()
            self.write_text(
                vault,
                "Projects/My AI Note.md",
                "---\ntags:\n  - recipes\n---\n# My AI Note\n\n![[Pasted Image.PNG]]\n",
            )
            self.write_text(
                vault,
                "Areas/Index.md",
                "[[My AI Note]]\n[project](Projects/My AI Note.md)\n![pic](Pasted Image.PNG)\n",
            )
            self.write_binary(vault, "Pasted Image.PNG", b"image")
            self.init_git_vault(vault)
            indexes.mkdir()
            decisions = [
                {
                    "source_path": "Projects/My AI Note.md",
                    "target_path": "01-projects/my-ai-note.md",
                    "reviewed": True,
                    "approved_tags": ["ai", "recipes"],
                    "proposed_new_tags": ["private-cooking"],
                    "confidence": "high",
                    "reason": "project note about ai recipes",
                    "unresolved_questions": [],
                },
                {
                    "source_path": "Pasted Image.PNG",
                    "target_path": "06-assets/pasted-image.png",
                    "reviewed": True,
                    "approved_tags": [],
                    "proposed_new_tags": [],
                    "confidence": "high",
                    "reason": "embedded asset",
                    "unresolved_questions": [],
                },
                {
                    "source_path": "Areas/Index.md",
                    "target_path": "02-areas/index.md",
                    "reviewed": False,
                    "approved_tags": ["ai"],
                    "proposed_new_tags": [],
                    "confidence": "low",
                    "reason": "leave alone",
                    "unresolved_questions": [],
                },
            ]
            (indexes / "ai-review-decisions.jsonl").write_text(
                "\n".join(json.dumps(decision) for decision in decisions) + "\n",
                encoding="utf-8",
            )
            (indexes / "tag-proposals.jsonl").write_text(
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

            result = self.run_apply(vault, indexes)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("vault branch: remap-fixture", result.stdout)
            self.assertIn("applied decisions: 2", result.stdout)
            self.assertIn("unresolved references: 0", result.stdout)
            self.assertTrue((vault / "01-projects/my-ai-note.md").exists())
            self.assertTrue((vault / "06-assets/pasted-image.png").exists())
            self.assertFalse((vault / "Projects/My AI Note.md").exists())
            self.assertTrue((vault / "Areas/Index.md").exists())
            moved_note = (vault / "01-projects/my-ai-note.md").read_text(encoding="utf-8")
            self.assertIn("  - ai\n  - recipes\n", moved_note)
            index_text = (vault / "Areas/Index.md").read_text(encoding="utf-8")
            self.assertIn("[[01-projects/my-ai-note|My AI Note]]", index_text)
            self.assertIn("[project](01-projects/my-ai-note.md)", index_text)
            self.assertIn("![pic](06-assets/pasted-image.png)", index_text)
            tag_proposals = self.read_jsonl(indexes / "tag-proposals.jsonl")
            self.assertEqual([record["tag"] for record in tag_proposals], ["existing-topic", "private-cooking"])

    def test_apply_blocks_collisions_outside_targets_and_unresolved_questions(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            vault = root / "vault"
            indexes = root / "indexes"
            vault.mkdir()
            self.write_text(vault, "A.md", "a\n")
            self.write_text(vault, "B.md", "b\n")
            self.init_git_vault(vault)
            indexes.mkdir()
            decisions = [
                {
                    "source_path": "A.md",
                    "target_path": "02-areas/general/topic/same.md",
                    "reviewed": True,
                    "approved_tags": [],
                    "proposed_new_tags": [],
                    "unresolved_questions": [],
                },
                {
                    "source_path": "B.md",
                    "target_path": "02-areas/general/topic/same.md",
                    "reviewed": True,
                    "approved_tags": [],
                    "proposed_new_tags": [],
                    "unresolved_questions": [],
                },
            ]
            (indexes / "ai-review-decisions.jsonl").write_text(
                "\n".join(json.dumps(decision) for decision in decisions) + "\n",
                encoding="utf-8",
            )

            result = self.run_apply(vault, indexes)

            self.assertEqual(result.returncode, 2)
            self.assertIn("target collision", result.stderr)
            self.assertTrue((vault / "A.md").exists())
            self.assertTrue((vault / "B.md").exists())

            decisions[1]["target_path"] = "../outside.md"
            (indexes / "ai-review-decisions.jsonl").write_text(
                "\n".join(json.dumps(decision) for decision in decisions) + "\n",
                encoding="utf-8",
            )
            result = self.run_apply(vault, indexes)
            self.assertEqual(result.returncode, 2)
            self.assertIn("target outside approved folders", result.stderr)

            decisions[1]["target_path"] = "02-areas/topic.md"
            (indexes / "ai-review-decisions.jsonl").write_text(
                "\n".join(json.dumps(decision) for decision in decisions) + "\n",
                encoding="utf-8",
            )
            result = self.run_apply(vault, indexes)
            self.assertEqual(result.returncode, 2)
            self.assertIn("area notes must use 02-areas/<area>/<sub-area>/<note>.md", result.stderr)

            decisions[1]["target_path"] = "02-areas/general/topic/b.md"
            decisions[1]["unresolved_questions"] = ["which folder?"]
            (indexes / "ai-review-decisions.jsonl").write_text(
                "\n".join(json.dumps(decision) for decision in decisions) + "\n",
                encoding="utf-8",
            )
            result = self.run_apply(vault, indexes)
            self.assertEqual(result.returncode, 2)
            self.assertIn("unresolved questions", result.stderr)

    def test_apply_refuses_non_git_vault(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            vault = root / "vault"
            indexes = root / "indexes"
            vault.mkdir()
            self.write_text(vault, "A.md", "a\n")
            indexes.mkdir()
            (indexes / "ai-review-decisions.jsonl").write_text(
                json.dumps(
                    {
                        "source_path": "A.md",
                        "target_path": "02-areas/general/topic/a.md",
                        "reviewed": True,
                        "approved_tags": [],
                        "proposed_new_tags": [],
                        "unresolved_questions": [],
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            result = self.run_apply(vault, indexes)

            self.assertEqual(result.returncode, 2)
            self.assertIn("vault is not a git repository", result.stderr)


if __name__ == "__main__":
    unittest.main()
