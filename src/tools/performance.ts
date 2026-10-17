import { z } from 'zod';
import { withToolContext } from '../audit/context.js';
import type { DataAccess } from '../db/data-access.js';
import type { OracleBind, OracleRow } from '../db/oracle-types.js';
import { DataAccessError, guardTool } from '../errors.js';
import type { ServerContext } from '../server.js';

/**
 * Diagnóstico de performance sobre las vistas V$ de Oracle. Réplica 1:1 del
 * `PerformanceTools`/`PerformanceService` del Java 2.13.0: mismas tools,
 * descripciones, parámetros, SQL y alias de columna. Solo lee; quién ve las
 * vistas lo decide el grant del usuario de BD (v. scripts/test-grants-performance.sql).
 */

/** Filas por defecto de `list_top_sql`, como el `limit == null ? 10` del Java. */
const DEFAULT_TOP_SQL = 10;

/** Lo que Oracle responde cuando al usuario le faltan privilegios de catálogo. */
const NO_CATALOG_PRIVILEGE = /ORA-00942|ORA-01031/i;

/** Hint de privilegio: el genérico de errors.ts habla de grants de objetos, no de V$. */
const GRANT_HINT =
  'These tools read the V$ views, which need SELECT ANY DICTIONARY (or SELECT_CATALOG_ROLE) on the MCP user: GRANT SELECT ANY DICTIONARY TO <mcp-user>; the ready-made script is scripts/test-grants-performance.sql.';

const ACTIVE_SESSIONS_SQL = `SELECT sid, serial# AS serial_num, username, machine, terminal, program,
       status, server, schemaname, osuser, process, logon_time,
       last_call_et AS seconds_since_last_call, module, action, client_info
FROM v$session
WHERE status = 'ACTIVE'
AND (:username IS NULL OR username = :username)
AND (:sid IS NULL OR sid = :sid)
ORDER BY sid`;

const BLOCKED_SESSIONS_SQL = `SELECT s.sid, s.serial# AS serial_num, s.username, s.machine, s.program,
       s.status, s.blocking_session AS blocker_sid,
       bs.username AS blocker_username, bs.program AS blocker_program,
       s.event AS wait_event, s.seconds_in_wait
FROM v$session s
LEFT JOIN v$session bs ON bs.sid = s.blocking_session
WHERE s.blocking_session IS NOT NULL
ORDER BY s.sid`;

const LOCKS_SQL = `SELECT s.sid, s.serial# AS serial_num, s.username, s.machine,
       lo.oracle_username AS locked_user, o.owner AS object_owner,
       o.object_name, o.object_type,
       DECODE(l.type,
              'TM','DML','TX','Transaction','UL','User','MR','Media Recovery',
              'ST','Disk Space','CU','Cursor Bind','JX','Task Execution',
              l.type) AS lock_type,
       DECODE(l.lmode,0,'None',1,'Null',2,'Row Share',3,'Row Exclusive',
              4,'Share',5,'Share Row Exclusive',6,'Exclusive',TO_CHAR(l.lmode)) AS held_mode,
       DECODE(l.request,0,'None',1,'Null',2,'Row Share',3,'Row Exclusive',
              4,'Share',5,'Share Row Exclusive',6,'Exclusive',TO_CHAR(l.request)) AS requested_mode,
       l.ctime AS seconds_held
FROM v$lock l
JOIN v$session s ON s.sid = l.sid
LEFT JOIN v$locked_object lo ON lo.session_id = s.sid
LEFT JOIN all_objects o ON o.object_id = lo.object_id
WHERE l.type IN ('TM','TX','UL','MR','ST','CU','JX')
AND (l.lmode > 0 OR l.request > 0)
ORDER BY l.sid, l.type`;

const SESSION_SQL_TEXT_SQL = `SELECT sql_text
FROM v$sqltext_with_newlines
WHERE address = (SELECT sql_address FROM v$session WHERE sid = :sid AND serial# = :serial)
AND hash_value = (SELECT sql_hash_value FROM v$session WHERE sid = :sid AND serial# = :serial)
ORDER BY piece`;

const WAIT_EVENTS_SQL = `SELECT sid, seq#, event, p1text, p1, p2text, p2, p3text, p3,
       wait_class, wait_time, seconds_in_wait, state
FROM v$session_wait
WHERE (:sid IS NULL OR sid = :sid)
AND (:waitClass IS NULL OR wait_class = :waitClass)
ORDER BY sid`;

const LONGOPS_SQL = `SELECT sid, serial# AS serial_num, opname, target,
       sofar, totalwork, units, TO_CHAR(ROUND((sofar / NULLIF(totalwork,0)) * 100, 2)) AS pct_done,
       start_time, last_update_time, time_remaining AS seconds_remaining, elapsed_seconds,
       message, username
FROM v$session_longops
WHERE (:sid IS NULL OR sid = :sid)
AND sofar < totalwork
ORDER BY start_time DESC`;

const INSTANCE_INFO_SQL = `SELECT instance_name, host_name, version, startup_time, status,
       parallel, thread# AS thread, archiver, logins, shutdown_pending, database_status
FROM v$instance`;

const DATABASE_INFO_SQL = `SELECT name, created, log_mode, open_mode, dbid,
       platform_id, platform_name, database_role AS role, force_logging, flashback_on
FROM v$database`;

const SYSTEM_STATS_SQL = `SELECT statistic# AS stat_id, name, class, value
FROM v$sysstat
WHERE class IN (1, 2, 4, 8, 16, 32, 64, 128)
ORDER BY class, name`;

const DB_TIME_MODEL_SQL = `SELECT stat_id, stat_name AS name, value
FROM v$sys_time_model
ORDER BY stat_name`;

const PARAMETER_SQL = `SELECT name, type, value, display_value, description,
       isses_modifiable AS session_modifiable,
       issys_modifiable AS system_modifiable,
       isdefault, ismodified
FROM v$parameter
WHERE UPPER(name) LIKE UPPER(:name) ESCAPE '\\'
ORDER BY name`;

const DATAFILE_IO_SQL = `SELECT d.file# AS file_id, d.name AS file_name, d.status, d.enabled,
       d.bytes / 1024 / 1024 AS size_mb,
       fs.phyrds AS physical_reads, fs.phywrts AS physical_writes,
       fs.phyblkrd AS block_reads, fs.phyblkwrt AS block_writes,
       fs.readtim AS read_time_ms, fs.writetim AS write_time_ms,
       fs.avgiotim AS avg_io_ms
FROM v$datafile d
LEFT JOIN v$filestat fs ON fs.file# = d.file#
ORDER BY d.file#`;

/** Alias de cliente → columna ordenable de V$SQL, el switch `safe` del Java. */
const SORTABLE_COLUMNS: Record<string, string> = {
  disk_reads: 'disk_reads',
  disk: 'disk_reads',
  elapsed: 'elapsed_time',
  elapsed_time: 'elapsed_time',
  executions: 'executions',
  exec: 'executions',
  cpu_time: 'cpu_time',
  cpu: 'cpu_time',
};

/** Top SQL: la columna de ORDER BY sale de la allow-list, nunca del cliente. */
function topSqlSql(orderBy: string | undefined): string {
  const column =
    (orderBy === undefined ? undefined : SORTABLE_COLUMNS[orderBy.toLowerCase()]) ?? 'buffer_gets';
  return `SELECT sql_id, child_number AS child, parsing_schema_name AS parsed_by,
       executions, buffer_gets, disk_reads, rows_processed,
       elapsed_time / 1000 AS elapsed_ms, cpu_time / 1000 AS cpu_ms,
       elapsed_time / NULLIF(executions, 0) / 1000 AS avg_elapsed_ms,
       SUBSTR(sql_text, 1, 200) AS sql_preview
FROM v$sql
WHERE executions > 0
ORDER BY ${column} DESC
FETCH FIRST :limit ROWS ONLY`;
}

/** Substring del cliente → patrón LIKE de Oracle (`LikePatterns` del Java). */
function likePattern(name?: string): string {
  const pattern = name?.trim() ?? '';
  if (pattern === '') return '%';
  if (pattern.includes('%') || pattern.includes('_')) return pattern.toUpperCase();
  return `%${pattern.toUpperCase()}%`;
}

/** Fallo de privilegio con el hint del grant, o el error tal cual si es otro. */
function withGrantHint(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  return NO_CATALOG_PRIVILEGE.test(message)
    ? new DataAccessError(`${message}\n  ↳ ${GRANT_HINT}`)
    : error;
}

async function vRows(
  dataAccess: DataAccess,
  sql: string,
  binds?: OracleBind[],
): Promise<OracleRow[]> {
  try {
    return await dataAccess.queryForList(sql, binds);
  } catch (error) {
    throw withGrantHint(error);
  }
}

async function vRow(dataAccess: DataAccess, sql: string): Promise<OracleRow> {
  try {
    return (await dataAccess.queryForObject(sql)) ?? {};
  } catch (error) {
    throw withGrantHint(error);
  }
}

/** Sesiones activas, con filtro opcional por usuario y/o sid. */
export async function listActiveSessions(
  dataAccess: DataAccess,
  args: { username?: string; sid?: number },
): Promise<OracleRow[]> {
  const username = args.username ?? null;
  const sid = args.sid ?? null;
  return vRows(dataAccess, ACTIVE_SESSIONS_SQL, [username, username, sid, sid]);
}

/** Sesiones bloqueadas, con quién bloquea y el evento de espera. */
export async function listBlockedSessions(dataAccess: DataAccess): Promise<OracleRow[]> {
  return vRows(dataAccess, BLOCKED_SESSIONS_SQL);
}

/** Locks DML/transacción/usuario con el objeto y los modos decodificados. */
export async function listLocks(dataAccess: DataAccess): Promise<OracleRow[]> {
  return vRows(dataAccess, LOCKS_SQL);
}

/** SQL en curso de una sesión: las piezas concatenadas, como el String del Java. */
export async function getSessionSqlText(
  dataAccess: DataAccess,
  args: { sid: number; serialNum: number },
): Promise<string> {
  const rows = await vRows(dataAccess, SESSION_SQL_TEXT_SQL, [
    args.sid,
    args.serialNum,
    args.sid,
    args.serialNum,
  ]);
  // Java: StringBuilder.append pieza a pieza; SQL_TEXT es VARCHAR2 (string).
  return rows.map((row) => (typeof row.SQL_TEXT === 'string' ? row.SQL_TEXT : '')).join('');
}

/** Top SQL por buffer_gets (default), disk_reads, elapsed_time, executions o cpu_time. */
export async function listTopSql(
  dataAccess: DataAccess,
  args: { orderBy?: string; limit?: number },
): Promise<OracleRow[]> {
  return vRows(dataAccess, topSqlSql(args.orderBy), [args.limit ?? DEFAULT_TOP_SQL]);
}

/** Wait events por sesión, con filtro opcional de sid y clase de espera. */
export async function getWaitEvents(
  dataAccess: DataAccess,
  args: { sid?: number; waitClass?: string },
): Promise<OracleRow[]> {
  const sid = args.sid ?? null;
  const waitClass = args.waitClass ?? null;
  return vRows(dataAccess, WAIT_EVENTS_SQL, [sid, sid, waitClass, waitClass]);
}

/** Operaciones largas en curso (sofar < totalwork), con filtro opcional de sid. */
export async function getSessionLongops(
  dataAccess: DataAccess,
  args: { sid?: number },
): Promise<OracleRow[]> {
  const sid = args.sid ?? null;
  return vRows(dataAccess, LONGOPS_SQL, [sid, sid]);
}

/** Salud de la instancia: nombre, host, versión, arranque, archiver. */
export async function getInstanceInfo(dataAccess: DataAccess): Promise<OracleRow> {
  return vRow(dataAccess, INSTANCE_INFO_SQL);
}

/** Salud de la base de datos: nombre, log mode, open mode, role, flashback. */
export async function getDatabaseInfo(dataAccess: DataAccess): Promise<OracleRow> {
  return vRow(dataAccess, DATABASE_INFO_SQL);
}

/** Estadísticas acumuladas de V$SYSSTAT (clases 1-128, como el Java). */
export async function getSystemStats(dataAccess: DataAccess): Promise<OracleRow[]> {
  return vRows(dataAccess, SYSTEM_STATS_SQL);
}

/** Modelo de tiempo de base de datos (DB CPU, DB time, parse elapsed). */
export async function getDbTimeModel(dataAccess: DataAccess): Promise<OracleRow[]> {
  return vRows(dataAccess, DB_TIME_MODEL_SQL);
}

/** Parámetros de inicialización, con filtro opcional tipo LIKE. */
export async function getParameter(
  dataAccess: DataAccess,
  args: { name?: string },
): Promise<OracleRow[]> {
  return vRows(dataAccess, PARAMETER_SQL, [likePattern(args.name)]);
}

/** Datafiles con tamaño y estadísticas de IO. */
export async function listDatafileIo(dataAccess: DataAccess): Promise<OracleRow[]> {
  return vRows(dataAccess, DATAFILE_IO_SQL);
}

/**
 * Registra una tool de performance: contexto de auditoría, guard y resultado.
 * Un `string` (el SQL de una sesión) viaja como texto plano porque así lo
 * devuelve el Java; el resto, como JSON.
 */
function vTool<Args extends Record<string, unknown> = Record<string, unknown>>(
  ctx: ServerContext,
  name: string,
  description: string,
  shape: Record<string, z.ZodTypeAny>,
  run: (dataAccess: DataAccess, args: Args) => Promise<unknown>,
): void {
  ctx.server.registerTool(name, { description, inputSchema: shape }, async (args) =>
    // El contexto de auditoría viaja por AsyncLocalStorage hasta el DataAccess.
    withToolContext(name, args, () =>
      guardTool(async () => {
        const result = await run(ctx.dataAccess, args as Args);
        return {
          content: [
            {
              type: 'text' as const,
              text: typeof result === 'string' ? result : JSON.stringify(result),
            },
          ],
        };
      }),
    ),
  );
}

const SID_FILTER = {
  sid: z.number().int().describe('Optional session id (SID) filter.').optional(),
};

/** Performance — diagnóstico en vivo sobre las vistas V$ (13 tools del Java). */
export function registerPerformance(ctx: ServerContext): void {
  vTool(
    ctx,
    'list_active_sessions',
    'List currently ACTIVE sessions with username, machine, program, last call elapsed, module and logon time. Optional username and sid filters.',
    {
      username: z.string().describe('Optional Oracle username filter.').optional(),
      ...SID_FILTER,
    },
    listActiveSessions,
  );

  vTool(
    ctx,
    'list_blocked_sessions',
    'List sessions currently blocked by another session, with the blocker sid/username/program and the wait event being waited on.',
    {},
    listBlockedSessions,
  );

  vTool(
    ctx,
    'list_locks',
    'List DML/transaction/user locks held and requested, with the locked object name and lock mode (decoded).',
    {},
    listLocks,
  );

  vTool(
    ctx,
    'get_session_sql_text',
    'Return the full SQL text currently being executed by a session, given its sid and serial#.',
    {
      sid: z.number().int().describe('Session id (SID).'),
      serialNum: z.number().int().describe('Session serial number.'),
    },
    getSessionSqlText,
  );

  vTool(
    ctx,
    'list_top_sql',
    "Top-N SQL statements ordered by buffer_gets (default), disk_reads, elapsed_time, executions or cpu_time. Returns sql_id, executions, gets/reads/elapsed and a 200-char SQL preview.",
    {
      orderBy: z
        .string()
        .describe(
          "Sort key: 'buffer_gets' (default), 'disk_reads', 'elapsed_time', 'executions', 'cpu_time'.",
        )
        .optional(),
      limit: z.number().int().describe('Number of rows to return (default 10).').optional(),
    },
    listTopSql,
  );

  vTool(
    ctx,
    'get_wait_events',
    "List current wait events from V$SESSION_WAIT. Optional sid filter and wait_class filter (e.g. 'Application','Concurrency','User I/O').",
    {
      ...SID_FILTER,
      waitClass: z
        .string()
        .describe("Optional wait class filter (e.g. 'User I/O', 'Application').")
        .optional(),
    },
    getWaitEvents,
  );

  vTool(
    ctx,
    'get_session_longops',
    'List long-running operations from V$SESSION_LONGOPS (backups, stats gathering, long queries) with progress percentage and ETA. Optional sid filter; only in-progress ops shown.',
    SID_FILTER,
    getSessionLongops,
  );

  vTool(
    ctx,
    'get_instance_info',
    'Return Oracle instance information: name, host, version, startup time, status, archiver, thread.',
    {},
    getInstanceInfo,
  );

  vTool(
    ctx,
    'get_database_info',
    'Return database-level information: name, creation date, log mode (archivelog/noarchivelog), open mode, role, flashback status.',
    {},
    getDatabaseInfo,
  );

  vTool(
    ctx,
    'get_system_stats',
    'Return cumulative system statistics from V$SYSSTAT (parse count, execute count, DB time, physical reads/writes, etc.).',
    {},
    getSystemStats,
  );

  vTool(
    ctx,
    'get_db_time_model',
    'Return the database time model from V$SYS_TIME_MODEL: DB CPU, DB time, parse time elapsed, hard parse elapsed, etc.',
    {},
    getDbTimeModel,
  );

  vTool(
    ctx,
    'get_parameter',
    'Return Oracle initialization parameters from V$PARAMETER with type, value, default/modified flags and modifiability. Optional name LIKE pattern (case-insensitive, supports %).',
    {
      name: z
        .string()
        .describe(
          "Optional LIKE pattern for the parameter name (case-insensitive, supports '%' wildcard). Omit to list all.",
        )
        .optional(),
    },
    getParameter,
  );

  vTool(
    ctx,
    'list_datafile_io',
    'List datafiles with size, physical reads/writes, block reads/writes and average IO time per file.',
    {},
    listDatafileIo,
  );
}
