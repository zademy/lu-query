# Verified examples - querying data

Oracle 26ai Free, lu-query 2.13.0, MCP over stdio, 2026-10-17. Fixtures: `skills/README.md`. Outputs verbatim.

## Paged read

```json
{
  "tool": "run_query",
  "args": { "sql": "SELECT EMP_ID, EMAIL, SALARY FROM SKL_EMP ORDER BY EMP_ID", "limit": 3 }
}
```

```json
{
  "columns": ["EMP_ID", "EMAIL", "SALARY"],
  "rows": [
    { "EMP_ID": 1, "EMAIL": "ada@example.com", "SALARY": 95000 },
    { "EMP_ID": 2, "EMAIL": "ada@example.com", "SALARY": 88000 },
    { "EMP_ID": 3, "EMAIL": "grace@example.com", "SALARY": 72000 }
  ],
  "rowCount": 3,
  "truncated": true,
  "rowLimit": 1000,
  "offset": 0,
  "limit": 3
}
```

`truncated: true` here only means `limit` was smaller than the result - expected, not an error.

## Ask the session, not your memory

```json
{
  "tool": "run_query",
  "args": {
    "sql": "SELECT PARAMETER, VALUE FROM NLS_SESSION_PARAMETERS WHERE PARAMETER = 'NLS_DATE_FORMAT'"
  }
}
```

```json
{
  "columns": ["PARAMETER", "VALUE"],
  "rows": [{ "PARAMETER": "NLS_DATE_FORMAT", "VALUE": "DD-MON-RR" }],
  "rowCount": 1,
  "truncated": false,
  "rowLimit": 1000,
  "offset": 0,
  "limit": 1000
}
```

Useful before any date-literal comparison: implicit `DATE` conversions follow this format, not ISO.

## Sample preview (dates come back UTC-ISO)

```json
{ "tool": "get_sample_data", "args": { "table": "SKL_EMP", "rows": 2 } }
```

```json
{
  "columns": ["EMP_ID", "DEPT_ID", "EMAIL", "HIRE_DATE", "SALARY"],
  "rows": [
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
    }
  ],
  "rowCount": 2,
  "truncated": true,
  "rowLimit": 1000,
  "offset": 0,
  "limit": 2
}
```

`HIRE_DATE` was stored as `DATE '2024-01-15'`; the `Z` suffix is the client's UTC serialisation.

## Session schema without configuration

```json
{
  "tool": "run_query",
  "args": { "sql": "SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS S FROM DUAL" }
}
```

```json
{
  "columns": ["S"],
  "rows": [{ "S": "DEVUSER" }],
  "rowCount": 1,
  "truncated": false,
  "rowLimit": 1000,
  "offset": 0,
  "limit": 1000
}
```

`run_query` needs no schema configuration; object-scoped tools do (see [lu-query-explore-schema](../lu-query-explore-schema/SKILL.md)).
