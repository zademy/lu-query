---
name: lu-query-triage-incident
description: Use lu-query to triage an Oracle database incident - oracle_mcp_health_report for a readiness overview, list_active_sessions/list_blocked_sessions/list_locks/get_wait_events/get_session_longops for live sessions, get_session_sql_text and list_top_sql for what is running and what is expensive, get_instance_info/get_database_info/get_parameter/get_system_stats/get_db_time_model/list_datafile_io for the system, plus get_session_privs and get_session_roles.
compatibility: Requires the lu-query MCP server connected over stdio; V$ tools need SELECT ANY DICTIONARY or an equivalent grant on the database user.
---

# Triage incidents with lu-query

## When to use

- "Is the database healthy?", "who is blocking whom?", "what is the database busy with?", "which session runs this SQL?"

## When not to use

- You want to optimise one statement → [lu-query-tune-sql](../lu-query-tune-sql/SKILL.md).

## Workflow

1. **Start with the health report.** `oracle_mcp_health_report` gives connectivity, version, catalog role, invalid objects, server config and audit state in one call. Read `overallStatus` (`UP` / `DEGRADED` / `DOWN`) and then the individual `checks` - a `WARN` on `catalog-role` explains later `ORA-00942`s on dictionary views.
2. **Who is running what.** `list_active_sessions` (optionally filtered by `username`/`sid`), `get_session_longops` for long operations with progress.
3. **Who is waiting on whom.** `list_blocked_sessions` (with blocker sid/user), then `list_locks` for the mode and object, and `get_wait_events` for the current wait class.
4. **What is expensive.** `get_session_sql_text` (needs `sid` + `serialNum` from `list_active_sessions`) or `list_top_sql` ordered by `buffer_gets` (default) or `disk_reads` / `elapsed_time` / `executions` / `cpu_time`.
5. **If the instance looks wrong.** `get_instance_info`, `get_database_info`, `get_parameter` (e.g. `open_cursors`), `get_system_stats`, `get_db_time_model`, `list_datafile_io`.
6. **Check your own standing.** `get_session_privs` and `get_session_roles` - the tools' own reach depends on them, so failures of the V$ tools are often a grants problem, not a database problem.

## Reading results correctly

- Every V$ value is a string or number from the instance; empty arrays mean "nothing matches right now", not "tool broken".
- `list_active_sessions` includes background processes (`PMON`, `DBRMON`…) with `USERNAME: null`. Filter by `username` for application sessions.
- `get_session_sql_text` requires BOTH `sid` and `serialNum` - copy them from `list_active_sessions`, do not guess.
- `LIKELY_UNUSED` / statistics from `list_unused_indexes` belong to the tuning skill, not here.

## Missing grants

If the V$ tools answer `ORA-00942` or `ORA-01031`, the server returns a hint to grant `SELECT ANY DICTIONARY` (or per-view grants) to the connecting user. That is a database change owned by a DBA - report it, do not work around it.

## Tool reference

| Tool                       | Signature            | Purpose                                                         |
| -------------------------- | -------------------- | --------------------------------------------------------------- |
| `oracle_mcp_health_report` | -                    | `{overallStatus, databaseName, checks[]}`                       |
| `list_active_sessions`     | `username?`, `sid?`  | ACTIVE sessions with module/program and seconds since last call |
| `list_blocked_sessions`    | -                    | blocked session + blocker                                       |
| `list_locks`               | -                    | held/requested locks with decoded mode and object               |
| `get_session_sql_text`     | `sid*`, `serialNum*` | full SQL text of that session                                   |
| `list_top_sql`             | `limit?`, `orderBy?` | top SQL by a metric                                             |
| `get_wait_events`          | `sid?`, `waitClass?` | current waits from `V$SESSION_WAIT`                             |
| `get_session_longops`      | `sid?`               | long operations with progress                                   |
| `get_instance_info`        | -                    | instance name, host, version, uptime, status                    |
| `get_database_info`        | -                    | name, creation, log/open mode, role                             |
| `get_parameter`            | `name?`              | init parameters from `V$PARAMETER`                              |
| `get_system_stats`         | -                    | cumulative `V$SYSSTAT` (DB time, parses, physical IO)           |
| `get_db_time_model`        | -                    | `V$SYS_TIME_MODEL` (DB CPU vs DB time)                          |
| `list_datafile_io`         | -                    | datafiles with size, reads/writes and average IO time           |
| `get_session_privs`        | -                    | granted vs effective system privileges                          |
| `get_session_roles`        | -                    | enabled roles                                                   |

Details: `references/tools.md`. Verified transcripts: `references/examples.md`.

## Safety

Read-only. Still: V$ views on a busy instance can themselves be slow (full scans of `V$SQL`); keep `limit` small on `list_top_sql`.

## Failure recovery

| Symptom                                    | Cause                                 | Action                                                        |
| ------------------------------------------ | ------------------------------------- | ------------------------------------------------------------- |
| `ORA-00942` on V$ tools                    | missing `SELECT ANY DICTIONARY`       | surface the grant hint to a DBA                               |
| health `DEGRADED` with `catalog-role WARN` | no `SELECT_CATALOG_ROLE`              | dictionary views may be restricted; expect some tools to fail |
| `get_session_sql_text` empty               | session finished or `serialNum` stale | re-read `list_active_sessions`                                |
