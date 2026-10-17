---
name: lu-query-tune-sql
description: Use lu-query to diagnose slow or suspicious Oracle SQL - explain_plan for the real execution plan without running the statement, suggest_index for index DDL when a full scan is the problem, get_table_stats/get_column_stats/get_histogram for optimizer statistics, list_unused_indexes for index cleanup and run_sql_tuning_advisor for the advisor report.
compatibility: Requires the lu-query MCP server connected over stdio; advisor tools need SQL Tuning Advisor privileges and PLAN_TABLE.
---

# Tune SQL with lu-query

## When to use

- "This query is slow", "do I need that index?", "why is the optimizer choosing a full scan?"

## When not to use

- The database is blocked or unreachable → [lu-query-triage-incident](../lu-query-triage-incident/SKILL.md).
- You have not measured anything yet → measure first; never "optimise" from reading SQL.

## Workflow

1. **Get the plan without side effects on data.** `explain_plan` on the exact SQL. It writes a row to `PLAN_TABLE` inside an autonomous transaction and reads it back with `DBMS_XPLAN` - the statement itself is not executed.
2. **Read the plan like this:** `TABLE ACCESS FULL` on a filtered table is the first thing to fix; `INDEX RANGE SCAN` is usually good; "dynamic statistics used: dynamic sampling" means the optimizer is guessing because statistics are missing or stale; `Rows` estimates that are off by orders of magnitude point at bad statistics, not at a bad plan.
3. **Confirm the statistics story.** `get_table_stats` (row count, blocks, last analyzed), `get_column_stats` (NDV, density, nulls), `get_histogram` (endpoints). Nulls or `[]` mean the table/column has never been analyzed - gather statistics as a DBA, then re-explain.
4. **Ask for index DDL.** `suggest_index` returns `recommendedColumns` and a ready `recommendedDdl` when a full scan with predicates is detected. Review the DDL before running it with `create_index` (that tool _commits_ DDL).
5. **Escalate if needed.** `run_sql_tuning_advisor` gives a DBMS_SQLTUNE report with recommendations; it can be slow and it needs advisor privileges.
6. **Clean up later.** `list_unused_indexes` flags indexes that look unused (`LIKELY_UNUSED`) - a heuristic, never drop on this signal alone.

## Tool reference

| Tool                     | Signature                      | Returns                                                                                                          |
| ------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `explain_plan`           | `sql*`                         | `DBMS_XPLAN` text (plan table + predicate info + notes)                                                          |
| `suggest_index`          | `sql*`, `targetTable?`         | `{hasCandidates, schema, table, accessProblem, predicateColumns, recommendedColumns, recommendedDdl, reasoning}` |
| `get_table_stats`        | `table*`, `schema?`            | rows from the table statistics dictionary                                                                        |
| `get_column_stats`       | `table*`, `column?`, `schema?` | rows per column                                                                                                  |
| `get_histogram`          | `table*`, `column*`, `schema?` | histogram endpoints for one column                                                                               |
| `list_unused_indexes`    | `schema?`                      | rows with `LIKELY_UNUSED` heuristic and monitoring window                                                        |
| `run_sql_tuning_advisor` | `sql*`                         | DBMS_SQLTUNE report text                                                                                         |

Details: `references/tools.md`. Verified transcripts: `references/examples.md`.

## Safety

- `explain_plan` writes to `PLAN_TABLE` (needs the grant; the project ships `scripts/test-grants-explain.sql` for tests).
- `run_sql_tuning_advisor` runs the advisor workload and may need the SQL Tuning Advisor pack licensed/enabled in the database; treat it as an escalation with a time limit.
- Creating an index is DDL: it commits, and it costs write throughput. Propose, do not silently create.

## Failure recovery

| Symptom                                  | Cause                                       | Action                                           |
| ---------------------------------------- | ------------------------------------------- | ------------------------------------------------ |
| `ORA-01031` on `explain_plan`            | no `PLAN_TABLE` / advisor grants            | ask for `scripts/test-grants-explain.sql` grants |
| plan shows `dynamic sampling` everywhere | missing statistics                          | gather stats (DBA), re-run `explain_plan`        |
| `get_*_stats` returns nulls or `[]`      | table/column never analyzed                 | expected on fresh tables; gather stats first     |
| advisor report empty                     | statement too simple or advisor unavailable | fall back to `explain_plan` + `suggest_index`    |
