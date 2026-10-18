---
name: lu-query-audit-data-quality
description: Use lu-query to check Oracle data quality - find duplicate key candidates with find_duplicates, count orphan rows of a foreign key with validate_fk_integrity, and get exact table counts with count_rows. Use when auditing a table before migrating, deduplicating, or validating a legacy FK.
compatibility: Requires the lu-query MCP server connected over stdio; these tools resolve the owner themselves (schema argument, then ORACLE_DB_SCHEMA, then the session's CURRENT_SCHEMA).
---

# Audit data quality with lu-query

## When to use

- "Are there duplicates?", "does this FK actually hold?", "how many rows does the table have, exactly?"
- Pre-migration or pre-deduplication checks.

## When not to use

- You need row values → [lu-query-query-data](../lu-query-query-data/SKILL.md).
- You want to _fix_ rows → audit first, then [lu-query-plan-data-changes](../lu-query-plan-data-changes/SKILL.md).

## Workflow

1. **Size the table.** `count_rows` (exact, no SQL handcrafting).
2. **Duplicates.** `find_duplicates` with the candidate key column(s). Read `groups`: each entry has the duplicated value, `CNT` and a `SAMPLE_ROWID` you can join on.
3. **Referential integrity.** `validate_fk_integrity` on the child table; optionally `constraint` to check one named FK. It reports orphans per constraint.
4. **Rank and report.** Order findings by business impact, not by tool order. State the exact SQL-equivalent you would run to fix each one, and let the user approve before any write.

## Reading results correctly

- `find_duplicates` excludes `NULL`s (SQL `GROUP BY` semantics): a column that is `NULL` in most rows will not show up as a duplicate group. Verify nullability with `describe_table` before trusting "no duplicates".
- `minCount` defaults to 2; raise it to find triplicates.
- `validate_fk_integrity` returns one row per FK with `orphan_count`. `0` means every child row resolves to a parent _among rows the tool can see_; `> 0` names real orphans.
- Legacy orphans can only exist if the constraint was created (or left) `NOVALIDATE`. If a FK was created and validated, the answer is trivially 0 - that is a real finding, not a bug.

## Tool reference

| Tool                    | Signature                                            | Returns                                                                                               |
| ----------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `count_rows`            | `table*`, `schema?`                                  | `{schema, table, rowCount}`                                                                           |
| `find_duplicates`       | `table*`, `columns*` (array), `minCount?`, `schema?` | `{schema, table, columns, minCount, groups: [{<col>: value, CNT: n, SAMPLE_ROWID: rid}]}`             |
| `validate_fk_integrity` | `table*`, `constraint?`, `schema?`                   | array of `{constraint_name, child_columns, parent_owner, parent_table, parent_columns, orphan_count}` |

Details: `references/tools.md`. Verified transcripts: `references/examples.md`.

## Safety

Read-only. Nothing here writes. But do not turn findings into `UPDATE`s on your own initiative: propose the fix, get approval, then use [lu-query-plan-data-changes](../lu-query-plan-data-changes/SKILL.md).
