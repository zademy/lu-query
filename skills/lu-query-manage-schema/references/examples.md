# Verified examples - DDL

Oracle 26ai Free, lu-query 2.13.0, 2026-10-17, user `DEVUSER`. All calls returned success lines verbatim.

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

## Failure observed (expected, useful)

`create_sequence` without a schema (server has no `ORACLE_DB_SCHEMA`):

```text
create_sequence necesita un schema: pasa el argumento schema o define ORACLE_DB_SCHEMA
```

Pass `schema` or set the env var once; this is the same up-front check every object-scoped tool performs.
