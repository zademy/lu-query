# Verified examples - data changes

Oracle 26ai Free, lu-query 2.16.3, 2026-10-18. `SKL_EMP` started this sequence with **6 rows**.

## 1. Preview (nothing executed)

```json
{
  "tool": "execute_dml_preview",
  "args": { "sql": "UPDATE SKL_EMP SET SALARY = SALARY * 1.10 WHERE DEPT_ID = 10" }
}
```

```json
{
  "detectedKind": "UPDATE",
  "table": "SKL_EMP",
  "affectedRowCount": 3,
  "sampleColumns": ["EMP_ID", "DEPT_ID", "EMAIL", "HIRE_DATE", "SALARY"],
  "sampleRows": [
    {
      "EMP_ID": 1,
      "DEPT_ID": 10,
      "EMAIL": "ada@example.com",
      "HIRE_DATE": "2024-01-15T06:00:00.000Z",
      "SALARY": 95000
    },
    {
      "EMP_ID": 2,
      "DEPT_ID": 10,
      "EMAIL": "ada@example.com",
      "HIRE_DATE": "2024-03-01T06:00:00.000Z",
      "SALARY": 88000
    },
    {
      "EMP_ID": 1000,
      "DEPT_ID": 10,
      "EMAIL": "probe@example.com",
      "HIRE_DATE": "2026-02-01T06:00:00.000Z",
      "SALARY": 99000
    }
  ],
  "sampleCount": 3,
  "note": "Dry-run preview: the statement was NOT executed. 3 row(s) would be affected. Call execute_dml to apply, or execute_dml_rollback_first to dry-run the write."
}
```

Note the values are the **current** rows (95000, not 104500).

## 2. Rehearse with rollback

```json
{
  "tool": "execute_dml_rollback_first",
  "args": {
    "sql": "INSERT INTO SKL_EMP (EMP_ID, DEPT_ID, EMAIL, HIRE_DATE, SALARY) VALUES (900, 20, 'rollback@example.com', SYSDATE, 50000)"
  }
}
```

```json
{
  "detectedKind": "INSERT",
  "rowsAffected": 1,
  "rolledBack": true,
  "note": "Statement executed and rolled back; nothing was persisted. Call execute_dml to apply the change."
}
```

Proof it did not persist: `count_rows` returned `{"rowCount":6}` before and after.

## 3. Apply and verify

```json
{
  "tool": "execute_dml",
  "args": {
    "sql": "INSERT INTO SKL_EMP (EMP_ID, DEPT_ID, EMAIL, HIRE_DATE, SALARY) VALUES (901, 20, 'kept@example.com', SYSDATE, 51000)"
  }
}
```

```json
{ "statementKind": "INSERT", "rowsAffected": 1 }
```

Verification, not assumption:

```json
{"tool": "count_rows", "args": {"table": "SKL_EMP"}}
{"schema":"DEVUSER","table":"SKL_EMP","rowCount":7}

{"tool": "run_query", "args": {"sql": "SELECT EMP_ID, EMAIL FROM SKL_EMP WHERE EMP_ID IN (900, 901) ORDER BY EMP_ID"}}
{"columns":["EMP_ID","EMAIL"],"rows":[{"EMP_ID":901,"EMAIL":"kept@example.com"}],"rowCount":1,…}
```

Only 901 exists: 900 was rolled back, 901 committed.

## 4. Keys

```json
{"tool": "find_free_id", "args": {"table": "SKL_EMP", "column": "EMP_ID"}}
{"schema":"DEVUSER","table":"SKL_EMP","column":"EMP_ID","maxRange":1000,"excludeTable":null,"candidateId":6}
```

```json
{"tool": "get_next_sequence_value", "args": {"sequence": "SKL_SEQ"}}
{"schema":"DEVUSER","sequence":"SKL_SEQ","nextValue":1001}
```

`SKL_SEQ` started at 1000 and an earlier procedure call had consumed 1000; this call consumed 1001. Sequence gaps are normal after rollbacks.
