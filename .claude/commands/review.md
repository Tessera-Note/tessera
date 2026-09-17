---
description: The mandatory post-scope review before declaring a task finished
---

Run the post-scope review by the skill
`.claude/skills/post-scope-review/SKILL.md`.

The order of the steps.

1. `stub-hunter` over the changed production files
2. the domain reviewer: `schema-reviewer` for changes to the schema, the models
   or the repositories, `i18n-reviewer` for changes to text and dictionaries. If
   neither applies, write "not applicable"
3. a pattern grep for the same class of bug across the repository. Remember that
   one contract here is usually implemented in several points at once: HTTP, MCP,
   Socket.IO, collaboration, search, export, public shares, the AI context
4. a test coverage check for every new function, branch and exception path
5. lint and a test run for the part you touched
6. an assessment of whether `docs/ai-context/` needs updating
7. checking your own claims: comments, the commit message and the answer are
   re-read the way code is

The answer must end with the block.

```
Post-scope review
1. stub-hunter: ...
2. Domain reviewer: ...
3. Pattern grep: ...
4. Test coverage: ...
5. Lint and tests: ...
6. docs/ai-context: ...
7. Own claims: ...
```

Mark the steps that do not apply explicitly; do not skip them silently.

Fix critical findings in the same session and do not report readiness until they
are gone. List the non-critical ones and do not fix them without confirmation.
