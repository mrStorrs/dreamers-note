# conventions

## repository ownership

`dreamers-note` owns AI skills, agent contracts, helper scripts, proposal templates, fixtures, and validation.

The Obsidian vault owns notes and installed project-local Codex skills under `.codex/skills`.

Each agent contract must define the agent's role, allowed actions or tools, handoffs, and forbidden actions. Agents are narrow role contracts, not full workflows.

Each skill must define the phase-gated run. A skill tells the operator what happens in step one, which agent is called in the correct context, how agent work is verified, and when Git review is required.

## naming

Use lowercase kebab-case for new files and folders.

Use date prefixes only where chronology matters:

- daily notes: `yyyy-mm-dd.md`
- inbox captures: `yyyy-mm-dd-hhmm-short-title.md`
- meetings: `yyyy-mm-dd-meeting-topic.md`
- sources: `author-year-short-title.md`
- projects: `project-short-name.md`
- area notes: `02-areas/<area>/<sub-area>/clear-noun-phrase.md`
- people: `first-last.md` or `organization-name.md`
- templates: `template-purpose.md`
- AI-generated branch changes: branch names use `feat/short-kebab-description`

Prefer descriptive names over vague names. Avoid names such as `notes.md`, `misc.md`, `ideas.md`, and `important.md` unless the containing folder makes the subject obvious.

## folder structure

Use `02-areas` as the durable topical knowledge home. Do not create or target a separate `03-knowledge` folder.

Area notes must use exactly two topic directories:

```text
02-areas/<area>/<sub-area>/<note-name>.md
```

Examples:

- `02-areas/ai/agents/skill-routing.md`
- `02-areas/food/recipes/chicken-stock.md`
- `02-areas/obsidian/workflows/daily-triage.md`

Do not nest area notes deeper than `area/sub-area`. If an imported path contains more topic directories, fold the extra context into the filename.

## tags

Tags are topical tags. They describe broad themes a person would want to filter across the vault.

Good examples:

- `ai`
- `recipes`
- `meal-planning`
- `obsidian`
- `local-first`

Do not use tags as lifecycle, kind, queue, or review metadata. The framework uses Git branches, chat-first proposals, and pull request review for workflow state.

AI may use only tags from [../taxonomy/approved-tags.md](../taxonomy/approved-tags.md). When a useful tag is missing, AI reports a new-tag proposal instead of applying it.

## metadata

Normal notes do not require frontmatter. Do not require `type`, `status`, `aliases`, `created`, `updated`, `sensitivity`, `processing_status`, `agent_route`, or `review_required`. If tags are useful, keep frontmatter minimal:

```yaml
---
tags:
  - ai
  - recipes
---
```
