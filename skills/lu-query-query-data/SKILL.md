---
name: lu-query-query-data
description: Use lu-query to answer a data question from Oracle with a read-only SELECT - run_query for arbitrary SELECTs with offset/limit pagination, get_sample_data for a quick row preview. Covers capped reads (1000 rows), when a specialized tool is better than SQL, how to read the row envelope, and how CLOB, BLOB, JSON and XML columns come back.
compatibility: Requires the lu-query MCP server connected over stdio.
---

# Query data with lu-query

## When to use

- "How many rows match X?", "show me the last 20 orders", "what does this table look like?"
- Any read-only question whose answer is a `SELECT`.

## When not to use

- You do not know which table holds the data → [lu-query-explore-schema](../lu-query-explore-schema/SKILL.md).
- You want duplicates/orphans/exact counts → [lu-query-audit-data-quality](../lu-query-audit-data-quality/SKILL.md) (dedicated tools beat handcrafted SQL).
- You want to change rows → [lu-query-plan-data-changes](../lu-query-plan-data-changes/SKILL.md).

## Workflow

1. **Prefer the specialized tool.** `count_rows`, `get_table_stats`, `find_duplicates`, `get_session_sql_text` exist because handcrafted SQL on those questions is slower or wrong. Use `run_query` when nothing fits.
2. **Write one SELECT.** CTEs are fine. No DML: `run_query` rejects anything that is not a `SELECT` before Oracle sees it, so a mistake costs nothing.
3. **Page deterministically.** Always add an `ORDER BY` when you page, and pass `offset`/`limit`; without them the 1000-row cap of every read tool hides the rest. Server-side SQL becomes `OFFSET n ROWS FETCH NEXT m ROWS ONLY`.
4. **Read the envelope.** `run_query` returns `{columns, rows, rowCount, truncated, rowLimit, offset, limit}`. If `truncated` is `true`, you did not see everything - page or narrow the query (when `rowCount == rowLimit`, the result may be exactly at the cap).
5. **Preview unknown data cheaply.** `get_sample_data` returns the first N rows (default 10, max 1000) and reports progress on long reads.

## Reading results correctly

- Values are JSON: `DATE`/`TIMESTAMP` columns serialise as ISO strings in UTC (`2024-01-15T06:00:00.000Z`), `NUMBER` as JSON numbers, `NULL` as `null`.
- Column names come back UPPERCASE from Oracle; address them as returned, not as you typed them.
- Non-scalar columns are materialised, not left as handles: a `CLOB`/`NCLOB` comes back as the full text (no 4000-character truncation), a `BLOB` as `{"type":"Buffer","data":[65,66]}`, a `JSON` column as the parsed object, and an `XMLTYPE` column as the XML text.
- Empty result and error look different: a successful call has `rowCount: 0`; a failed call returns `isError` text.

## Safety

Read-only. But note:

- A `SELECT` can still lock (rarely, with `FOR UPDATE`) and can be expensive: `statement timeout is 120 s`, socket 30 s, request watchdog 150 s. Prefer predicates that use indexes.
- Aggregates over huge tables (`COUNT(*)` without filter) are the classic timeout; use `count_rows`.

## Tool reference

| Tool              | Signature                    | Returns                                                         |
| ----------------- | ---------------------------- | --------------------------------------------------------------- |
| `run_query`       | `sql*`, `offset?`, `limit?`  | `{columns, rows, rowCount, truncated, rowLimit, offset, limit}` |
| `get_sample_data` | `table*`, `rows?`, `schema?` | same envelope, first N rows                                     |

Details: `references/tools.md`. Verified transcripts: `references/examples.md`.

## Failure recovery

| Symptom                                               | Cause                                                         | Action                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- |
| `run_query needs a SELECT`                            | statement is not a SELECT                                     | use `execute_dml*` for writes (different skill)                      |
| `ORA-00942`                                           | missing grants / typo                                         | check with `search_objects`, ask for the grant; do not retry blindly |
| a `list_*` tool returns fewer rows than the table has | the 1000-row cap, and array results carry no `truncated` flag | narrow with the tool filters, or count with `count_rows`             |
| `truncated: true` and short of expected rows          | 1000-row cap                                                  | add `ORDER BY` + `offset`/`limit`, or narrow the predicate           |
| `ORA-01013` / `ORA-03113` / `ORA-03114`               | statement cancelled by timeout or client                      | narrow the query; do not treat as data loss                          |
