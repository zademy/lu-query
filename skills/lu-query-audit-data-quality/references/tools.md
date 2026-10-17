# Tool reference - data quality

## count_rows

```
count_rows(table: string, schema?: string)
-> {"schema":"DEVUSER","table":"SKL_EMP","rowCount":6}
```

Exact count from the dictionary; no statement is sent for the count itself.

## find_duplicates

```
find_duplicates(table: string, columns: string[], minCount?: number, schema?: string)
-> {"schema":"DEVUSER","table":"SKL_EMP","columns":["EMAIL"],"minCount":2,
    "groups":[{"EMAIL":"ada@example.com","CNT":2,"SAMPLE_ROWID":"AAAR9pAAAAAAAREAAA"}]}
```

- `columns` is an **array** (composite keys supported).
- `NULL` groups are omitted.
- `SAMPLE_ROWID` lets you fetch one representative row: `SELECT * FROM t WHERE ROWID = :rid`.

## validate_fk_integrity

```
validate_fk_integrity(table: string, constraint?: string, schema?: string)
-> [{"constraint_name":"SKL_EMP_DEPT_FK","child_columns":"DEPT_ID","parent_owner":"DEVUSER",
     "parent_table":"SKL_DEPT","parent_columns":"DEPT_ID","orphan_count":1}]
```

- Without `constraint`, every FK on the table is checked.
- `child_columns` / `parent_columns` are comma-joined for composite keys.
- Composite-key orphans are matched column by column (a row counts as an orphan only if the whole tuple is missing).
