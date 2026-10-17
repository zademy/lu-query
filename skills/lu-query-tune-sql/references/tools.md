# Tool reference - tuning

## explain_plan

```
explain_plan(sql: string)
-> DBMS_XPLAN text
```

- Runs `EXPLAIN PLAN FOR <sql>` in an autonomous transaction, then `DBMS_XPLAN.DISPLAY` on the plan table.
- No `SQLNET`/plan-table leftovers for the caller; needs `PLAN_TABLE` (and the `EXPLAIN PLAN` privilege).

## suggest_index

```
suggest_index(sql: string, targetTable?: string)
-> {"hasCandidates":true,"schema":"DEVUSER","table":"SKL_EMP",
    "accessProblem":"TABLE ACCESS FULL",
    "predicateColumns":["DEPT_ID","SALARY"],
    "recommendedColumns":["DEPT_ID","SALARY"],
    "recommendedDdl":"CREATE INDEX \"DEVUSER\".\"IX_SKL_EMP_DEPT_ID_SALARY\" ON \"DEVUSER\".\"SKL_EMP\" (\"DEPT_ID\", \"SALARY\")",
    "reasoning":"Full scan on DEVUSER.SKL_EMP with predicate column(s) [DEPT_ID, SALARY]. …"}
```

Rule-based: it detects full scans with predicates and proposes a composite index in predicate order. It does not model selectivity, so its `reasoning` may cite `num_distinct=0` when statistics are missing - read that as "stats missing", not as a real cardinality of zero.

## Statistics

```
get_table_stats(table, schema?)  -> rows: NUM_ROWS, BLOCKS, AVG_ROW_LEN, LAST_ANALYZED, …
get_column_stats(table, column?, schema?) -> rows per column: NUM_DISTINCT, DENSITY, NULLS, BUCKETS, …
get_histogram(table, column, schema?) -> histogram endpoints per bucket
```

All three come straight from the dictionary: if the object was never analyzed they return null values or an empty array. That is information, not failure.

## list_unused_indexes

```
list_unused_indexes(schema?)
-> [{"INDEX_OWNER":"DEVUSER","INDEX_NAME":"IDX_EMP_DEPT","COLUMNS":"DEPT_ID","UNIQUENESS":"NONUNIQUE","STATUS":"VALID",
     "LAST_ANALYZED":"…","MONITORING":"YES","LIKELY_UNUSED":"YES","START_MONITORING":"10/17/2026 19:38:28","END_MONITORING":null}]
```

Backed by `USER_OBJECT_USAGE` (Oracle 23ai/26ai have no `V$OBJECT_USAGE` for non-privileged users). Usage statistics are only as good as the monitoring window: an index unused since yesterday may be your primary key.

## run_sql_tuning_advisor

```
run_sql_tuning_advisor(sql: string)
-> GENERAL INFORMATION SECTION … Recommendation … (DBMS_SQLTUNE report text)
```

Creates and runs a SQL Tuning Advisor task (`mcp_sta_<timestamp>_<n>`). Slow (up to its 30 s default limit) and privilege-bound.
