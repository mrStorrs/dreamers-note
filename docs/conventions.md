# conventions

`dreamers-note` owns its five canonical skills, Node/TypeScript CLI, validation, and local framework configuration. The Obsidian vault owns notes and installed skills under `.codex/skills`.

Use lowercase kebab-case names. Store durable notes at:

```text
01-projects/<main>/<sub>/<note>.md
02-knowledge/<main>/<sub>/<note>.md
03-sources/...
04-people/<main>/<sub>/<note>.md
```

Family notes belong in `04-people/family/<sub>/`. Do not create `02-areas` or `03-knowledge`. Classified folder homepages use `_<folder>.md`; their generated lead describes the subject, while `## Notes` is human-owned.

Tags are optional topical tags only. Apply only names in [the approved taxonomy](../taxonomy/approved-tags.md); propose missing tags separately. Do not use lifecycle, kind, queue, or review tags.

Normal notes need no required frontmatter. Avoid headings that only repeat the filename. Keep private paths out of the ignored runtime cache according to `private_globs` in [runtime.json](../config/runtime.json). Shared workflow and approval rules live in [note-workflow-policy.md](note-workflow-policy.md).
