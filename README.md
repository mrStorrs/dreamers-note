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
- Store durable topical notes under `02-knowledge/<area>/<sub-area>/`.

## Target Vault

Configured in [config/vault.json](config/vault.json):

```text
/home/cjstorrs/obsidian/cyborg
```

Skills and helper scripts read this config by default. Pass `--vault` only when intentionally overriding the configured vault for tests or one-off runs.

## Validate

```bash
bash scripts/validate-framework.sh
bash tests/test-framework.sh
```

## Install Global Skill Launcher

Project-specific note skills are sourced from this repository under `.codex/skills/` and installed into the configured vault under `.codex/skills/`. The global launcher lives in `global-skills/` and delegates back to the project-owned daily capture skill.

```bash
./install.sh
```

Use `./install.sh --dry-run` to see what would be installed. Project skills are copied into the configured vault under `.codex/skills/`; the global launcher is installed into `$CODEX_HOME/skills` and becomes available in new Codex sessions.

`.codex/skills/` is the project convention for local note-system skills. The installed global launcher remains the reliable `$` entry point outside this project.

## Daily Triage Dry Run

```bash
python3 scripts/propose-daily-triage.py 00-inbox/2026-05-31.md
```

Add `--archive` only after approved extraction changes are visible in Git diff.

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
