---
name: "note-import"
description: "Import a user-selected Markdown or text file into a configured vault while preserving the source and requiring approval for the exact vault change."
---

# note-import

Use this skill when the user gives an existing Markdown or text file to place in the vault. Preserve the source file unless the user separately and explicitly asks to delete it.

Resolve `framework_root` and `cli_path` from the checked-in repository or the installed-skill locator, then read the shared workflow policy at `<framework_root>/docs/note-workflow-policy.md`.

1. Require an explicit absolute source path. Inspect it with `context source --path <absolute-path>`; refuse private, binary, symlinked, oversized, or unreadable sources.
2. Search the vault with `context search --query` and read only candidate notes needed to decide durable ownership, collision risk, links, and approved tags.
3. Choose an existing owner only with clear subject ownership; otherwise choose a policy-compliant destination and a lowercase kebab-case filename. Keep source provenance in the body when useful.
4. Create a complete-body vault change with `change create --input -`, then inspect it with `change show --id`.
5. Report source path, source-preservation status, destination, cited context, tags/links, change id, revision, and diff. Stop for explicit approval.
6. Only after approval of that exact id/revision, run `change apply --id <id> --revision <sha256>`, then report the vault Git diff and confirm the external source remains unchanged.

Never delete, move, or rewrite the external source as part of the vault change. Do not inspect excluded paths, invent tags, or use a broad vault scan as substitute for bounded CLI evidence.
