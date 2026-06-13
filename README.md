# dreamers-note

AI framework for organizing the Obsidian vault at `/home/cjstorrs/obsidian/cyborg`.

This repository owns the AI behavior. Project skills are sourced from `.codex/skills` and installed into the Obsidian vault at `.codex/skills`. The vault remains the note store plus project-local note skills.

## Operating Model

- Use Git branches for AI-made vault changes.
- Review with `git diff` and pull requests before merge.
- Prefer chat-first proposals. File output is optional and stays in this repository unless requested.
- Treat skills as phase-gated runs that call agents at specific steps.
- Treat agents as narrow role contracts, not full workflows.
- Keep normal notes light: optional approved topical tags only.
- Use lowercase kebab-case for new files.
- Use scripts where they make a skill safer or repeatable.
- Store project, knowledge, and people notes as `<root>/<main>/<sub>/<note>.md`.
- Store family notes under `04-people/family/<sub>/`, not under knowledge.

## Target Vault

Configured in [config/vault.json](config/vault.json):

```text
/home/cjstorrs/obsidian/cyborg
```

Skills and helper scripts read this config by default. Pass `--vault` only when intentionally overriding the configured vault for tests or one-off runs.

## Package Foundation

This repository includes a private Node/TypeScript package foundation under `src/`. It loads the vault path from `config/vault.json`, convention policy from `config/conventions.json`, and runtime settings from `config/runtime.json`.

Install local dependencies from the committed lockfile when `node_modules/` is absent:

```bash
npm ci
```

Build the CLI before running it directly:

```bash
npm run build
node dist/cli.js doctor
node dist/cli.js status
```

Use `node dist/cli.js doctor --init-runtime` only when you want to create the local `.dreamers-note-runtime/` directory. That runtime directory, `dist/`, and `node_modules/` are local rebuildable artifacts and stay ignored by Git.

The local notes index uses `better-sqlite3` v11 on Node 18 for SQLite storage, FTS5 lexical search, prepared statements, and transaction-scoped fixture setup. Runtime index state is rebuildable from vault files plus repository config and stays under the ignored runtime directory. The package now exposes a rebuildable index/search core for full vault rebuilds and refreshes, Obsidian-aware Markdown parsing, asset metadata indexing, and explainable lexical search results with freshness state and `why_matched` signals. Scoped refreshes via `selectedPaths` are intentionally rejected until they can be implemented safely.

The public package entry points are `rebuildVaultIndex`, `refreshVaultIndex`, `searchVaultIndex`, and `evaluateLexicalRetrieval`. Search results return bounded snippets plus freshness and `why_matched` explanations, Markdown note links resolve from the source note for standard Markdown paths, and inbound asset matches are keyed by resolved vault-relative asset paths so duplicate filenames do not collide.

## MCP Server

The package now includes a local `stdio` MCP server:

```bash
npm run build
node dist/cli.js mcp
```

Start the server with `--write-enabled` only when you intentionally need proposal queue or apply actions:

```bash
node dist/cli.js mcp --write-enabled
```

Use it from Codex for vault retrieval instead of ad hoc file scans. The MCP surface exposes:

- tools: `server_status`, `index_refresh`, `search_hybrid`, `read_note`, `context_pack`, `retrieval_feedback`, `proposal_list`, `proposal_read`, `proposal_create`, `proposal_reject`, `proposal_authorize`, `proposal_apply`
- resources: approved tags, conventions, Codex guidance, index status, recent runtime reports
- prompts: retrieval, add, import, triage, review

`search_hybrid`, `read_note`, and `context_pack` return bounded cited evidence only. `retrieval_feedback` stores query/path/reason metadata without note bodies. Write-capable proposal tools refuse by default unless the server started with `--write-enabled`, and `proposal_apply` still requires a current one-use authorization. `stdout` is reserved for MCP protocol traffic; logs and warnings stay on `stderr`.

## Proposal Queue Safety

Vault writes now run through runtime proposal records instead of direct note mutation. `proposal_create` stores reviewable metadata, bounded evidence, target hashes, lineage, and either a new-file body or an existing-file splice edit spec without changing vault files. `proposal_list` returns metadata only, while `proposal_read` adds current validation and bounded diff previews.

`proposal_authorize` issues a one-use token bound to the proposal revision, diff hash, target hashes, branch, taxonomy hash, and exclusion-config hash. `proposal_apply` is the only vault-mutating MCP tool in v1. It acquires a single-writer lock, validates staleness and path safety immediately before writing, rolls back on partial failure, refreshes the index for touched files, and returns changed paths plus Git review guidance.

Rejected, applied, and expired proposals redact note-derived content from runtime state. Excluded paths such as `07-system/secrets` remain out of proposal evidence, diff previews, logs, and apply targets.

## Retrieval Hardening

Hybrid retrieval remains SQLite-first. The package now supports optional local embeddings, semantic ranking blended with exact title/path/heading/tag/backlink signals, alias evidence, simple recency boosts, and retrieval feedback records stored in runtime state.

Enable the builtin local embedding provider in `config/runtime.json`:

```json
{
  "data_dir": ".dreamers-note-runtime",
  "private_globs": ["07-system/secrets/**"],
  "embeddings": {
    "enabled": true,
    "provider": "builtin",
    "model": "dreamers-local-semantic",
    "model_version": "2026-06-13",
    "dimensions": 48
  }
}
```

If embeddings are disabled, unavailable, or stale after a model or policy change, lexical retrieval still works and the MCP responses report embedding state explicitly. Excluded paths remain out of chunk vectors, hybrid results, feedback records, and runtime logs.

## Validate

```bash
bash scripts/validate-framework.sh
bash tests/test-framework.sh
npm run typecheck
npm test
```

## Install Global Skill Launchers

Project-specific note skills are sourced from this repository under `.codex/skills/` and installed into the configured vault under `.codex/skills/`. Global launchers live in `global-skills/` and delegate back to project-owned skills such as daily capture and direct note import.

```bash
./install.sh
```

Use `./install.sh --dry-run` to see what would be installed. Project skills are copied into the configured vault under `.codex/skills/`; global launchers are installed into `$CODEX_HOME/skills` and become available in new Codex sessions.

`.codex/skills/` is the project convention for local note-system skills. Installed global launchers remain the reliable `$` entry points outside this project, including `$dreamers-note` for command text and `$dreamers-note-import` for files such as `~/Desktop/linux.md`.

## Daily Triage Dry Run

```bash
python3 scripts/propose-daily-triage.py
```

With no note arguments, the helper proposes triage for every Markdown daily note under `00-inbox/daily-notes`. Pass paths only to narrow scope. Use `--archive` after approved extraction changes are visible in Git status or diff to check archive readiness; the skill archives processed notes as close-out.

## AI-Assisted Vault Remap

Build committed project indexes before reviewing a full remap:

```bash
python3 scripts/build-vault-inventory.py --indexes indexes .
```

After AI review writes approved records to `indexes/ai-review-decisions.jsonl`, apply only on a vault Git branch:

```bash
python3 scripts/apply-vault-remap.py --indexes indexes
```

Review both repositories with Git before merge: `dreamers-note` owns indexes and decisions, while `cyborg` owns note moves, tag edits, and link rewrites.
