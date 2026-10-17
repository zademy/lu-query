# Verified examples - schema exploration

Oracle Database 26ai Free (23.26.0.0.0), lu-query 2.13.0, MCP over stdio, 2026-10-17. Outputs quoted verbatim (trimmed where noted). Fixtures: see `skills/README.md`.

## Find tables by pattern

```json
{ "tool": "list_tables", "args": { "namePattern": "SKL%" } }
```

```json
[
  { "SCHEMA_NAME": "DEVUSER", "TABLE_NAME": "SKL_DEPT" },
  { "SCHEMA_NAME": "DEVUSER", "TABLE_NAME": "SKL_EMP" }
]
```

## Find any object type, with compile status

```json
{ "tool": "search_objects", "args": { "namePattern": "SKL%" } }
```

```json
[
  {
    "SCHEMA_NAME": "DEVUSER",
    "OBJECT_NAME": "SKL_DEPT_EMPS",
    "OBJECT_TYPE": "FUNCTION",
    "STATUS": "VALID"
  },
  {
    "SCHEMA_NAME": "DEVUSER",
    "OBJECT_NAME": "SKL_EMP_EMAIL_IX",
    "OBJECT_TYPE": "INDEX",
    "STATUS": "VALID"
  },
  {
    "SCHEMA_NAME": "DEVUSER",
    "OBJECT_NAME": "SKL_ADD_EMP",
    "OBJECT_TYPE": "PROCEDURE",
    "STATUS": "VALID"
  },
  {
    "SCHEMA_NAME": "DEVUSER",
    "OBJECT_NAME": "SKL_SEQ",
    "OBJECT_TYPE": "SEQUENCE",
    "STATUS": "VALID"
  },
  { "SCHEMA_NAME": "DEVUSER", "OBJECT_NAME": "SKL_EMP", "OBJECT_TYPE": "TABLE", "STATUS": "VALID" }
]
```

## Columns, nullability and comments

```json
{ "tool": "describe_table", "args": { "table": "SKL_EMP" } }
```

```json
[
  {
    "COLUMN_NAME": "EMP_ID",
    "DATA_TYPE": "NUMBER(6,)",
    "NULLABLE": "N",
    "DATA_DEFAULT": null,
    "COMMENTS": null,
    "COLUMN_ID": 1
  },
  {
    "COLUMN_NAME": "DEPT_ID",
    "DATA_TYPE": "NUMBER(4,)",
    "NULLABLE": "Y",
    "DATA_DEFAULT": null,
    "COMMENTS": null,
    "COLUMN_ID": 2
  },
  {
    "COLUMN_NAME": "EMAIL",
    "DATA_TYPE": "VARCHAR2(120)",
    "NULLABLE": "Y",
    "DATA_DEFAULT": null,
    "COMMENTS": "Duplicate on purpose: exercises find_duplicates",
    "COLUMN_ID": 3
  },
  {
    "COLUMN_NAME": "HIRE_DATE",
    "DATA_TYPE": "DATE",
    "NULLABLE": "N",
    "DATA_DEFAULT": null,
    "COMMENTS": null,
    "COLUMN_ID": 4
  },
  {
    "COLUMN_NAME": "SALARY",
    "DATA_TYPE": "NUMBER(10,2)",
    "NULLABLE": "N",
    "DATA_DEFAULT": null,
    "COMMENTS": null,
    "COLUMN_ID": 5
  }
]
```

`NUMBER(6,)` is how the driver renders precision without scale; `NUMBER(10,2)` keeps it. Not an error.

## DDL of an object

```json
{ "tool": "get_ddl", "args": { "name": "SKL_DEPT", "type": "TABLE" } }
```

```text
  CREATE TABLE "DEVUSER"."SKL_DEPT"
   (	"DEPT_ID" NUMBER(4,0),
	"DEPT_NAME" VARCHAR2(40) NOT NULL ENABLE,
	"BUDGET" NUMBER(12,2),
	 PRIMARY KEY ("DEPT_ID")
  USING INDEX PCTFREE 10 …
```

Read as a JSON string, so newlines arrive escaped - `DBMS_METADATA` output is complete (fetched as CLOB string), not truncated at 4000 characters.

## Indexes and keys on a table

```json
{ "tool": "list_indexes", "args": { "table": "SKL_EMP" } }
```

```json
[
  {
    "INDEX_NAME": "SKL_EMP_EMAIL_IX",
    "COLUMNS": "EMAIL",
    "UNIQUENESS": "NONUNIQUE",
    "STATUS": "VALID"
  },
  { "INDEX_NAME": "SYS_C008860", "COLUMNS": "EMP_ID", "UNIQUENESS": "UNIQUE", "STATUS": "VALID" }
]
```

`list_constraints` returns the PK, the FK `SKL_EMP_DEPT_FK` (child `DEPT_ID` → `SKL_DEPT.DEPT_ID`) and the check constraints, each with its columns.

## Foreign-key graph

```json
{ "tool": "get_fk_graph", "args": { "table": "SKL_EMP" } }
```

```json
{
  "mermaid": "graph LR\n  DEVUSER.SKL_EMP[\"SKL_EMP\"] -->|DEPT_ID| DEVUSER.SKL_DEPT[\"SKL_DEPT\"]\n  classDef ..."
}
```

Use the `mermaid` field as-is; it is valid Mermaid text.

## Sequence metadata vs. the next value

```json
{ "tool": "get_sequence_info", "args": { "sequence": "SKL_SEQ" } }
```

```json
{
  "SCHEMA_NAME": "DEVUSER",
  "SEQUENCE_NAME": "SKL_SEQ",
  "MIN_VALUE": 1,
  "MAX_VALUE": 1e28,
  "INCREMENT_BY": 1,
  "LAST_NUMBER": 1020,
  "CYCLE_FLAG": "N",
  "CACHE_SIZE": 20,
  "ORDER_FLAG": "N"
}
```

`LAST_NUMBER` is the cached high-water mark, not the next value handed out. To consume a value on purpose use [lu-query-plan-data-changes](../lu-query-plan-data-changes/SKILL.md) → `get_next_sequence_value`.

## Resource read instead of a tool call

```text
oracle://schema/DEVUSER/table/SKL_EMP          -> Markdown column report
oracle://schema/DEVUSER/object/SKL_DEPT/ddl    -> DDL text
```

## Not executed here

`list_db_links`, `list_directories`, `list_external_tables`, `list_materialized_views`, `list_mview_logs`, `list_lob_columns`, `list_ind_partitions`, `list_subpartitions`, `list_scheduler_jobs`, `list_scheduler_job_runs` were exercised by the project's integration suite (returns rows or `[]` on this fixture) but are not quoted here.
