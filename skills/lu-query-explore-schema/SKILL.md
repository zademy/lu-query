---
name: lu-query-explore-schema
description: Use lu-query to explore an unknown Oracle database - discover schemas, tables, views, indexes, constraints, triggers, procedures, sequences and partitions, read an object's DDL, and map dependencies with Mermaid graphs. Start here before writing any SQL against an unfamiliar schema. Covers 31 metadata and graph tools.
compatibility: Requires the lu-query MCP server connected over stdio. Object-scoped tools resolve the owner themselves: the schema argument, then ORACLE_DB_SCHEMA, then the session's CURRENT_SCHEMA.
---

# Explore an Oracle schema with lu-query

## When to use

- You do not know the schema: "which table holds orders?", "what columns does `SKL_EMP` have?", "what breaks if I drop this?"
- You need the exact DDL of an object before changing it.
- You need to see relationships: foreign keys, object dependencies.

## When not to use

- You already know the table and want rows → [lu-query-query-data](../lu-query-query-data/SKILL.md).
- You want to change structure → [lu-query-manage-schema](../lu-query-manage-schema/SKILL.md).
- You want to call a procedure → [lu-query-use-plsql](../lu-query-use-plsql/SKILL.md).

## Workflow

1. **Ground yourself.** `test_connection` → confirm database name, current user and current schema. Everything else is relative to that.
2. **Find objects by name pattern.** `search_objects` (any type) or `list_tables` / `list_views` (with `namePattern`, e.g. `SKL%`). They resolve the session schema on their own; pass `schema` only to target another owner.
3. **Describe the object.** `describe_table` for columns/nullability/defaults/comments, `get_ddl` for the full source, or read the resource `oracle://schema/{schema}/table/{table}` for a formatted column report and `oracle://schema/{schema}/object/{object}/ddl` for DDL.
4. **Inspect structure.** `list_indexes`, `list_constraints`, `list_partitions`, `list_triggers`, `list_sequences` / `get_sequence_info`, `list_types`.
5. **Check for damage.** `list_invalid_objects` (status `INVALID` = broken code) and `get_plsql_errors` for the compilation message.
6. **Map relationships.** `get_fk_graph` (foreign keys) and `get_dependency_graph` (what an object needs / who needs it). Both return a `mermaid` field you can render or paste.
7. **Confirm existence cheaply.** `table_exists` returns a bare `true`/`false` (views do not count).

## Schema resolution (verified)

Every object-scoped tool resolves the owner in this order, and stops at the first hit:

1. the `schema` argument of the call;
2. `ORACLE_DB_SCHEMA` on the server;
3. the session's own `CURRENT_SCHEMA` (`SYS_CONTEXT('USERENV','CURRENT_SCHEMA')`) - the owner you are connected as.

So with neither `ORACLE_DB_SCHEMA` nor a `schema` argument, `describe_table`, `count_rows`, `get_table_stats`, every catalog tool with `table` and every DDL tool still work: they read the session schema. (Verified 2026-10-18 on 2.16.2. Before that the session fallback was broken and they failed with "needs a schema".)

Pass `schema` only to target an owner other than the one you are connected as.

A blank `schema` (`"   "`) is not an owner: it falls through to the next step of the order above. To know the owner you are connected as, read `currentSchema` from `test_connection`.

## Tool reference

| Tool                                                                                                      | Use for                                                                         |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `test_connection`                                                                                         | connectivity, version, current user/schema                                      |
| `list_schemas`                                                                                            | users visible to the connection                                                 |
| `list_tables` / `list_views`                                                                              | tables / views, optional `schema`, `namePattern`                                |
| `search_objects`                                                                                          | any object type by pattern (returns `OBJECT_TYPE`, `STATUS`)                    |
| `list_objects`                                                                                            | objects filtered by `type`                                                      |
| `describe_table`                                                                                          | columns, types, nullability, defaults, comments                                 |
| `table_exists`                                                                                            | boolean existence check                                                         |
| `get_ddl`                                                                                                 | DDL of any object (`type` inferred when omitted on the resource, required here) |
| `list_indexes`, `list_constraints`, `list_partitions`, `list_ind_partitions`, `list_subpartitions`        | physical and logical structure                                                  |
| `list_sequences`, `get_sequence_info`                                                                     | sequence range, cache, last number                                              |
| `list_triggers`, `list_procedures`, `list_types`, `list_synonyms`, `list_lob_columns`                     | code and type objects                                                           |
| `list_db_links`, `list_directories`, `list_external_tables`, `list_materialized_views`, `list_mview_logs` | objects outside the local tablespace                                            |
| `list_invalid_objects`, `list_dependencies`, `list_scheduler_jobs`, `list_scheduler_job_runs`             | breakage and automation                                                         |

Full signatures, output shapes and gotchas: `references/tools.md`.
Verified transcripts: `references/examples.md`.

## Reading results correctly

- Column types arrive as Oracle renders them: `NUMBER(6,)`, `NUMBER(10,2)`, `TIMESTAMP(6)`. The trailing comma in `NUMBER(precision,)` is cosmetic.
- Dates in JSON are ISO strings with a `Z` suffix (`2024-01-15T06:00:00.000Z`); `DATE` columns are converted to UTC instants - that is the client's serialisation, not the stored local time.
- `STATUS: VALID` vs `INVALID` on `search_objects` is about compilable code, not permissions.

## Safety

This skill is read-only. It never mutates. Keep it that way: do not follow an exploration with a DDL call unless the user asked for the change.

## Evidence

Quote the tool call and the rows you relied on. Every call lands in the session audit Markdown; `oracle://audit/session/current` returns the file for the running session.
