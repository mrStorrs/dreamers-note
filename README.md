# dreamers-note

AI framework for organizing the Obsidian vault at `<local-home>/obsidian/cyborg`.

This repository owns the AI behavior. skills live in dreamers-note, not in the Obsidian vault. The vault remains the note store, with only lightweight support files such as approved topical tags and note templates copied there when a plan explicitly allows it.

## Operating Model

- Use Git branches for AI-made vault changes.
- Review with `git diff` and pull requests before merge.
- Prefer chat-first proposals. File output is optional and stays in this repository unless requested.
- Treat skills as phase-gated runs that call agents at specific steps.
- Treat agents as narrow role contracts, not full workflows.
- Keep normal notes light: optional topical `tags` only.
- Use lowercase kebab-case for new files.
- Use scripts where they make a skill safer or repeatable.

## Target Vault

Configured in [config/vault.json](config/vault.json):

```text
<local-home>/obsidian/cyborg
```

## Validate

```bash
bash scripts/validate-framework.sh
bash tests/test-framework.sh
```

## Daily Triage Dry Run

```bash
python3 scripts/propose-daily-triage.py --vault <local-home>/obsidian/cyborg 00-inbox/2026-05-31.md
```

Add `--archive` only after approved extraction changes are visible in Git diff.
