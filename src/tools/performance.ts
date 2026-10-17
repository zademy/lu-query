import { z } from 'zod';
import { withToolContext } from '../audit/context.js';
import type { DataAccess } from '../db/data-access.js';
import type { OracleBind, OracleRow } from '../db/oracle-types.js';
import { DataAccessError, guardTool } from '../errors.js';
import type { ServerContext } from '../server.js';

/**
 * Diagnóstico de performance sobre las vistas V$ de Oracle. Réplica 1:1 del
 * `PerformanceTools`/`PerformanceService` del Java: mismas tools, mismos
 * parámetros y mismas columnas. Solo lee; el usuario de la BD es quien decide
 * qué ve (v. `scripts/test-grants-performance.sql`).
 */

/** Filas por defecto de `list_top_sql`, como el `limit` por defecto del Java. */
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
AND (:1 IS NULL OR username = :1)
AND (:2 IS NULL OR sid = :2)
ORDER BY sid`;

const BLOCKED_SESSIONS_SQL = `SELECT s.sid AS waiting_sid, s.serial# AS waiting_serial,
       s.username AS waiting_user, s.status AS waiting_status,
       s.seconds_in_wait AS waiting_seconds,
       s.blocking_session AS blocking_sid,
       bs.serial# AS blocking_serial,
       bs.username AS blocking_user,
       s.sql_id, s.prev_sql_id, s.event AS wait_event, s.seconds_in_wait
FROM v$session s
LEFT JOIN v$session bs ON bs.sid = s.blocking_session
WHERE s.blocking_session IS NOT NULL
ORDER BY s.sid`;

// El objeto se localiza por (id1, id2), que es como V$LOCK guarda type/id1/id2.
const LOCKS_SQL = `SELECT s.sid, s.serial#, s.username, s.status AS session_status,
       s.machine, s.program, o.object_name, o.object_type, o.owner,
       l.type AS lock_type, l.lmode, l.request, l.block AS blocking_lock_sid,
       l.ctime
FROM v$session s
JOIN v$lock l ON s.sid = l.sid
LEFT JOIN dba_objects o ON o.object_id = l.id1 AND o.data_object_id = l.id2
ORDER BY s.sid, l.ctime DESC`;

// SQL_ID vive en V$SESSION mientras la sentencia corre; V$SQL ya no tiene sid/serial#.
// Cada fila es una pieza de 64 caracteres, de ahí el join por "\n" del Java.
const SESSION_SQL_TEXT_SQL = `SELECT sql_text
FROM v$sqltext_with_newlines
WHERE sql_id = (SELECT sql_id FROM v$session WHERE sid = :1 AND serial# = :2 AND sql_id IS NOT NULL)
ORDER BY piece`;

const TOP_SQL_SQL = `SELECT sql_id, child_number, plan_hash_value, executions, elapsed_time, cpu_time, buffer_gets, disk_reads, optimizer_cost, sql_text
FROM v$sql
WHERE sql_text IS NOT NULL
ORDER BY NVL(:1, 'elapsed_time') DESC
FETCH FIRST :2 ROWS ONLY`;

const WAIT_EVENTS_SQL = `SELECT sid, seq#, event, p1text, p1, p2text, p2, p3text, p3,
       wait_class, wait_time, seconds_in_wait, state
FROM v$session_wait
WHERE (:1 IS NULL OR sid = :1)
AND (:2 IS NULL OR wait_class = :2)
ORDER BY sid`;

const LONGOPS_SQL = `SELECT sid, serial# AS serial_num, opname, target,
       sofar, totalwork, units, TO_CHAR(ROUND((sofar / NULLIF(totalwork,0)) * 100, 2)) AS pct_done,
       start_time, last_update_time, time_remaining AS seconds_remaining, elapsed_seconds,
       message, username
FROM v$session_longops
WHERE (:1 IS NULL OR sid = :1)
AND sofar < totalwork
ORDER BY start_time DESC`;

const INSTANCE_INFO_SQL = `SELECT instance_name, host_name, version, startup_time, status, archiver, thread# AS thread
FROM v$instance WHERE ROWNUM = 1`;

const DATABASE_INFO_SQL = `SELECT name, created, log_mode, open_mode, database_role, flashback_on AS flashback_status
FROM v$database WHERE ROWNUM = 1`;

const SYSTEM_STATS_SQL = `SELECT name, value FROM v$sysstat ORDER BY name`;

const DB_TIME_MODEL_SQL = `SELECT stat_name, value FROM v$sys_time_model ORDER BY stat_name`;

// Los nombres de V$PARAMETER van en minúsculas; el patrón llega en mayúsculas.
const PARAMETER_SQL = `SELECT name, value, type, description, isdefault, ismodified, isses_modifiable, issys_modifiable
FROM v$parameter WHERE UPPER(name) LIKE :1 ESCAPE '\\' ORDER BY name`;

const DATAFILE_IO_SQL = `SELECT d.file# AS file_id, d.name AS file_name, d.status, d.enabled,
       d.bytes / 1024 / 1024 AS size_mb,
       fs.phyrds AS physical_reads, fs.phywrts AS physical_writes,
       fs.phyblkrd AS block_reads, fs.phyblkwrt AS block_writes,
       fs.readtim AS read_time_ms, fs.writetim AS write_time_ms,
       fs.avgiotim AS avg_io_ms
FROM v$datafile d
LEFT JOIN v$filestat fs ON fs.file# = d.file#
ORDER BY d.file#`;

/** Filtro opcional de patrón LIKE, con la convención de `LikePatterns` del Java. */
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

/** Sesiones bloqueadas por otra sesión, con los datos de quien bloquea. */
export async function listBlockedSessions(dataAccess: DataAccess): Promise<OracleRow[]> {
  return vRows(dataAccess, BLOCKED_SESSIONS_SQL);
}

/** Locks de todas las sesiones, con el objeto bloqueado cuando se puede resolver. */
export async function listLocks(dataAccess: DataAccess): Promise<OracleRow[]> {
  return vRows(dataAccess, LOCKS_SQL);
}

/** SQL en curso de una sesión, como el string que devolvía el Java. */
export async function getSessionSqlText(
  dataAccess: DataAccess,
  args: { sid: number; serialNum: number },
): Promise<string> {
  const rows = await vRows(dataAccess, SESSION_SQL_TEXT_SQL, [args.sid, args.serialNum]);
  return rows.map((row) => (typeof row.SQL_TEXT === 'string' ? row.SQL_TEXT : '')).join('\n');
}

/** Top SQL por elapsed_time (por defecto) o buffer_gets. */
export async function listTopSql(
  dataAccess: DataAccess,
  args: { orderBy?: string; limit?: number },
): Promise<OracleRow[]> {
  return vRows(dataAccess, TOP_SQL_SQL, [
    args.orderBy ?? 'elapsed_time',
    args.limit ?? DEFAULT_TOP_SQL,
  ]);
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

/** Estadísticas acumuladas de V$SYSSTAT. */
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
 * Registra una tool de performance: contexto de auditoría, guard y JSON del
 * resultado. `run` se pasa por referencia (su firma es la que tipa los args).
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
      guardTool(async () => ({
        content: [
          {
            type: 'text' as const,
            // El SDK entrega los args ya validados por el shape de arriba; el
            // tipo genérico solo sirve para que `run` los reciba tipados.
            text: JSON.stringify(await run(ctx.dataAccess, args as Args)),
          },
        ],
      })),
    ),
  );
}

const SID_FILTER = {
  sid: z.number().int().describe('Optional session id (SID) filter.').optional(),
};

/** Performance — diagnóstico en vivo sobre las vistas V$ (13 tools). */
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
    "List sessions currently blocked by another session (blocking_session is not null), with the blocker session's sid, serial and username.",
    {},
    listBlockedSessions,
  );

  vTool(
    ctx,
    'list_locks',
    'List lock information for all sessions: sid, username, object name/type, lock type, mode, request and blocking session.',
    {},
    listLocks,
  );

  vTool(
    ctx,
    'get_session_sql_text',
    'Return the SQL text (sqltext_with_newlines) of the SQL currently executing in a given session. Requires sid and serialNum from list_active_sessions.',
    {
      sid: z.number().int().describe('Session id (SID) whose SQL text you want.'),
      serialNum: z
        .number()
        .int()
        .describe('Serial number of the session; use the serial from list_active_sessions.'),
    },
    getSessionSqlText,
  );

  vTool(
    ctx,
    'list_top_sql',
    'List the top SQL statements from v$sql ordered by elapsed_time or buffer_gets. Optional orderBy (default elapsed_time) and limit (default 10). Use run_query for anything else.',
    {
      orderBy: z
        .string()
        .describe("Column to order by: 'elapsed_time' (default) or 'buffer_gets'.")
        .optional(),
      limit: z
        .number()
        .int()
        .describe('Maximum number of SQL statements to return. Defaults to 10.')
        .optional(),
    },
    listTopSql,
  );

  vTool(
    ctx,
    'get_wait_events',
    'List current wait events per session from v$session_wait with event name, p1/p2/p3, wait class and time in wait. Optional sid and waitClass filters.',
    {
      ...SID_FILTER,
      waitClass: z
        .string()
        .describe(
          "Optional wait class filter (e.g. 'User I/O', 'Concurrency'). Omit to list all classes.",
        )
        .optional(),
    },
    getWaitEvents,
  );

  vTool(
    ctx,
    'get_session_longops',
    'List long-running operations currently tracked in v$session_longops (only in progress, sofar < totalwork). Optional sid filter.',
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
