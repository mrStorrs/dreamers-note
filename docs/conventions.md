# Conventions

The repository holds skills, shared guidance, and small standalone scripts. The vault holds ordinary Markdown notes and a generated `note-index.md`.

Use lowercase kebab-case filenames and the classification described in [the workflow policy](note-workflow-policy.md). Normal notes require no frontmatter. Do not add an H1/H2 that merely repeats the note title or filename. Tags are optional topical tags from [the approved taxonomy](../taxonomy/approved-tags.md).

New project/source notes consult the vault's `06-templates/project-note.md` or `06-templates/source-note.md` when present. Replace placeholders and omit redundant title headings. Preserve the structure of existing notes.

Daily notes use `00-inbox/daily-notes/yyyy-mm-dd.md` and the lowercase `## notes` / `## research` sections from [the daily template](../templates/template-daily-note.md). Completed daily notes move to `99-archive/daily-notes/yyyy-mm-dd.md` only after their extracted content is verified. The workflow policy describes dates, section selection, and collision handling.

Existing classified folder homepages use `_<folder>.md`. Their `## Notes` section is human-owned. Maintain them with normal file edits when relevant; the index generator does not rewrite them.

The vault-wide `note-index.md` lists links only. Refresh it when paths change; read the notes themselves for content, tags, and relationships.
