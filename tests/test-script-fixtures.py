#!/usr/bin/env python3
from __future__ import annotations

import json
import unittest

try:
    from helpers.script_fixtures import ROOT, ScriptWorkspace, load_script_module
except ModuleNotFoundError:
    from tests.helpers.script_fixtures import ROOT, ScriptWorkspace, load_script_module


class ScriptFixtureTests(unittest.TestCase):
    def test_workspace_owns_script_loading_git_and_subprocess_helpers(self) -> None:
        module = load_script_module(
            "propose_daily_triage_fixture_contract",
            ROOT / "scripts" / "propose-daily-triage.py",
        )
        self.assertEqual(module.slugify("Recipe AI Planner"), "recipe-ai-planner")

        with ScriptWorkspace() as workspace:
            note = workspace.write_text(
                "00-inbox/daily-notes/2026-06-15.md",
                "# 2026-06-15\n\n## project: fixture helper\nShared setup works. #ai\n",
            )
            workspace.init_git()
            workspace.write_jsonl("indexes/records.jsonl", [{"source_path": note.name}])

            records = workspace.read_jsonl("indexes/records.jsonl")
            self.assertEqual(records, [{"source_path": "2026-06-15.md"}])

            result = workspace.run_python(
                ROOT / "scripts" / "propose-daily-triage.py",
                "--vault",
                workspace.vault,
                "--tags",
                ROOT / "taxonomy" / "approved-tags.md",
                check=True,
            )

        self.assertIn("fixture helper", result.stdout)
        self.assertEqual(json.loads(json.dumps(records)), records)

    def test_init_git_skips_empty_baseline_commit(self) -> None:
        with ScriptWorkspace() as workspace:
            workspace.init_git()
            self.assertEqual(workspace.git(["status", "--short"], check=True).stdout, "")

    def test_remap_common_jsonl_boundary_validates_objects_and_fields(self) -> None:
        common = load_script_module(
            "vault_remap_common_fixture_contract",
            ROOT / "scripts" / "vault_remap_common.py",
        )

        with ScriptWorkspace() as workspace:
            path = workspace.write_jsonl(
                "indexes/decisions.jsonl",
                [{"source_path": "A.md", "target_path": "02-knowledge/general/topic/a.md"}],
            )
            records = common.read_jsonl_records(
                path,
                required_fields=("source_path", "target_path"),
                record_name="decision",
            )
            self.assertEqual(records[0]["source_path"], "A.md")

            invalid = workspace.write_text("indexes/invalid.jsonl", "[]\n", base=workspace.root)
            with self.assertRaisesRegex(ValueError, "expected object"):
                common.read_jsonl_records(invalid, record_name="decision")

            malformed = workspace.write_text("indexes/malformed.jsonl", '{"source_path":\n', base=workspace.root)
            with self.assertRaisesRegex(ValueError, "line 1"):
                common.read_jsonl_records(malformed, record_name="decision")

            missing = workspace.write_jsonl("indexes/missing.jsonl", [{"source_path": "A.md"}])
            with self.assertRaisesRegex(ValueError, "missing target_path"):
                common.read_jsonl_records(
                    missing,
                    required_fields=("source_path", "target_path"),
                    record_name="decision",
                )


if __name__ == "__main__":
    unittest.main()
