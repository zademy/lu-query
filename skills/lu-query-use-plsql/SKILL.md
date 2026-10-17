---
name: lu-query-use-plsql
description: Use lu-query to inspect and call Oracle PL/SQL - describe_plsql for arguments and source, call_procedure for procedures/functions/package subprograms with IN/OUT/INOUT parameters and SYS_REFCURSOR results, get_plsql_errors for compile failures. Use when a business operation lives in PL/SQL rather than in a table.
compatibility: Requires the lu-query MCP server connected over stdio and GRANT EXECUTE on the target program.
---

# Use PL/SQL with lu-query

## When to use

- "Run `ADD_EMPLOYEE`", "what does `GET_EMPLOYEE_COUNT` return?", "this package body is broken."

## When not to use

- Plain SQL over tables → [lu-query-query-data](../lu-query-query-data/SKILL.md).
- Creating packages/procedures (no tool writes PL/SQL source) → use sqlplus or a migration tool.

## Workflow

1. **Read before calling.** `describe_plsql` (or resource `oracle://schema/{s}/plsql/{o}`) returns the argument list with `IN_OUT` and direction plus the full source. Never guess an argument list.
2. **Check it compiles.** `get_plsql_errors` returns `[]` when valid, or Oracle's error rows otherwise.
3. **Build the args JSON.** `args` is a **JSON string**: an array of `{"name","direction","dataType","value"}` objects in the exact parameter order. `direction` defaults to `IN`.
4. **Call.** `call_procedure`. Set `isFunction: true` for functions. For functions or any cursor parameter, also set `returnType` (see gotcha 2).
5. **Read the envelope.** `{outParams, returnValue, cursorResult}` - `outParams` holds OUT/INOUT values by name, `cursorResult` holds the first cursor's rows as an array.
6. **Verify side effects.** `call_procedure` commits like `execute_dml`. Re-read the affected table to prove the write.

## Verified gotchas (tested 2026-10-17 on 26ai Free)

1. **DATE and TIMESTAMP parameters: pass the value as a string in the session's `NLS_DATE_FORMAT`, not as `dataType: "DATE"` / `"TIMESTAMP"`.** An ISO value (`2026-02-01`) with `dataType: "DATE"` fails with `ORA-01861: literal does not match format string`; so does `dataType: "TIMESTAMP"` and `TO_DATE('...')` inside the value. What works: `{"dataType":"VARCHAR2","value":"01-FEB-2026"}` - i.e. `DD-MON-RR`. Check the session format first with `run_query` on `NLS_SESSION_PARAMETERS`.
2. **REF CURSOR results need `returnType`.** For a function returning a cursor, pass `returnType: "REF CURSOR"`. Without it Oracle answers `PLS-00382: expression is of wrong type`. The rows then appear in `cursorResult`.
3. **`BOOLEAN`, `RECORD`, `TABLE`, `VARRAY` and `OBJECT` arguments are rejected** with guidance: create a scalar wrapper subprogram. This is a hard boundary, not a retryable error.
4. `get_plsql_errors` on a valid object returns `[]`.

## Tool reference

| Tool               | Signature                                                               | Returns                                                                                              |
| ------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `describe_plsql`   | `name*`, `type?`, `schema?`                                             | `{schema, name, type, arguments: [{ARGUMENT_NAME, DATA_TYPE, IN_OUT, POSITION, DEFAULTED}], source}` |
| `call_procedure`   | `name*`, `args*` (JSON string), `isFunction?`, `returnType?`, `schema?` | `{outParams, returnValue, cursorResult}`                                                             |
| `get_plsql_errors` | `name?`, `type?`, `schema?`                                             | array of Oracle error rows (empty when valid)                                                        |

Details: `references/tools.md`. Verified transcripts: `references/examples.md`.

## Safety

- `call_procedure` **commits**. It is the write path for business logic; get approval before calling anything that mutates.
- `EXECUTE` grants are the barrier - if Oracle refuses, the fix is a grant, not a workaround.

## Failure recovery

| Symptom                    | Cause                                | Action                                     |
| -------------------------- | ------------------------------------ | ------------------------------------------ |
| `ORA-01861`                | ISO string bound to a DATE parameter | re-send as `VARCHAR2` in `NLS_DATE_FORMAT` |
| `PLS-00382`                | cursor function without `returnType` | add `returnType: "REF CURSOR"`             |
| `ORA-06550` other          | signature mismatch                   | re-run `describe_plsql`; match names/order |
| `is not bindable via JDBC` | non-scalar type                      | write a scalar wrapper (PL/SQL side)       |
| `ORA-01031`                | no `GRANT EXECUTE`                   | request the grant                          |
