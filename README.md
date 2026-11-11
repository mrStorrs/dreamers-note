# dreamers-note

Five skills for working with an Obsidian vault using ordinary Markdown files, file tools, and Git.

- `note-add` places additions, captures, decisions, and daily entries.
- `note-import` files a selected text file while preserving its source.
- `note-daily-triage` extracts useful material and archives completed daily notes.
- `note-review` reviews one note without editing it.
- `note-vault-refactor` refactors a selected scope on a Git branch.

The skills decide what to read and change. They show proposed edits when approval is required, edit files directly, and verify the result with Git. There is no application CLI, database, server, build step, or dependency install.

## Install

The installer script requires Node 18 or newer and uses only its standard library:

```bash
./install.sh
```

On Windows:

```powershell
.\bootstrap.ps1
```

Add `--dry-run` (PowerShell: `-DryRun`) to preview installation. With no saved notes directory, installation sets up the client skills; the first skill run asks where your notes directory is stored, verifies it, and saves `vault_path` in the ignored `config/vault.local.json`. All five skills read this one settings file on later runs.

To set the directory during installation, use `./bootstrap.sh /absolute/path/to/your/vault`, PowerShell's `-VaultPath`, or `VAULT_PATH`. This saves the selected path in the same settings file. You can also edit it using [the example](config/vault.example.json). Ask a note skill to change the saved directory when you move your notes; it will validate and remember the new path.

The installer copies the canonical [.codex/skills](.codex/skills) directories into `$CODEX_HOME/skills` and `$COPILOT_HOME/skills`, plus the vault's `.codex/skills` when a notes directory is configured. Run it again after first-run setup if you also want vault-local copies. Client homes default to `.codex` and `.copilot` in the user's home directory. It updates only manifest-managed skills and stops on unmanaged name collisions. A local `.dreamers-note-install.json` records only the framework path; notes-directory settings are shared across clients and survive reinstalls.

Restart Codex or Copilot after installation. Keep this checkout available: installed skills use its [workflow policy](docs/note-workflow-policy.md), [approved tags](taxonomy/approved-tags.md), and index script.

## Markdown index

The vault's `note-index.md` is a sorted list of links to Markdown notes. Skills search it for paths, read the selected notes, and use focused content searches when needed. Notes remain the source of truth.

Regenerate it after adding, moving, or removing notes:

```bash
node scripts/build-note-index.mjs /absolute/path/to/your/vault
```

This script only lists paths and replaces its own generated index. It never reads note bodies, follows symlinks, or enters hidden directories or `07-system/secrets`. It refuses to overwrite a handwritten `note-index.md`. Existing folder homepages and human-owned sections remain ordinary notes maintained by the skills.

## Workflow

For add, import, and triage, the skill shows concrete edits and gets approval before writing unless those exact edits were already approved. Review stays read-only. A scoped refactor request authorizes edits within that scope. Git status and diffs reveal the changes; there are no stored proposals, change IDs, or database transactions.

The former CLI and SQLite runtime are retired. Their ignored build and runtime directories are unused. Existing pending records are not executed or migrated; retain any old runtime backup you still need.

## Development

```bash
bash tests/test-framework.sh
```

The checks use temporary vaults and client homes. They cover index generation and exclusions, source preservation, installer dry runs, managed replacement, and collision handling. No package manager is needed.
