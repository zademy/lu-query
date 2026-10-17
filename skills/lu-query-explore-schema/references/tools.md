# Tool reference - schema exploration

`*` marks a required argument. Every tool accepts an optional `schema` where shown; see the resolution note in `SKILL.md`.

## Core

| Tool              | Signature                   | Result                                                                       |
| ----------------- | --------------------------- | ---------------------------------------------------------------------------- |
| `test_connection` | -                           | `{databaseVersion, databaseName, currentUser, currentSchema, instanceName}`  |
| `list_schemas`    | -                           | rows `{SCHEMA_NAME}`                                                         |
| `list_tables`     | `schema?`, `namePattern?`   | rows `{SCHEMA_NAME, TABLE_NAME}`                                             |
| `list_views`      | `schema?`, `namePattern?`   | rows `{SCHEMA_NAME, VIEW_NAME}`                                              |
| `search_objects`  | `namePattern*`, `type?`     | rows `{SCHEMA_NAME, OBJECT_NAME, OBJECT_TYPE, STATUS}`                       |
| `list_objects`    | `schema?`, `type?`          | rows keyed by object class (`OBJECT_NAME`, `OBJECT_TYPE`, …)                 |
| `describe_table`  | `table*`, `schema?`         | rows `{COLUMN_NAME, DATA_TYPE, NULLABLE, DATA_DEFAULT, COMMENTS, COLUMN_ID}` |
| `table_exists`    | `table*`, `schema?`         | `true` / `false` (ALL_TABLES only)                                           |
| `get_ddl`         | `name*`, `type*`, `schema?` | DDL text (string, via `DBMS_METADATA`)                                       |

## Catalog

| Tool                      | Signature                          | Notes                                                                             |
| ------------------------- | ---------------------------------- | --------------------------------------------------------------------------------- |
| `list_indexes`            | `table*`                           | `{INDEX_NAME, COLUMNS, UNIQUENESS, STATUS}`; system indexes appear too (`SYS_C…`) |
| `list_constraints`        | `table*`                           | PK/FK/unique/check with columns and references                                    |
| `list_sequences`          | `schema?`                          | range, increment, last number, cycle, cache                                       |
| `get_sequence_info`       | `sequence*`                        | single sequence; `LAST_NUMBER` is cached, not necessarily the next value          |
| `list_triggers`           | `schema?`                          | trigger name, type, event, table, status                                          |
| `list_procedures`         | `schema?`, `namePattern?`, `type?` | procedures, functions, packages, types                                            |
| `list_synonyms`           | `schema?`, `namePattern?`          | private/public, resolved target, DB link                                          |
| `list_db_links`           | -                                  | links visible to the user                                                         |
| `list_directories`        | -                                  | directory objects and paths                                                       |
| `list_external_tables`    | `schema?`                          | driver, directory, reject limit                                                   |
| `list_materialized_views` | `schema?`, `namePattern?`          | refresh mode/method, staleness                                                    |
| `list_mview_logs`         | `schema?`                          | mview logs per table                                                              |
| `list_partitions`         | `table*`                           | high value, rows, compression, last analyzed                                      |
| `list_ind_partitions`     | `table*`                           | index partition status and leaf blocks                                            |
| `list_subpartitions`      | `table*`                           | composite-partition subpartitions                                                 |
| `list_lob_columns`        | `table*`                           | segment, index, caching, SECUREFILE, retention                                    |
| `list_types`              | `schema?`                          | typecode, attributes, methods, supertype                                          |
| `list_invalid_objects`    | `schema?`, `type?`                 | objects with `STATUS = INVALID`                                                   |
| `list_dependencies`       | `name*`, `type?`                   | objects the given object depends on                                               |
| `list_scheduler_jobs`     | `schema?`                          | state, run/failure counts, next run                                               |
| `list_scheduler_job_runs` | `limit?`, `jobName?`               | duration, error code, output                                                      |

## Graphs

| Tool                   | Signature                   | Result                    |
| ---------------------- | --------------------------- | ------------------------- |
| `get_fk_graph`         | `table?`, `schema?`         | `{mermaid: "graph LR …"}` |
| `get_dependency_graph` | `name?`, `type?`, `schema?` | `{mermaid: "graph LR …"}` |

Graph output uses `graph LR` with UPPERCASE node ids (Oracle returns uppercase identifiers); a lowercase node id produces an empty edge set.

## Resources (read, no tool call)

| URI                                            | Content                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| `oracle://schema/{schema}/table/{table}`       | Markdown column report for a table or view                               |
| `oracle://schema/{schema}/object/{object}/ddl` | DDL of any object; type auto-detected                                    |
| `oracle://schema/{schema}/plsql/{object}`      | PL/SQL source (see [lu-query-use-plsql](../lu-query-use-plsql/SKILL.md)) |
| `oracle://audit/session/{id}`                  | audit Markdown of a session; `{id}` accepts `current`                    |
