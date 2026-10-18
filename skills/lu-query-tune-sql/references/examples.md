# Verified examples - tuning

Oracle 26ai Free, lu-query 2.16.2, 2026-10-18, `SKL_EMP` freshly created (no statistics gathered).

Statement used: `SELECT EMP_ID, EMAIL FROM SKL_EMP WHERE DEPT_ID = 10 AND SALARY > 50000`

## Plan without executing

```json
{
  "tool": "explain_plan",
  "args": { "sql": "SELECT EMP_ID, EMAIL FROM SKL_EMP WHERE DEPT_ID = 10 AND SALARY > 50000" }
}
```

```text
Plan hash value: 2949234026
------------------------------------------------------------------------------
| Id  | Operation         | Name    | Rows  | Bytes | Cost (%CPU)| Time     |
------------------------------------------------------------------------------
|   0 | SELECT STATEMENT  |         |     3 |   303 |     3   (0)| 00:00:01 |
|*  1 |  TABLE ACCESS FULL| SKL_EMP |     3 |   303 |     3   (0)| 00:00:01 |
------------------------------------------------------------------------------
    1 - filter("DEPT_ID"=10 AND "SALARY">50000)
    Note
    -----
    - dynamic statistics used: dynamic sampling (level=2)
```

Two signals in one glance: full scan, and dynamic sampling (no statistics).

## Index proposal

```json
{ "tool": "suggest_index", "args": { "sql": "SELECT …", "targetTable": "SKL_EMP" } }
```

```json
{
  "hasCandidates": true,
  "schema": "DEVUSER",
  "table": "SKL_EMP",
  "accessProblem": "TABLE ACCESS FULL",
  "predicateColumns": ["DEPT_ID", "SALARY"],
  "recommendedColumns": ["DEPT_ID", "SALARY"],
  "recommendedDdl": "CREATE INDEX \"DEVUSER\".\"IX_SKL_EMP_DEPT_ID_SALARY\" ON \"DEVUSER\".\"SKL_EMP\" (\"DEPT_ID\", \"SALARY\")",
  "reasoning": "Full scan on DEVUSER.SKL_EMP with predicate column(s) [DEPT_ID, SALARY]. Indexing [DEPT_ID, SALARY] (num_distinct=0 for the leading column) should let Oracle use an index range scan."
}
```

`num_distinct=0` = statistics missing (fresh table). Apply with `create_index` only after review.

## Statistics on an unanalyzed table

```json
{"tool": "get_table_stats", "args": {"table": "SKL_EMP"}}
[{"SCHEMA_NAME":"DEVUSER","NAME":"SKL_EMP","NUM_ROWS":null,"BLOCKS":null,…,"LAST_ANALYZED":null,…}]

{"tool": "get_column_stats", "args": {"table": "SKL_EMP", "column": "EMAIL"}}
[]

{"tool": "get_histogram", "args": {"table": "SKL_EMP", "column": "EMAIL"}}
[]
```

Before drawing conclusions from any plan, gather statistics (DBA action; there is no gather-stats tool here) and re-run `explain_plan`.

## SQL Tuning Advisor (works on 26ai Free with the ADVISOR grant)

```json
{
  "tool": "run_sql_tuning_advisor",
  "args": { "sql": "SELECT EMP_ID, EMAIL FROM SKL_EMP WHERE DEPT_ID = 10 AND SALARY > 50000" }
}
```

```text
GENERAL INFORMATION SECTION
-------------------------------------------------------------------------------
Tuning Task Name   : mcp_sta_1792268106590_3
Tuning Task Owner  : DEVUSER
Workload Type      : Single SQL Statement
Scope              : COMPREHENSIVE
Time Limit(seconds): 30
Completion Status  : COMPLETED
…
```

## Unused-index heuristic

```json
{"tool": "list_unused_indexes", "args": {}}
[{"INDEX_OWNER":"DEVUSER","INDEX_NAME":"SYS_C008590","TABLE_NAME":"DEPARTMENTS","COLUMNS":"DEPT_ID","UNIQUENESS":"UNIQUE","STATUS":"VALID","MONITORING":"YES","LIKELY_UNUSED":"YES","START_MONITORING":"10/17/2026 19:38:28","END_MONITORING":null}]
```

A `SYS_C…` unique index (constraint-backed) is never droppable - read `UNIQUENESS`/name before recommending anything.
