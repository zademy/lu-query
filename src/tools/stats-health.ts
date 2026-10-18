import { z } from 'zod';
import { readAuditSession } from '../audit/audit-reader.js';
import { MAX_ROWS, TIMEOUTS } from '../config.js';
import { resolveSchemaFor } from '../catalog/schema.js';
import type { DataAccess } from '../db/data-access.js';
import type { OracleBind, OracleRow } from '../db/oracle-types.js';
import { assertIdentifier } from '../security/identifiers.js';
import type { ServerContext } from '../server.js';
import { jsonResult, vTool } from './mcp.js';

/**
 * Estadísticas del optimizador, contexto de sesión y health report — la
 * migración de StatisticsCatalog/SchemaCatalog(ObjectCatalog)/SystemService
 * del Java. Los SQL son los del Java; los binds `:table` y `:column` se
 * renombran (`:name`, `:col`): Spring JDBC los reescribía a `?`, pero el SQL
 * llega tal cual a node-oracledb y esos nombres son ORA-01745.
 */

const TABLE_STATS_SQL = `SELECT owner AS schema_name, table_name AS name,
       num_rows, blocks, empty_blocks, avg_space, chain_cnt,
       avg_row_len, sample_size, last_analyzed, degree, instances,
       partitioned, logging, compression, cache
FROM all_tables
WHERE owner = :schema AND table_name = :name`;

export function getTableStats(
  dataAccess: DataAccess,
  schema: string,
  table: string,
): Promise<OracleRow[]> {
  return dataAccess.queryForList(TABLE_STATS_SQL, [schema, table]);
}

const COLUMN_STATS_SQL = `SELECT owner AS schema_name, table_name AS name, column_name,
       num_distinct AS ndv, density, num_nulls, num_buckets,
       low_value, high_value, sample_size, last_analyzed,
       histogram, global_stats, user_stats
FROM all_tab_col_statistics
WHERE owner = :schema AND table_name = :name
AND (:col IS NULL OR column_name = :col)
ORDER BY column_name`;

export function getColumnStats(
  dataAccess: DataAccess,
  schema: string,
  table: string,
  column: string | undefined,
): Promise<OracleRow[]> {
  // Cada filtro opcional aparece dos veces en el SQL (comparacion y IS NULL), por eso
  // el mismo valor se bindea dos veces y en ese orden.
  const binds: OracleBind[] = [schema, table, column ?? null, column ?? null];
  return dataAccess.queryForList(COLUMN_STATS_SQL, binds);
}

const HISTOGRAM_SQL = `SELECT owner AS schema_name, table_name AS name, column_name,
       endpoint_number, endpoint_value,
       SUBSTR(endpoint_actual_value, 1, 200) AS endpoint_value_text
FROM all_histograms
WHERE owner = :schema AND table_name = :name AND column_name = :col
ORDER BY endpoint_number`;

export function getHistogram(
  dataAccess: DataAccess,
  schema: string,
  table: string,
  column: string,
): Promise<OracleRow[]> {
  return dataAccess.queryForList(HISTOGRAM_SQL, [schema, table, column]);
}

const SESSION_PRIVS_SQL = `SELECT username, privilege, admin_option
FROM user_sys_privs
UNION ALL
SELECT NULL, privilege, NULL
FROM session_privs
WHERE privilege NOT IN (SELECT privilege FROM user_sys_privs)
ORDER BY privilege`;

export function getSessionPrivs(dataAccess: DataAccess): Promise<OracleRow[]> {
  return dataAccess.queryForList(SESSION_PRIVS_SQL);
}

const SESSION_ROLES_SQL = `SELECT s.role,
       r.admin_option,
       r.default_role
FROM   session_roles s
LEFT JOIN user_role_privs r ON r.granted_role = s.role
ORDER BY s.role`;

export function getSessionRoles(dataAccess: DataAccess): Promise<OracleRow[]> {
  return dataAccess.queryForList(SESSION_ROLES_SQL);
}

const PLSQL_ERRORS_SQL = `SELECT owner AS schema_name, name, type, sequence AS seq, line, position AS pos,
       text, attribute, message_number AS error_num
FROM all_errors
WHERE (:schema IS NULL OR owner = :schema)
AND (:name IS NULL OR name = :name)
AND (:type IS NULL OR type = :type)
ORDER BY name, type, sequence`;

export function getPlsqlErrors(
  dataAccess: DataAccess,
  schema: string | undefined,
  name: string | undefined,
  type: string | undefined,
): Promise<OracleRow[]> {
  const binds: OracleBind[] = [
    schema ?? null,
    schema ?? null,
    name ?? null,
    name ?? null,
    type ?? null,
    type ?? null,
  ];
  return dataAccess.queryForList(PLSQL_ERRORS_SQL, binds);
}

/** `HealthCheck` del Java: nombre corto de la sonda, estado y detalle. */
export interface HealthCheck {
  name: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  detail: string;
}

/** Shape exacto del record `HealthReport` del Java. */
export interface HealthReport {
  overallStatus: 'UP' | 'DEGRADED' | 'DOWN';
  databaseName: string | null;
  checks: HealthCheck[];
}

/** Mensaje de la causa más profunda, como `SystemService#rootMessage` del Java. */
function rootMessage(error: unknown): string {
  let cause: unknown = error;
  while (cause instanceof Error && cause.cause instanceof Error && cause.cause !== cause) {
    cause = cause.cause;
  }
  if (cause instanceof Error && cause.message !== '') return cause.message;
  const name = (error as { constructor?: { name?: string } } | null)?.constructor?.name;
  return name ?? String(error);
}

/**
 * Estado real de la auditoría: el Java solo miraba la config; aquí se verifica
 * además que la sesión viva esté dejando archivo (un writer apagado por I/O
 * deja de escribir sin lanzar). Es la API de audit-writer/audit-reader.
 */
async function auditState(ctx: ServerContext): Promise<string> {
  if (!ctx.config.audit.enabled) return 'disabled';
  const markdown = await readAuditSession(ctx.config.audit.dir, ctx.audit.sessionId());
  return markdown === undefined ? 'disabled (I/O error stopped session logging)' : 'enabled';
}

/** Sonda única de conectividad que además trae el nombre de la BD. */
const DB_NAME_SQL = "SELECT SYS_CONTEXT('USERENV', 'DB_NAME') AS db_name FROM dual";
const VERSION_SQL = 'SELECT banner FROM v$version WHERE ROWNUM = 1';
const CATALOG_ROLE_SQL =
  "SELECT COUNT(*) AS role_count FROM user_role_privs WHERE granted_role = 'SELECT_CATALOG_ROLE'";
const INVALID_OBJECTS_SQL =
  "SELECT COUNT(*) AS invalid_count FROM user_objects WHERE status = 'INVALID'";

export async function healthReport(ctx: ServerContext): Promise<HealthReport> {
  const { dataAccess } = ctx;
  const checks: HealthCheck[] = [];
  let databaseName: string | null = null;
  // La sonda 1 decide `down`: si no hay conexion, el resto de comprobaciones solo
  // repetirian el mismo fallo, asi que se saltan y el reporte dice DOWN.
  let down = false;

  // 1. Conectividad: una sola sentencia prueba la conexión y trae el nombre.
  try {
    const row = await dataAccess.queryForObject(DB_NAME_SQL);
    const name = row?.DB_NAME;
    databaseName = typeof name === 'string' ? name : null;
    checks.push({
      name: 'database-connectivity',
      status: 'PASS',
      detail: 'Connection established',
    });
  } catch (error) {
    checks.push({
      name: 'database-connectivity',
      status: 'FAIL',
      detail: `Cannot reach database: ${rootMessage(error)}`,
    });
    down = true;
  }

  // 2. Versión.
  if (!down) {
    try {
      const row = await dataAccess.queryForObject(VERSION_SQL);
      const banner = row?.BANNER;
      checks.push({
        name: 'database-version',
        status: 'PASS',
        detail: typeof banner === 'string' ? banner : '',
      });
    } catch (error) {
      checks.push({
        name: 'database-version',
        status: 'WARN',
        detail: `Could not read version: ${rootMessage(error)}`,
      });
    }
  }

  // 3. Rol de catálogo.
  if (!down) {
    try {
      const row = await dataAccess.queryForObject(CATALOG_ROLE_SQL);
      const count = row?.ROLE_COUNT;
      if (count === 0) {
        checks.push({
          name: 'catalog-role',
          status: 'WARN',
          detail: 'SELECT_CATALOG_ROLE not found; dictionary views may be restricted',
        });
      } else if (typeof count === 'number') {
        checks.push({
          name: 'catalog-role',
          status: 'PASS',
          detail: `SELECT_CATALOG_ROLE granted (${count} role(s))`,
        });
      }
    } catch (error) {
      checks.push({
        name: 'catalog-role',
        status: 'WARN',
        detail: `Cannot verify role: ${rootMessage(error)}`,
      });
    }
  }

  // 4. Objetos inválidos (solo el schema actual).
  if (!down) {
    try {
      const row = await dataAccess.queryForObject(INVALID_OBJECTS_SQL);
      const invalid = row?.INVALID_COUNT;
      if (invalid === 0) {
        checks.push({
          name: 'invalid-objects',
          status: 'PASS',
          detail: 'No invalid objects in current schema',
        });
      } else if (typeof invalid === 'number') {
        checks.push({
          name: 'invalid-objects',
          status: 'WARN',
          detail: `${invalid} invalid object(s) in current schema`,
        });
      }
    } catch (error) {
      checks.push({
        name: 'invalid-objects',
        status: 'WARN',
        detail: `Cannot check invalid objects: ${rootMessage(error)}`,
      });
    }
  }

  // 5. Configuración efectiva (siempre informativa).
  checks.push({
    name: 'server-config',
    status: 'PASS',
    detail:
      `max-rows=${MAX_ROWS}, query-timeout=${TIMEOUTS.statementMs / 1000}s` +
      `, audit=${await auditState(ctx)}`,
  });

  const overall: HealthReport['overallStatus'] = down
    ? 'DOWN'
    : checks.some((check) => check.status === 'WARN')
      ? 'DEGRADED'
      : 'UP';

  return { overallStatus: overall, databaseName, checks };
}

const SCHEMA_PARAM =
  "Schema (owner) of the table. Optional — defaults to the server's current schema; omit rather than guess.";
const TABLE_PARAM = 'Table name.';

/** Stats/Health — estadísticas del optimizador, sesión y health report (#10). */
export function registerStatsHealth(ctx: ServerContext): void {
  vTool(
    ctx,
    'get_table_stats',
    'Return optimizer statistics for a table: row count, blocks, avg row length, sample size, last analyzed, degree, partitioned, compression.',
    {
      schema: z.string().describe(SCHEMA_PARAM).optional(),
      table: z.string().describe(TABLE_PARAM),
    },
    async (dataAccess, args) => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            await getTableStats(
              dataAccess,
              await resolveSchemaFor(ctx, args.schema, 'get_table_stats'),
              assertIdentifier(args.table, 'tabla'),
            ),
          ),
        },
      ],
    }),
  );

  vTool(
    ctx,
    'get_column_stats',
    'Return optimizer statistics for columns of a table: number of distinct values (NDV), density, null count, bucket count, low/high value, histogram type. Optional column filter.',
    {
      schema: z.string().describe(SCHEMA_PARAM).optional(),
      table: z.string().describe(TABLE_PARAM),
      column: z.string().describe('Optional column name filter.').optional(),
    },
    async (dataAccess, args) => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            await getColumnStats(
              dataAccess,
              await resolveSchemaFor(ctx, args.schema, 'get_column_stats'),
              assertIdentifier(args.table, 'tabla'),
              args.column === undefined ? undefined : assertIdentifier(args.column, 'column'),
            ),
          ),
        },
      ],
    }),
  );

  vTool(
    ctx,
    'get_histogram',
    'Return the optimizer histogram endpoints for a column (frequency or height-balanced). Useful to understand data skew and cardinality estimates.',
    {
      schema: z.string().describe(SCHEMA_PARAM).optional(),
      table: z.string().describe(TABLE_PARAM),
      column: z.string().describe('Column name.'),
    },
    async (dataAccess, args) => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            await getHistogram(
              dataAccess,
              await resolveSchemaFor(ctx, args.schema, 'get_histogram'),
              assertIdentifier(args.table, 'tabla'),
              assertIdentifier(args.column ?? '', 'column'),
            ),
          ),
        },
      ],
    }),
  );

  vTool(
    ctx,
    'get_session_privs',
    'List system privileges available to the current connection: directly granted system privs plus effective privs from enabled roles (deduplicated, ordered). WHEN TO CALL: only when the user explicitly asks what privileges the connection has; do NOT call as a preamble before querying tables or objects.',
    {},
    async (dataAccess, _args) => jsonResult(await getSessionPrivs(dataAccess)),
  );

  vTool(
    ctx,
    'get_session_roles',
    'List roles enabled for the current connection, with admin option and default-role flag. WHEN TO CALL: only when the user explicitly asks which roles the connection has; do NOT call as a preamble before querying tables or objects.',
    {},
    async (dataAccess, _args) => jsonResult(await getSessionRoles(dataAccess)),
  );

  vTool(
    ctx,
    'get_plsql_errors',
    'List compilation errors of PL/SQL units (procedures, functions, packages, triggers, types). Optional schema, name and type filter. Critical for diagnosing broken code.',
    {
      schema: z.string().describe('Schema (owner) name. Omit to search all schemas.').optional(),
      name: z.string().describe('Object name filter.').optional(),
      type: z
        .string()
        .describe(
          "Object type filter: 'PROCEDURE','FUNCTION','PACKAGE','PACKAGE BODY','TRIGGER','TYPE','TYPE BODY'.",
        )
        .optional(),
    },
    async (dataAccess, args) => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(await getPlsqlErrors(dataAccess, args.schema, args.name, args.type)),
        },
      ],
    }),
  );

  vTool(
    ctx,
    'oracle_mcp_health_report',
    'One-shot readiness check: connectivity, database version, catalog-role, invalid objects, and server configuration (max-rows, query-timeout, audit). Returns an aggregated health report for quick self-diagnosis. WHEN TO CALL: only when the user explicitly asks for a health/readiness check; do NOT call as a preamble before other work.',
    {},
    async () => jsonResult(await healthReport(ctx)),
  );
}
