# Tool reference - data changes

## execute_dml_preview

```
execute_dml_preview(sql: string)
-> {"detectedKind":"UPDATE","table":"SKL_EMP","affectedRowCount":3,
    "sampleColumns":["EMP_ID","DEPT_ID","EMAIL","HIRE_DATE","SALARY"],
    "sampleRows":[… up to 3 …],"sampleCount":3,
    "note":"Dry-run preview: the statement was NOT executed. …"}
```

Uses the SQL parser to find the target table and count matching rows; no DML is sent to Oracle.

## execute_dml_rollback_first

```
execute_dml_rollback_first(sql: string)
-> {"detectedKind":"INSERT","rowsAffected":1,"rolledBack":true,
    "note":"Statement executed and rolled back; nothing was persisted. Call execute_dml to apply the change."}
```

Runs the statement inside a transaction and rolls back afterwards (verified: row count unchanged).

## execute_dml

```
execute_dml(sql: string)
-> {"statementKind":"INSERT","rowsAffected":1}
```

Commits through the DataAccess chokepoint. No explicit transaction handle, no undo.

## find_free_id

```
find_free_id(table: string, column: string, maxRange?: number, excludeTable?: string, schema?: string)
-> {"schema":"DEVUSER","table":"SKL_EMP","column":"EMP_ID","maxRange":1000,"excludeTable":null,"candidateId":6}
```

- `maxRange` default 1000, hard cap 10000.
- `excludeTable` ignores ids used by another table (classic `MAX(id)+1` collision case).
- The id is **not reserved**: two concurrent callers can get the same candidate.

## get_next_sequence_value

```
get_next_sequence_value(sequence: string, schema?: string)
-> {"schema":"DEVUSER","sequence":"SKL_SEQ","nextValue":1001}
```

Consumes the value (NEXTVAL). Gaps after rollbacks are expected; never assume contiguity.
