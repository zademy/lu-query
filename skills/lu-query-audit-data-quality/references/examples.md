# Verified examples - data quality

Oracle 26ai Free, lu-query 2.13.0, 2026-10-17. Fixture: `SKL_EMP` holds 5 seeded rows with `EMAIL 'ada@example.com'` twice, one `DEPT_ID=99` (no parent) and one `NULL DEPT_ID`; FK is `ENABLE NOVALIDATE`.

## Exact count

```json
{ "tool": "count_rows", "args": { "table": "SKL_EMP" } }
```

```json
{ "schema": "DEVUSER", "table": "SKL_EMP", "rowCount": 6 }
```

(6 = 5 seeded + 1 inserted by the `call_procedure` example in the PL/SQL skill.)

## Duplicate key candidates

```json
{ "tool": "find_duplicates", "args": { "table": "SKL_EMP", "columns": ["EMAIL"] } }
```

```json
{
  "schema": "DEVUSER",
  "table": "SKL_EMP",
  "columns": ["EMAIL"],
  "minCount": 2,
  "groups": [{ "EMAIL": "ada@example.com", "CNT": 2, "SAMPLE_ROWID": "AAAR9pAAAAAAAREAAA" }]
}
```

Fetch the representative row with `run_query`: `SELECT * FROM SKL_EMP WHERE ROWID = 'AAAR9pAAAAAAAREAAA'`.

## Orphan rows under a legacy FK

```json
{ "tool": "validate_fk_integrity", "args": { "table": "SKL_EMP" } }
```

```json
[
  {
    "constraint_name": "SKL_EMP_DEPT_FK",
    "child_columns": "DEPT_ID",
    "parent_owner": "DEVUSER",
    "parent_table": "SKL_DEPT",
    "parent_columns": "DEPT_ID",
    "orphan_count": 1
  }
]
```

The orphan is `EMP_ID=4` with `DEPT_ID=99`. Confirm with:

```json
{
  "tool": "run_query",
  "args": {
    "sql": "SELECT EMP_ID, DEPT_ID FROM SKL_EMP e WHERE NOT EXISTS (SELECT 1 FROM SKL_DEPT d WHERE d.DEPT_ID = e.DEPT_ID)"
  }
}
```

## Why the FK must be NOVALIDATE for this to be interesting

An FK created as `ENABLE VALIDATE` guarantees no orphans, so `orphan_count` is 0 by construction. Legacy loads use `ENABLE NOVALIDATE` (or `DISABLE`), which is exactly the situation this tool exists for. Verify with `list_constraints` before concluding "no problem".
