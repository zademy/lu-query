# Verified examples - incident triage

Oracle 26ai Free, lu-query 2.13.0, 2026-10-17, user `DEVUSER` with `SELECT ANY DICTIONARY` granted (via `scripts/test-grants-performance.sql`) but **without** `SELECT_CATALOG_ROLE`.

## Health first - and what DEGRADED means

```json
{ "tool": "oracle_mcp_health_report", "args": {} }
```

```json
{
  "overallStatus": "DEGRADED",
  "databaseName": "FREEPDB1",
  "checks": [
    { "name": "database-connectivity", "status": "PASS", "detail": "Connection established" },
    {
      "name": "database-version",
      "status": "PASS",
      "detail": "Oracle AI Database 26ai Free Release 23.26.3.0.0 …"
    },
    {
      "name": "catalog-role",
      "status": "WARN",
      "detail": "SELECT_CATALOG_ROLE not found; dictionary views may be restricted"
    },
    {
      "name": "invalid-objects",
      "status": "PASS",
      "detail": "No invalid objects in current schema"
    },
    {
      "name": "server-config",
      "status": "PASS",
      "detail": "max-rows=1000, query-timeout=120s, audit=enabled"
    }
  ]
}
```

`DEGRADED` came solely from the catalog-role warning - the V$ tools still worked because of the `SELECT ANY DICTIONARY` grant. Report the warning, do not panic.

## Who is active

```json
{ "tool": "list_active_sessions", "args": {} }
```

```json
[
  {
    "SID": 1,
    "SERIAL_NUM": 29101,
    "USERNAME": null,
    "MACHINE": "oracle-db",
    "PROGRAM": "oracle@oracle-db (PMON)",
    "STATUS": "ACTIVE",
    "SERVER": "DEDICATED",
    "SCHEMANAME": "SYS",
    "OSUSER": "oracle",
    "SECONDS_SINCE_LAST_CALL": 13655,
    "MODULE": null
  }
]
```

Background processes appear with `USERNAME: null`. For application sessions add `{"username": "APP_USER"}`.

## Blockers, locks, waits (idle instance)

```json
{"tool": "list_blocked_sessions", "args": {}}
[]
```

`[]` is the answer "nobody is blocked right now" - say exactly that.

## Most expensive SQL

```json
{ "tool": "list_top_sql", "args": { "limit": 2 } }
```

Returns the top statements by `buffer_gets` with `SQL_ID`, `SQL_TEXT`, executions and buffers. Pass `orderBy: "elapsed_time"` for slow statements instead of busy ones.

## Instance, database, parameter

```json
{"tool": "get_instance_info", "args": {}}
{"tool": "get_database_info", "args": {}}
{"tool": "get_parameter", "args": {"name": "open_cursors"}}
{"tool": "list_datafile_io", "args": {}}
```

`get_parameter` answers from `V$PARAMETER` using `display_value` (e.g. `300` for `OPEN_CURSORS`), which is what users expect to see; `list_datafile_io` returned e.g. `{"FILE_ID":12,"FILE_NAME":"/opt/oracle/oradata/FREE/FREEPDB1/system01.dbf","SIZE_MB":300,"PHYSICAL_READS":7310,…}`.

## Standing of the connecting user

```json
{"tool": "get_session_privs", "args": {}}
{"tool": "get_session_roles", "args": {}}
```

Rows show granted vs effective privileges. Use them to explain why a V$ tool answers `ORA-00942`.

## Not executed here

`get_session_sql_text`, `get_wait_events`, `get_session_longops`, `get_system_stats`, `get_db_time_model` were executed against this idle instance and returned valid rows/empty sets (see the project integration suite); they are not quoted here because they carry instance-specific noise.
