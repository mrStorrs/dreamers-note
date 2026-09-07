# dreamers-note

`dreamers-note` is a local, skill-led workflow for an Obsidian vault. Five canonical `note-*` skills make placement and review judgments; one Node/TypeScript CLI provides bounded retrieval, an ignored lexical/graph cache, and the sole safe vault writer.

## Canonical skills

- `note-add` — place additions, captures, decisions, and explicit daily-note entries.
- `note-import` — import a Markdown/text source without changing the source.
- `note-daily-triage` — extract durable daily-note material and archive it in one approved change.
- `note-review` — review exactly one note, read-only by default.
- `note-vault-refactor` — run an explicit branch-scoped batch refactor with read-only review workers and PR handoff.

The checked-in `.codex/skills/` tree is the only source. The installer copies those exact directories to the configured vault, `$CODEX_HOME/skills`, and `$COPILOT_HOME/skills`; no wrappers or launchers are maintained.

## Install

Requires Node 18 or newer. For a direct install, copy [config/vault.example.json](config/vault.example.json) to the ignored `config/vault.local.json` and set its `vault_path`, or pass `VAULT_PATH` for an isolated install. Then build and install:

```bash
npm ci
npm run build
./install.sh
```

`./bootstrap.sh /absolute/path/to/vault` performs the same setup. Use `--dry-run` on either bootstrap or installer to preview changes.

On Windows PowerShell, use the native bootstrap:

```powershell
.\bootstrap.ps1 -VaultPath 'C:\absolute\path\to\your\vault'
```

Add `-DryRun` to preview the PowerShell bootstrap.

The installer preflights all three destinations before mutation, refuses an unmanaged canonical-name collision, removes only names listed in each destination’s `.dreamers-note-managed-skills`, and preserves other skills. It writes a local ignored `.dreamers-note-install.json` beside that manifest so installed skills can locate the framework and built CLI. If an existing Copilot `mcp-config.json` has a `dreamers-note` server entry, installation removes only that entry; missing configs are not created and malformed JSON stops the install before changes.

Restart Codex or Copilot after installation so the new skills are discovered. This is a clean break: old skill names and the prior server integration are not aliases. Pending records from the pre-version-7 cache are not migrated; resolve them before upgrading if they matter.

## CLI

Every command emits one newline-terminated JSON document. `--root <framework-root>` can appear with any command.

```text
node dist/cli.js doctor
node dist/cli.js index refresh
node dist/cli.js context search --query <text> [--limit <n>]
node dist/cli.js context read --path <vault-relative-path> [--heading <text>] [--max-chars <n>]
node dist/cli.js context source --path <absolute-markdown-or-text-path> [--offset <n>] [--max-chars <n>]
node dist/cli.js context related (--path <vault-relative-path> | --query <text>) [--limit <n>]
node dist/cli.js review graph|health|duplicates [--limit <n>]
node dist/cli.js change create --input <json-file|->
node dist/cli.js change show --id <change-id> [--path <vault-relative-path>] [--offset <n>] [--max-chars <n>]
node dist/cli.js change reject --id <change-id>
node dist/cli.js change list
node dist/cli.js change apply --id <change-id> --revision <sha256>
node dist/cli.js daily triage [<vault-relative-daily-note> ...] [--archive-check] [--cursor <path>] [--limit <n>]
node dist/cli.js vault inventory <vault-relative-path> ... [--cursor <path>] [--limit <n>]
node dist/cli.js vault normalize <decision-jsonl>
node dist/cli.js vault directory-index [<vault-relative-path> ...]
```

Read, review, and maintenance commands may refresh only `.dreamers-note-runtime/`, which is ignored. They never alter vault files. `change apply` is the only command that writes vault bytes.

## Safe change flow

Create complete resulting bodies and explicit moves in one JSON document:

```json
{
  "summary": "Add the reviewed decision",
  "writes": [{"path": "01-projects/example/notes/decision.md", "body": "Resulting note body"}],
  "moves": []
}
```

Run `change create`, inspect `change show`, obtain the appropriate approval, then apply exactly the returned id and SHA-256 revision. The writer checks paths, exclusions, hashes, Git state, and collisions under one lock; it rolls back on failure and refreshes affected cache entries after success. Inspect the vault Git diff before treating a change as complete.

The shared [note workflow policy](docs/note-workflow-policy.md) contains the placement, tag, link, citation, exclusion, approval, and Git rules used by every skill. The approved taxonomy is in [taxonomy/approved-tags.md](taxonomy/approved-tags.md).

## Runtime and privacy

The runtime database is rebuildable from vault files and configuration. Schema version 7 stores lexical FTS, Markdown/graph structure, and change records only. Excluded paths such as `07-system/secrets/**` never appear in CLI results or cache data. Search ranks title, path, heading, approved tags, lexical matches, aliases, backlinks, and recency; no optional vector provider is required.

## Validation

```bash
npm run typecheck
npm test
bash scripts/validate-framework.sh
bash tests/test-framework.sh
```

The framework checks use fixture vaults and do not write a user vault. Run `bash scripts/validate-vault-bootstrap.sh` separately only when checking an initialized vault whose support files are expected to match this repository's taxonomy.

See [AGENTS.md](AGENTS.md) for project-agent guidance, [docs/conventions.md](docs/conventions.md) for vault conventions, and [docs/git-review-workflow.md](docs/git-review-workflow.md) for review rules.
