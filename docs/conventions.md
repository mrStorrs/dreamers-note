# conventions

## repository ownership

`dreamers-note` owns AI skills, agent contracts, helper scripts, proposal templates, fixtures, and validation.

The TypeScript package foundation lives under `src/` and exposes shared config loading, convention validation, path safety, link parsing, file listing, and runtime helpers for future MCP work.

The Obsidian vault owns notes and installed project-local Codex skills under `.codex/skills`.

Each agent contract must define the agent's role, allowed actions or tools, handoffs, and forbidden actions. Agents are narrow role contracts, not full workflows.

Each skill must define the phase-gated run. A skill tells the operator what happens in step one, which agent is called in the correct context, how agent work is verified, and when Git review is required.

## naming

Use lowercase kebab-case for new files and folders.

Use date prefixes only where chronology matters:

- daily notes: `00-inbox/daily-notes/yyyy-mm-dd.md`
- inbox captures: `yyyy-mm-dd-hhmm-short-title.md`
- meetings: `yyyy-mm-dd-meeting-topic.md`
- sources: `author-year-short-title.md`
- projects: `01-projects/<main>/<sub>/<project-note>.md`
- knowledge notes: `02-knowledge/<main>/<sub>/clear-noun-phrase.md`
- people: `04-people/<main>/<sub>/first-last.md` or `04-people/<main>/<sub>/organization-name.md`
- templates: `template-purpose.md`
- AI-generated branch changes: branch names use `feat/short-kebab-description`

Prefer descriptive names over vague names. Avoid names such as `notes.md`, `misc.md`, `ideas.md`, and `important.md` unless the containing folder makes the subject obvious.

## folder structure

Use `02-knowledge` as the durable topical knowledge home. Do not create or target a separate `02-areas` or `03-knowledge` folder.

Use `00-inbox/daily-notes` for active daily notes created by Obsidian. Processed daily notes move to `99-archive/daily-notes` after approved extraction.

Project, knowledge, and people notes all use exactly two classification directories below the root:

```text
01-projects/<main>/<sub>/<note-name>.md
02-knowledge/<main>/<sub>/<note-name>.md
04-people/<main>/<sub>/<note-name>.md
```

Examples:

- `01-projects/ai/obsidian-note-system/vault-normalization.md`
- `02-knowledge/ai/agents/skill-routing.md`
- `02-knowledge/food/recipes/chicken-stock.md`
- `02-knowledge/obsidian/workflows/daily-triage.md`
- `04-people/family/immediate/jane-doe.md`

Do not nest project, knowledge, or people notes deeper than `main/sub`. If an imported path contains more classification directories, fold the extra context into the filename.

### Directory homepages

Every classified subfolder at or below `01-projects/<main>`, `02-knowledge/<main>`, and `04-people/<main>` has a directory homepage named `_<folder-name>.md`. This recursive homepage exception does not change the normal page placement rule above.

Directory homepages do not repeat their filename as a title heading. Their generated lead summarizes the folder's subject matter from substantive owner-note prose or current child topics; it never explains that the file is an index or homepage. They also use a human-owned `## Notes` section and generated `## Subfolders` and `## Pages` sections when those entries exist. AI may refresh generated sections, but must preserve `## Notes` unless the user explicitly asks to change it.

Proposal creation computes the projected classified folder state and adds only byte-changing generated homepage targets before authorization. A title, first substantive summary, direct-page membership, subfolder membership, move, or explicit homepage `## Notes` edit can require a refresh; unrelated body edits do not. Every derived target is visible in `proposal_read` and uses the same hashes, authorization, apply lock, and rollback as the requested note change.

Manual Obsidian changes remain proposal-first: `health_report` and the `directory-homepages` group in `review_queue` report drift without changing vault bytes. Use `proposal_create_directory_index_refresh` with the reported homepage paths, review the deterministic diff, and authorize/apply it normally. A malformed homepage without an identifiable protected `## Notes` section is reported but never overwritten automatically.

Family notes belong under `04-people/family/<sub>/`, not under `02-knowledge/family/`.

Keep [../config/conventions.json](../config/conventions.json) aligned with these roots and depth rules. It is the machine-readable policy used by package validation.

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

## runtime data

Runtime state for the TypeScript package belongs in the Git-ignored `.dreamers-note-runtime/` directory configured by [../config/runtime.json](../config/runtime.json). Keep runtime data rebuildable. Local runtime index files may persist note chunks and metadata needed for lexical search, but secrets and excluded private paths must stay out of runtime state via `private_globs`, and note content must never be logged or committed.
