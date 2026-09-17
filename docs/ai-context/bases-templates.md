# Bases and templates

## Bases

`api/bases.py` (23 routes), `services/bases.py`. A base is a table over pages:
its own properties, rows and views.

The route groups: the base itself (create, details, edit, delete, turn a page
into a base, expand pages, CSV export), properties (create, edit, delete,
reorder), rows (create, details, edit, delete, delete many, reorder, list),
views (create, edit, delete, list).

The order of rows and properties is held by the same fractional key as the page
tree, with `C` collation.

## Property display settings

They live in `type_options` next to everything else and decide display only: the
number format (`format`, `precision`, `separator`, `currency`), the time part of
a date (`includeTime`, `timeFormat`), the default state of a checkbox
(`defaultValue`), several people in one cell (`allowMultiple`), alphabetical
order of options (`alphabetize`).

There are two places where this is easy to break.

- **Parsing a formula assembles `type_options` from scratch.** The display
  fields are carried over separately (`DISPLAY_OPTIONS` in
  `services/bases.py`); otherwise saving an expression wipes the number format —
  and the "two decimal places" setting disappears silently.
- **The default value is set by the server** (`_defaults` in `create_row`), not
  by the screen: a row is created both by importing a table and through the API,
  and the promise belongs to the property rather than to one screen.

Number and date display is assembled by `numberText` and `dateText`
(`apps/web/src/lib/features/base/cells.ts`). Separators are substituted
directly rather than by the facilities of the output language: the set is chosen
by a person, and the browser language of the reader must not change how someone
else's table looks.

## Filter and order — yours first

A view is shared: a recorded filter changes the table for everyone. That is why
an edit lives on the screen (`draft` in the base route) and reaches everyone
through a separate "Save for everyone" action. A silent write would reorder the
table for the whole team just because one person sorted it for themselves.

## Formulas

They are computed on the server, while rows are served. The parser lives in
`apps/api/tessera_api/domain/formula`; earlier the same engine was TypeScript
and worked in the browser only.

The order is the same: string → tokens → a tree with column names → a tree with
identifiers → type check → evaluation on a row. The storage format is unchanged
(`{source, ast, resultType, dependencies, astVersion}`), so formulas entered
earlier are read as they are.

Things worth knowing about the design in advance.

- **Values are not stored.** A formula column is computed on every serving:
  `services/bases.py:apply_formulas`. Storing them would mean recomputing the
  whole table after an edit to a neighbouring cell, and a divergence between
  what is stored and what is true.
- **The tree holds the column identifier, not its name.** Renaming a column does
  not break a formula.
- **A cycle is caught before saving** (`FormulaGraph.cycle_with`): a base with a
  cycle would stop opening, and there would be nothing left to fix it with from
  the inside.
- **A data error is a value, not a failure.** Division by zero colours one cell
  (`{"__err": "DIV_BY_ZERO"}`) and the other rows are still computed. A person
  is shown the translation for the code rather than the English text from `msg`.
- **Thirty functions**: numbers, strings, dates, casts, `empty`. The names and
  their spelling are fixed: they are held in formulas that have already been
  saved.

Tests: `apps/api/tests/test_formula.py`; they need no database.

## Templates

`api/templates.py` (six routes), `services/templates.py`. A template is a page
blank; applying it creates a new page in the chosen place.

The MCP tools can do the same: `get_template`, `create_template`,
`update_template`, `delete_template`, `use_template`.

## Permissions

Both a base and a template belong to a space and a workspace. Any serving of
their content passes the same access check as a page: `services/page_access.py`.
