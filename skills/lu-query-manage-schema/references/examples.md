# Verified examples - DDL

Oracle 26ai Free, lu-query 2.16.3, 2026-10-18, user `DEVUSER`. All calls returned success lines verbatim.

```json
{"tool": "create_sequence", "args": {"sequence": "SKL_SEQ", "startWith": 1000, "incrementBy": 1, "cache": 20}}
"create_sequence" -> Sequence DEVUSER.SKL_SEQ created.
```

```json
{"tool": "create_index", "args": {"table": "SKL_EMP", "index": "SKL_EMP_EMAIL_IX", "tableSchema": "DEVUSER", "columns": ["EMAIL"], "unique": false}}
"create_index" -> Index DEVUSER.SKL_EMP_EMAIL_IX created on DEVUSER.SKL_EMP.
```

```json
{"tool": "comment_on_table", "args": {"table": "SKL_DEPT", "comment": "Departments fixture for lu-query skill verification"}}
"comment_on_table" -> Comment applied to table DEVUSER.SKL_DEPT
```

```json
{"tool": "comment_on_column", "args": {"table": "SKL_EMP", "column": "EMAIL", "comment": "Duplicate on purpose: exercises find_duplicates"}}
"comment_on_column" -> Comment applied to column DEVUSER.SKL_EMP.EMAIL
```

```json
{"tool": "create_or_replace_view", "args": {"view": "SKL_V_EMP", "selectBody": "SELECT e.EMP_ID, e.EMAIL, d.DEPT_NAME FROM SKL_EMP e LEFT JOIN SKL_DEPT d ON d.DEPT_ID = e.DEPT_ID"}}
"create_or_replace_view" -> View DEVUSER.SKL_V_EMP created (or replaced).
```

```json
{"tool": "create_synonym", "args": {"synonym": "SKL_EMPLOYEES", "targetSchema": "DEVUSER", "targetName": "SKL_EMP", "isPublic": false}}
"create_synonym" -> Synonym DEVUSER.SKL_EMPLOYEES created.
```

```json
{"tool": "create_mview_log", "args": {"table": "SKL_DEPT", "withPrimaryKey": true}}
"create_mview_log" -> Materialized view log created on DEVUSER.SKL_DEPT.
```

Verification after the fact:

```json
{"tool": "list_indexes", "args": {"table": "SKL_EMP"}}
[{"INDEX_NAME":"SKL_EMP_EMAIL_IX","COLUMNS":"EMAIL","UNIQUENESS":"NONUNIQUE","STATUS":"VALID"},
 {"INDEX_NAME":"SYS_C008860","COLUMNS":"EMP_ID","UNIQUENESS":"UNIQUE","STATUS":"VALID"}]
```

The comment is visible through `describe_table` (`COMMENTS` column) and through `USER_TAB_COMMENTS`.

## Without a schema: the session schema is used

`create_sequence` with no `schema` argument and no `ORACLE_DB_SCHEMA` on the server (re-verified 2026-10-18 on 2.16.3):

```json
{ "tool": "create_sequence", "args": { "sequence": "SKL_SEQ2" } }
```

```text
Sequence DEVUSER.SKL_SEQ2 created.
```

The owner comes from the session's `CURRENT_SCHEMA`. Pass `schema` only to create the object in another owner. (Before 2.16.3 this call failed with "create_sequence necesita un schema": the session fallback was broken.)
