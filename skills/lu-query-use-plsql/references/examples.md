# Verified examples - PL/SQL

Oracle 26ai Free, lu-query 2.13.0, 2026-10-17. Programs: `SKL_ADD_EMP(p_email IN VARCHAR2, p_salary IN NUMBER, p_hire_date IN DATE, o_emp_id OUT NUMBER)` and `SKL_DEPT_EMPS(p_dept_id IN NUMBER) RETURN SYS_REFCURSOR`.

## Inspect a procedure

```json
{ "tool": "describe_plsql", "args": { "name": "SKL_ADD_EMP", "type": "PROCEDURE" } }
```

```json
{
  "schema": "DEVUSER",
  "name": "SKL_ADD_EMP",
  "type": "PROCEDURE",
  "arguments": [
    {
      "ARGUMENT_NAME": "P_EMAIL",
      "DATA_TYPE": "VARCHAR2",
      "IN_OUT": "IN",
      "POSITION": 1,
      "DEFAULTED": "N"
    },
    {
      "ARGUMENT_NAME": "P_SALARY",
      "DATA_TYPE": "NUMBER",
      "IN_OUT": "IN",
      "POSITION": 2,
      "DEFAULTED": "N"
    },
    {
      "ARGUMENT_NAME": "P_HIRE_DATE",
      "DATA_TYPE": "DATE",
      "IN_OUT": "IN",
      "POSITION": 3,
      "DEFAULTED": "N"
    },
    {
      "ARGUMENT_NAME": "O_EMP_ID",
      "DATA_TYPE": "NUMBER",
      "IN_OUT": "OUT",
      "POSITION": 4,
      "DEFAULTED": "N"
    }
  ],
  "source": "PROCEDURE SKL_ADD_EMP (\n  p_email IN VARCHAR2,\n  p_salary IN NUMBER,\n  p_hire_date IN DATE,\n  o_emp_id OUT NUMBER\n) IS\nBEGIN\n  o_emp_i…"
}
```

## Call it with an OUT parameter (working form)

```json
{
  "tool": "call_procedure",
  "args": {
    "name": "SKL_ADD_EMP",
    "args": "[{\"name\":\"P_EMAIL\",\"direction\":\"IN\",\"dataType\":\"VARCHAR2\",\"value\":\"probe@example.com\"},{\"name\":\"P_SALARY\",\"direction\":\"IN\",\"dataType\":\"NUMBER\",\"value\":99000},{\"name\":\"P_HIRE_DATE\",\"direction\":\"IN\",\"dataType\":\"VARCHAR2\",\"value\":\"01-FEB-2026\"},{\"name\":\"O_EMP_ID\",\"direction\":\"OUT\",\"dataType\":\"NUMBER\"}]"
  }
}
```

```json
{ "outParams": { "O_EMP_ID": 1000 }, "returnValue": null, "cursorResult": null }
```

The insert committed (the row `EMP_ID=1000, probe@example.com` shows up in later reads and in `execute_dml_preview` samples).

### Why the date looks "wrong-typed" - and works

Same call with `{"dataType":"DATE","value":"2026-02-01 00:00:00"}` (and with `TIMESTAMP`, and with `TO_DATE('2026-02-01','YYYY-MM-DD')` as the value) all failed:

```text
Oracle error: Oracle rechazó la llamada: ORA-01861 ORA-01861: literal does not match format string
ORA-06512: at line 1
```

`SELECT VALUE FROM NLS_SESSION_PARAMETERS WHERE PARAMETER='NLS_DATE_FORMAT'` returned `DD-MON-RR`, which is why `01-FEB-2026` is the value that binds.

## Cursor-returning function (needs `returnType`)

```json
{
  "tool": "call_procedure",
  "args": {
    "name": "SKL_DEPT_EMPS",
    "isFunction": true,
    "returnType": "REF CURSOR",
    "args": "[{\"name\":\"P_DEPT_ID\",\"direction\":\"IN\",\"dataType\":\"NUMBER\",\"value\":10}]"
  }
}
```

```json
{
  "outParams": {},
  "returnValue": null,
  "cursorResult": [
    { "EMP_ID": 1, "EMAIL": "ada@example.com", "SALARY": 95000 },
    { "EMP_ID": 2, "EMAIL": "ada@example.com", "SALARY": 88000 }
  ]
}
```

Without `returnType`, Oracle answers `PLS-00382: expression is of wrong type / PL/SQL: Statement ignored`.

## Non-scalar argument: actionable rejection

```json
{
  "tool": "call_procedure",
  "args": {
    "name": "SKL_ADD_EMP",
    "args": "[{\"name\":\"P_FLAG\",\"direction\":\"IN\",\"dataType\":\"BOOLEAN\",\"value\":true}]"
  }
}
```

```text
PL/SQL argument 'P_FLAG' of type 'BOOLEAN' is not bindable via JDBC on Oracle 19c. Create a wrapper subprogram that exposes scalar SQL types instead (for example a NUMBER-to-BOOLEAN wrapper: PROCEDURE wrap(n NUMBER) IS BEGIN proc(n <> 0); END;).
```

## Compile status

```json
{"tool": "get_plsql_errors", "args": {"name": "SKL_ADD_EMP"}}
[]
```
