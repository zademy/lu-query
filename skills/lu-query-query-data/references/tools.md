# Tool reference - querying data

## run_query

```
run_query(sql: string, offset?: number, limit?: number)
```

- `sql` (required): exactly one `SELECT`. Verbatim to Oracle - no rewriting. CTEs allowed.
- `offset`, `limit`: 0-based pagination, both optional. `limit` is clamped to 1..1000; the hard row cap is 1000.
- Generated SQL (verified in a session audit entry): with `offset=1, limit=2` on `SELECT * FROM EMPLOYEES ORDER BY emp_id` the server ran
  `SELECT * FROM ( SELECT * FROM EMPLOYEES ORDER BY emp_id ) OFFSET 1 ROWS FETCH NEXT 2 ROWS ONLY`.

Returns:

```json
{
  "columns": ["EMP_ID", "EMAIL", "SALARY"],
  "rows": [{ "EMP_ID": 1, "EMAIL": "ada@example.com", "SALARY": 95000 }],
  "rowCount": 1,
  "truncated": false,
  "rowLimit": 1000,
  "offset": 0,
  "limit": 1000
}
```

- `truncated: true` means the row cap or your `limit` cut the result short.
- `rowLimit` is the cap in force for the call.

## get_sample_data

```
get_sample_data(table: string, rows?: number, schema?: string)
```

- `rows`: default 10, capped at 1000.
- Emits MCP progress notifications (10 → 90) when the client supports progress tokens.
- Needs a schema resolution: pass `schema` or set `ORACLE_DB_SCHEMA`.

Returns the same envelope as `run_query`.

## Related, deliberately not in this skill

`count_rows`, `find_duplicates`, `validate_fk_integrity`, `find_free_id`, `get_next_sequence_value` → [lu-query-audit-data-quality](../lu-query-audit-data-quality/SKILL.md) and [lu-query-plan-data-changes](../lu-query-plan-data-changes/SKILL.md).
