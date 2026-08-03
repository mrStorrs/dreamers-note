# dreamers-note

AI framework for organizing a local Obsidian vault.

This is MIT-licensed open-source source code. npm publication remains disabled; follow [the public release procedure](docs/public-release.md) before changing repository visibility.

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

Copy [config/vault.example.json](config/vault.example.json) to the ignored `config/vault.local.json` and set an absolute vault path:

```text
/absolute/path/to/your/vault
```

Skills and helper scripts read the local config by default. Pass `VAULT_PATH` or `--vault` only when intentionally overriding it for tests or one-off runs. Never commit `config/vault.local.json`.

## Package Foundation

This repository includes a private Node/TypeScript package foundation under `src/`. It loads the vault path from ignored `config/vault.local.json`, convention policy from `config/conventions.json`, and runtime settings from `config/runtime.json`.

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

## Directory Homepages

Every classified subfolder beneath `01-projects`, `02-knowledge`, and `04-people` has a homepage named `_<folder-name>.md`. The page begins with a generated summary of the folder's subject matter, never boilerplate explaining that the file is an index or homepage. A human-owned `## Notes` section follows, then generated `## Subfolders` and `## Pages` sections when that folder has children or direct pages. The directory index exception is recursive; ordinary project, knowledge, and people pages still use the normal `main/sub` path shape.

Use `node dist/cli.js migrate-directory-indexes --dry-run` to inspect a clean vault branch before bulk migration, then `--write` to apply the reviewed change set. The migration command and ongoing MCP maintenance share the same TypeScript renderer. During ongoing MCP work, a classified note proposal automatically includes every byte-changing generated homepage target before authorization while preserving `## Notes`. Changes that do not affect the generated lead or folder membership do not create homepage noise, so ordinary body edits do not create homepage churn.

Manual Obsidian edits are never rewritten by a read-only check. `health_report` and `review_queue` surface missing, stale, or malformed directory homepages; pass the reported homepage paths to `proposal_create_directory_index_refresh`, inspect them with `proposal_read`, then use the normal `proposal_authorize` and `proposal_apply` flow.

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

- tools: `server_status`, `workflow_ready`, `index_refresh`, `search_hybrid`, `read_note`, `workflow_policy`, `context_pack`, `graph_diagnostics`, `graph_context_pack`, `health_report`, `duplicate_candidates`, `resurfacing_report`, `review_queue`, `retrieval_feedback`, `diagnostic_feedback`, `proposal_list`, `proposal_read`, `proposal_create_note`, `proposal_create`, `proposal_create_directory_index_refresh`, `proposal_reject`, `proposal_authorize`, `proposal_apply`
- resources: approved tags, conventions, Codex guidance, workflow-policy documents, index status, recent runtime reports
- prompts: retrieval, add, capture, import, triage, review

`search_hybrid`, `read_note`, `workflow_policy`, `context_pack`, `graph_context_pack`, `graph_diagnostics`, `health_report`, `duplicate_candidates`, `resurfacing_report`, and `review_queue` return bounded cited evidence only. `retrieval_feedback` and `diagnostic_feedback` store lightweight runtime metadata without note bodies. Write-capable proposal tools refuse by default unless the server started with `--write-enabled`, and `proposal_apply` still requires a current one-use authorization. `stdout` is reserved for MCP protocol traffic; logs and warnings stay on `stderr`.

When a session starts cold, call `workflow_ready` first. It initializes the local runtime if needed, refreshes the index when stale or empty, repairs missing embeddings through the normal refresh path, and returns a compact readiness report for retrieval, review, and write workflows.

For normal add, capture, import, and triage flows, call `workflow_policy` first. It returns structured path, tag, retrieval, template, and proposal rules so Codex can stay MCP-native instead of shell-reading repo policy files. Matching MCP resources are also available under `dreamers-note://workflow-policy/<workflow>`.

Generated MCP tool inventory is checked from registry metadata. The Copilot allowlist in [config/copilot-mcp-tools.json](config/copilot-mcp-tools.json) is validated by [scripts/check-copilot-mcp-tools.mjs](scripts/check-copilot-mcp-tools.mjs), so installed clients use the same non-apply tool surface that the MCP registry exposes.

## Graph Health Review

The review surface is runtime-first. `graph_diagnostics` reports link structure, backlinks, embeds, duplicate titles, unresolved links, orphan notes, tag co-occurrence, and over-broad approved tags with vault-relative citations and bounded excerpts. `graph_context_pack` turns a note path or search query into a grouped neighborhood with confidence and suggested use such as cite, link, merge-review, or resurface.

`health_report` flags broken links, empty or overlong notes, stale project notes, directory-homepage drift, unresolved proposals, daily capture backlog, placement debt, and conflicting tags. `duplicate_candidates` stays deterministic and index-derived, using title normalization, path similarity, content fingerprints, tag overlap, and backlink overlap to suggest merge-review, link, keep-both, or ignore without applying anything.

`resurfacing_report` and `review_queue` keep weekly or daily review in runtime state instead of polluting vault notes. `diagnostic_feedback` records dismiss, snooze, pin, or intentional decisions with evidence hashes so repeated findings stay quiet until the underlying evidence changes.

## Proposal Queue Safety

Vault writes now run through runtime proposal records instead of direct note mutation. `proposal_create_note` is the normal note-content entry point for add, capture, import, and extraction drafts; it stores one approval-ready note proposal without exposing raw queue fields such as `targets`, `pathActions`, or blocker arrays. Raw `proposal_create` remains available for archive moves, vault moves, and explicit external delete proposals. `proposal_list` returns metadata only, while `proposal_read` adds current validation and bounded diff previews.

`proposal_authorize` issues a one-use token bound to the proposal revision, diff hash, target hashes, branch, taxonomy hash, and exclusion-config hash. `proposal_apply` is the only vault-mutating MCP tool in v1. It acquires a single-writer lock, validates staleness and path safety immediately before writing, rolls back on partial failure, refreshes the index for touched files, and returns changed paths plus Git review guidance.

Rejected, applied, and expired proposals redact note-derived content from runtime state. Excluded secret paths remain out of proposal evidence, diff previews, logs, and apply targets.

## Workflow Guidance

Canonical workflow behavior lives in [AGENTS.md](AGENTS.md), the project skills under [.codex/skills/](.codex/skills/), and the MCP `workflow_policy` tool plus `dreamers-note://workflow-policy/<workflow>` resources. README intentionally links to those sources instead of restating add, capture, import, or triage rules.

Global launchers such as `$dreamers-note`, `$dreamers-note-capture`, `$dreamers-note-import`, `$dreamers-note-review`, and `$dreamers-note-refactor` are generated from [config/global-skill-launchers.json](config/global-skill-launchers.json). They identify the target project skill, workflow id, payload mapping, and reporting fields; the project-owned skill remains the procedural source of truth.

Use `workflow_policy` and `context_pack` for bounded retrieval guidance, then proposal tools for reviewable changes. Write-capable actions still require a deliberately write-enabled MCP server and an explicit user-approved proposal.

## Retrieval Hardening

Hybrid retrieval remains SQLite-first. The package now supports optional local embeddings, semantic ranking blended with exact title/path/heading/tag/backlink signals, alias evidence, simple recency boosts, and retrieval feedback records stored in runtime state.

Enable the builtin local embedding provider in `config/runtime.json`:

```json
{
  "data_dir": ".dreamers-note-runtime",
  "private_globs": ["<private-vault-glob>"],
  "embeddings": {
    "enabled": true,
    "provider": "builtin",
    "model": "dreamers-local-semantic",
    "model_version": "2026-06-13",
    "dimensions": 48
  }
}
```

If embeddings are enabled but vectors are missing or stale, `server_status` and `context_pack` now report the repair-needed state explicitly and point back to `index_refresh`. The repair still happens only through `index_refresh`; read-only MCP calls do not perform hidden writes.

If embeddings are disabled, unavailable, or stale after a model or policy change, lexical retrieval still works and the MCP responses report embedding state explicitly. Excluded paths remain out of chunk vectors, hybrid results, feedback records, and runtime logs.

## Validate

The vault bootstrap check reads ignored `config/vault.local.json` or `VAULT_PATH` and expects tracked vault files to be clean aside from approved bootstrap support files.

```bash
bash scripts/validate-framework.sh
bash scripts/validate-vault-bootstrap.sh
bash tests/test-framework.sh
npm run typecheck
npm test
```

## Install Global Skill Launchers

Project-specific note skills are sourced from this repository under `.codex/skills/` and installed into the configured vault under `.codex/skills/`. Global Codex launchers live in `global-skills/` and delegate back to project-owned skills such as daily capture, direct note import, single-note review, and branch-scoped vault refactors. Copilot skill wrappers live in `.github/skills/` and can also be installed as personal Copilot skills.

```bash
./install.sh
```

Use `./install.sh --dry-run` to see what would be installed. Project skills are copied into the configured vault under `.codex/skills/`; global launchers are installed into `$CODEX_HOME/skills`; Copilot wrappers are installed into `$COPILOT_HOME/skills`, defaulting to `~/.copilot/skills`.

`.codex/skills/` is the project convention for local note-system skills. Installed global launchers remain the reliable `$` entry points outside this project, including `$dreamers-note` for command text, `$dreamers-note-import` for files such as `~/Desktop/linux.md`, `$dreamers-note-review` for a single note audit, and `$dreamers-note-refactor` for a branch-scoped vault refactor.

## Copilot Support

Repository-level Copilot instructions live in `.github/copilot-instructions.md`, with path-wide MCP reminders in `.github/instructions/dreamers-note.instructions.md`. Copilot project skills live under `.github/skills/<skill>/SKILL.md` and are thin wrappers around the project-owned `.codex/skills` workflows, so proposal-first vault behavior stays consistent across Codex and Copilot.

Install personal Copilot skills into `~/.copilot/skills` with the normal installer:

```bash
./install.sh
```

To also create or update the local Copilot CLI MCP config, use:

```bash
./install.sh --copilot-mcp
```

That updates `$COPILOT_HOME/mcp-config.json`, defaulting to `~/.copilot/mcp-config.json`, with a `dreamers-note` stdio server. The generated entry uses the current checkout path at install time and reads its safe tool allowlist from [config/copilot-mcp-tools.json](config/copilot-mcp-tools.json):

```json
{
  "mcpServers": {
    "dreamers-note": {
      "type": "stdio",
      "command": "node",
      "args": [
        "<repository-root>/dist/cli.js",
        "mcp",
        "--root",
        "<repository-root>"
      ],
      "tools": ["...config/copilot-mcp-tools.json"]
    }
  }
}
```

The default Copilot allowlist intentionally excludes `proposal_authorize` and `proposal_apply`. Copilot can retrieve context, run review tools, store feedback, and draft proposals, but applying a proposal still requires an explicit user-approved write-enabled MCP session.

For VS Code Copilot agent mode, point the local MCP configuration at the same command after building the package:

```bash
npm run build
node dist/cli.js mcp --root <repository-root>
```

GitHub-hosted Copilot cloud agent and code review can read repository instructions and project skills, but they cannot access a local vault unless the MCP server runs in an environment where that vault path exists.

## AI-Assisted Vault Remap

Build remap output in an ignored directory before reviewing a full remap:

```bash
python3 scripts/build-vault-inventory.py --indexes /safe/ignored/output .
```

After AI review writes approved records to the ignored output directory, apply only on a vault Git branch:

```bash
python3 scripts/apply-vault-remap.py --indexes /safe/ignored/output
```

Review the ignored output and vault repository with Git before merge. The framework source must never own vault inventories or decisions.
