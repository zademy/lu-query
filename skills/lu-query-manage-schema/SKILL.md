---
name: lu-query-manage-schema
description: Use lu-query to change Oracle structure in the user's own schema - comments on tables and columns, views, synonyms, sequences, indexes and materialized-view logs. Use when the user asked for a DDL change and you must know its constraints, the columns argument shape, and what Oracle will refuse.
compatibility: Requires the lu-query MCP server connected over stdio plus CREATE ANY TABLE/VIEW/SEQUENCE/INDEX (or ownership) in the target schema.
---

# Manage schema objects with lu-query

## When to use

- "Document this column", "create a view over these tables", "add an index on (dept_id, salary)", "make a synonym for HR tables".

## When not to use

- Row-level changes → [lu-query-plan-data-changes](../lu-query-plan-data-changes/SKILL.md).
- Reading existing DDL → [lu-query-explore-schema](../lu-query-explore-schema/SKILL.md).
- Creating tables, packages or types: **no tool does that.** PL/SQL source and `CREATE TABLE` need another route (sqlplus, a migration tool, or a DBA); this server is a client, not a migration engine.

## Workflow

1. **Check what exists.** `table_exists`, `list_indexes`, `search_objects` before creating anything; use `get_ddl` for the current definition.
2. **Prefer create-or-replace semantics.** `create_or_replace_view` and `create_synonym` replace silently; `create_sequence` and `create_index` fail if the name exists (drop first, with the user's approval).
3. **Shape arguments correctly.** Indexes take `columns` as an **array**; `index` is the index name and `tableSchema` is the table's owner - different from the `schema` argument that names the target schema.
4. **Respect ownership.** Comment tools only work on objects the connected user owns (there is no system privilege for commenting someone else's table). Views and sequences require `CREATE ANY …` for other schemas.
5. **Verify.** Re-read with `list_indexes` / `list_views` / `get_ddl` and quote the result.

## Tool reference

| Tool                     | Signature                                                                    | Notes                                             |
| ------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------- |
| `comment_on_table`       | `table*`, `comment*`, `schema?`                                              | replaces the comment                              |
| `comment_on_column`      | `table*`, `column*`, `comment*`, `schema?`                                   | replaces the comment                              |
| `create_or_replace_view` | `view*`, `selectBody*`, `schema?`                                            | `selectBody` is a SELECT without the trailing `;` |
| `create_synonym`         | `synonym*`, `targetSchema*`, `targetName*`, `isPublic?`                      | private by default                                |
| `create_sequence`        | `sequence*`, `startWith?`, `incrementBy?`, `cache?`, `schema?`               | fails if the name exists                          |
| `create_index`           | `table*`, `columns*` (array), `index*`, `tableSchema*`, `unique?`, `schema?` | `tableSchema` = owner of the table                |
| `create_mview_log`       | `table*`, `withPrimaryKey?`, `withRowid?`, `includingNewValues?`, `schema?`  | required before fast refresh                      |

Details: `references/tools.md`. Verified transcripts: `references/examples.md`.

## Reading results correctly

Each tool returns a single confirmation line such as `Index DEVUSER.SKL_EMP_EMAIL_IX created on DEVUSER.SKL_EMP.` - one call, one object. There is no batch mode; parallel calls are fine because each is its own transaction.

## Safety

- DDL auto-commits and cannot be rolled back through this server. Confirm the target schema out loud before creating.
- Names go through an identifier allow-list (`^[A-Za-z][A-Za-z0-9_$#]{0,127}$`); quoted, mixed-case or exotic names will be rejected.
- Creating a public synonym (`isPublic: true`) exposes the object to every user - confirm intent.

## Failure recovery

| Symptom                             | Cause                           | Action                                                                       |
| ----------------------------------- | ------------------------------- | ---------------------------------------------------------------------------- |
| `ORA-01031` insufficient privileges | no `CREATE ANY …` and not owner | ask for the grant; do not retry                                              |
| `ORA-00955` name already used       | object exists                   | inspect with `search_objects`; replace (view/synonym) or ask before dropping |
| `ORA-01031` on comments             | object owned by another user    | comments are owner-only                                                      |
