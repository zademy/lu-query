# Tool reference - incident triage

## oracle_mcp_health_report

```
-> {"overallStatus":"DEGRADED","databaseName":"FREEPDB1",
    "checks":[{"name":"database-connectivity","status":"PASS","detail":"Connection established"},
              {"name":"database-version","status":"PASS","detail":"Oracle AI Database 26ai Free …"},
              {"name":"catalog-role","status":"WARN","detail":"SELECT_CATALOG_ROLE not found; dictionary views may be restricted"},
              {"name":"invalid-objects","status":"PASS","detail":"No invalid objects in current schema"},
              {"name":"server-config","status":"PASS","detail":"max-rows=1000, query-timeout=120s, audit=enabled"}]}
```

`overallStatus` is `UP`, `DEGRADED` (a WARN) or `DOWN` (connectivity failed). The `server-config` check also reports the real audit state (enabled / disabled by config / disabled after I/O errors).

## Sessions

```
list_active_sessions(username?, sid?)   -> rows: SID, SERIAL_NUM, USERNAME, MACHINE, PROGRAM, STATUS, SCHEMANAME, MODULE, SECONDS_SINCE_LAST_CALL, LOGON_TIME
list_blocked_sessions()                 -> rows: blocked SID/USER, blocking SID/USER, wait event
list_locks()                            -> rows: SID, LOCKED_USER, OBJECT_OWNER/NAME/TYPE, LOCK_TYPE, HELD_MODE, REQUESTED_MODE
get_session_sql_text(sid, serialNum)    -> SQL text of that session
get_wait_events(sid?, waitClass?)       -> current waits (V$SESSION_WAIT)
get_session_longops(sid?)               -> long operations with progress (V$SESSION_LONGOPS)
```

Use `SID` + `SERIAL_NUM` from `list_active_sessions` as the key pair for per-session tools.

## Workload

```
list_top_sql(limit?, orderBy?)  # orderBy: buffer_gets (default) | disk_reads | elapsed_time | executions | cpu_time
```

## System

```
get_instance_info()   -> instance, host, version, startup, status, archiver
get_database_info()   -> name, creation, log mode, open mode, role
get_parameter(name?)  -> one or all init parameters (display_value)
get_system_stats()    -> V$SYSSTAT rows: STAT_ID, NAME, CLASS, VALUE
get_db_time_model()   -> V$SYS_TIME_MODEL: DB CPU, DB time, PL/SQL times
list_datafile_io()    -> FILE_ID, FILE_NAME, STATUS, SIZE_MB, PHYSICAL_READS/WRITES, READ/WRITE_TIME_MS
```

## Session privileges

```
get_session_privs()   -> granted vs effective system privileges
get_session_roles()   -> enabled roles with admin/default flags
```

If the V$ tools fail, these two tell you whether the connecting user has the grants.
