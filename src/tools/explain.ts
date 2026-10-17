import { z } from 'zod';
import { withToolContext } from '../audit/context.js';
import { resolveSchema } from '../catalog/schema.js';
import type { DataAccess } from '../db/data-access.js';
import type { OracleRow } from '../db/oracle-types.js';
import { DataAccessError, guardTool } from '../errors.js';
import type { ServerContext } from '../server.js';

/** Escala de las notificaciones de progreso MCP (10 al empezar, 90 al terminar). */
const PROGRESS_TOTAL = 100;

/** Límite de identificadores de Oracle 12c+. */
const MAX_INDEX_NAME = 128;

/** Columnas entre comillas dobles en el texto de predicados del plan. */
const PREDICATE_COLUMN = /"([A-Za-z_][A-Za-z0-9_$#]{0,127})"/g;

/** Privilegios/funciones de advisor no disponibles (word-boundary: ORA-01031 != ORA-010310). */
const ADVISOR_MISSING = /ORA-01031\b|ORA-13616\b|ORA-24470\b/;

/** PLAN_TABLE inexistente (ORA-00980) o sin privilegio para el usuario (ORA-01031). */
const PLAN_TABLE_MISSING = /ORA-00980\b|ORA-01031\b/;

/**
 * statement_id/task_name propios de cada llamada: el PLAN_TABLE es compartido y
 * dos llamadas seguidas no pueden pisarse. El contador garantiza unicidad en el
 * proceso y la fecha lo deja corto (STATEMENT_ID es VARCHAR2(30)).
 */
let sequence = 0;

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}_${Date.now()}_${sequence}`;
}

/** Resultado de `suggest_index`, con los mismos campos que el record IndexSuggestion del Java. */
export interface IndexSuggestion {
  hasCandidates: boolean;
  schema: string | null;
  table: string | null;
  accessProblem: string | null;
  predicateColumns: string[];
  recommendedColumns: string[];
  recommendedDdl: string | null;
  reasoning: string;
}

/** `IndexSuggestion.empty(reason)` del Java: sin candidato, todo identificador a null. */
function emptySuggestion(reason: string): IndexSuggestion {
  return {
    hasCandidates: false,
    schema: null,
    table: null,
    accessProblem: null,
    predicateColumns: [],
    recommendedColumns: [],
    recommendedDdl: null,
    reasoning: reason,
  };
}

// ---- explain_plan -----------------------------------------------------------

/**
 * EXPLAIN PLAN + DBMS_XPLAN.DISPLAY sobre un statement_id propio: el plan se
 * describe, el SQL nunca se ejecuta, y la fila se borra para no dejar basura en
 * el PLAN_TABLE compartido.
 */
async function explainPlan(dataAccess: DataAccess, sql: string): Promise<string> {
  const statementId = nextId('mcp');
  try {
    await runPlan(dataAccess, statementId, sql);
    const rows = await dataAccess.queryForList(
      `SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(NULL, :id, 'TYPICAL'))`,
      [statementId],
    );
    return rows.map((row) => text(row.PLAN_TABLE_OUTPUT)).join('');
  } finally {
    await cleanupPlan(dataAccess, statementId);
  }
}

/**
 * El pool no usa autoCommit y da una conexión nueva por sentencia, así que la
 * fila del plan moriría al cerrar su conexión y la siguiente sentencia
 * (DBMS_XPLAN.DISPLAY) no la vería. Por eso EXPLAIN PLAN y el borrado van en
 * bloques autónomos que confirman dentro. El Java no lo necesita: HikariCP
 * autocomitea. El SQL del usuario viaja como bind y se concatena en la BD.
 */
const PLAN_SQL = `DECLARE
  v_statement VARCHAR2(32767) := 'EXPLAIN PLAN SET STATEMENT_ID = ''' || :id || ''' FOR ' || :sql;
  PRAGMA AUTONOMOUS_TRANSACTION;
BEGIN
  EXECUTE IMMEDIATE v_statement;
  COMMIT;
END;`;

const PLAN_CLEANUP_SQL = `DECLARE
  PRAGMA AUTONOMOUS_TRANSACTION;
BEGIN
  DELETE FROM plan_table WHERE statement_id = :id;
  COMMIT;
END;`;

/** `EXPLAIN PLAN` con ORA-00980/ORA-01031 traducidos a la instrucción de setup. */
async function runPlan(dataAccess: DataAccess, statementId: string, sql: string): Promise<void> {
  try {
    await dataAccess.execute(PLAN_SQL, [statementId, sql]);
  } catch (error) {
    if (PLAN_TABLE_MISSING.test(String((error as Error)?.message ?? ''))) {
      throw new DataAccessError(
        `${String((error as Error).message)}\n  ↳ explain_plan needs a PLAN_TABLE the current user can write. ` +
          'Ask a DBA to run: GRANT SELECT, INSERT, DELETE ON SYS.PLAN_TABLE$ TO <mcp_user>; ' +
          'GRANT EXECUTE ON SYS.DBMS_XPLAN TO <mcp_user>; (see db/setup_least_privilege_user.sql, section 5).',
      );
    }
    throw error;
  }
}

/** Borrado best-effort de la fila del plan (el Java lo traga a propósito). */
async function cleanupPlan(dataAccess: DataAccess, statementId: string): Promise<void> {
  try {
    await dataAccess.execute(PLAN_CLEANUP_SQL, [statementId]);
  } catch {
    // El análisis ya se devolvió: un fallo al limpiar no puede ensuciar el error.
  }
}

// ---- suggest_index ----------------------------------------------------------

async function suggestIndex(
  dataAccess: DataAccess,
  sql: string,
  targetTable: string | undefined,
): Promise<IndexSuggestion> {
  if (/^EXPLAIN PLAN/i.test(sql.trim())) {
    throw new Error(
      'suggest_index runs its own EXPLAIN PLAN internally; pass the plain SQL (e.g. SELECT ... ) without an EXPLAIN PLAN prefix.',
    );
  }

  const statementId = nextId('mcp_sidx');
  try {
    await runPlan(dataAccess, statementId, sql);

    const planRows = await dataAccess.queryForList(
      `SELECT object_owner, object_name, operation, options, cost,
              access_predicates, filter_predicates
       FROM plan_table
       WHERE statement_id = :id AND object_name IS NOT NULL
       ORDER BY id`,
      [statementId],
    );

    const candidate = findFullScanCandidate(planRows, targetTable);
    if (!candidate) {
      return emptySuggestion(
        targetTable === undefined
          ? 'No TABLE ACCESS FULL operations found; the query already uses indexes.'
          : `No TABLE ACCESS FULL found for ${targetTable}.`,
      );
    }

    const schema = str(candidate.OBJECT_OWNER);
    const table = str(candidate.OBJECT_NAME);
    // `:table` no vale como nombre de bind: TABLE es palabra reservada
    // (ORA-01745), igual que `:owner` casi lo es. Se usan nombres propios.
    const colStats = await dataAccess.queryForList(
      `SELECT column_name, num_distinct
       FROM all_tab_col_statistics
       WHERE owner = :col_owner AND table_name = :col_table`,
      [schema, table],
    );

    return buildSuggestion(candidate, colStats);
  } finally {
    await cleanupPlan(dataAccess, statementId);
  }
}

/** Peor `TABLE ACCESS FULL` del plan; a igualdad de coste gana el nombre mayor (determinista). */
function findFullScanCandidate(
  planRows: OracleRow[],
  targetTable: string | undefined,
): OracleRow | undefined {
  const fullScans = planRows.filter((row) => {
    if (text(row.OPERATION).toUpperCase() !== 'TABLE ACCESS') return false;
    if (text(row.OPTIONS).toUpperCase() !== 'FULL') return false;
    const table = row.OBJECT_NAME;
    if (typeof table !== 'string') return false;
    return targetTable === undefined || targetTable.toUpperCase() === table.toUpperCase();
  });

  return fullScans.reduce<OracleRow | undefined>((best, row) => {
    if (best === undefined) return row;
    const cost = toLong(row.COST) - toLong(best.COST);
    if (cost !== 0) return cost > 0 ? row : best;
    const a = str(row.OBJECT_NAME);
    const b = str(best.OBJECT_NAME);
    if (a === null) return best;
    if (b === null) return row;
    return a > b ? row : best;
  }, undefined);
}

/** Recomendación pura: columnas del plan ordenadas por `num_distinct`, máximo dos. */
function buildSuggestion(candidate: OracleRow, colStats: OracleRow[]): IndexSuggestion {
  // OBJECT_OWNER/OBJECT_NAME del plan no son null: el filtro del candidato lo garantiza.
  const schema = str(candidate.OBJECT_OWNER) ?? '';
  const table = str(candidate.OBJECT_NAME) ?? '';
  const predicateColumns = extractColumns(candidate.ACCESS_PREDICATES, candidate.FILTER_PREDICATES);

  if (predicateColumns.length === 0) {
    return {
      hasCandidates: true,
      schema,
      table,
      accessProblem: 'TABLE ACCESS FULL',
      predicateColumns: [],
      recommendedColumns: [],
      recommendedDdl: null,
      reasoning:
        `Full scan detected on ${table} but no filter/join predicate columns were ` +
        'exposed in the plan; an index may not help unless the query has selective predicates.',
    };
  }

  const distinct = new Map<string, number>();
  for (const row of colStats) {
    const column = str(row.COLUMN_NAME);
    if (column !== null) distinct.set(column.toUpperCase(), toLong(row.NUM_DISTINCT));
  }

  // Array.prototype.sort es estable: a igualdad de num_distinct manda el orden del plan.
  const ranked = [...predicateColumns].sort(
    (a, b) => (distinct.get(b.toUpperCase()) ?? 0) - (distinct.get(a.toUpperCase()) ?? 0),
  );
  const recommended = ranked.slice(0, 2);
  const best = distinct.get(recommended[0]!.toUpperCase()) ?? 0;

  return {
    hasCandidates: true,
    schema,
    table,
    accessProblem: 'TABLE ACCESS FULL',
    predicateColumns,
    recommendedColumns: recommended,
    recommendedDdl: buildCreateIndexDdl(schema, table, recommended),
    reasoning:
      `Full scan on ${schema}.${table} with predicate column(s) ${javaList(predicateColumns)}. ` +
      `Indexing ${javaList(recommended)} (num_distinct=${best} for the leading column) ` +
      'should let Oracle use an index range scan.',
  };
}

/** `CREATE INDEX` con nombres que vienen del diccionario de Oracle (no hay que validarlos). */
function buildCreateIndexDdl(schema: string, table: string, columns: string[]): string {
  const name = truncateIndexName(`IX_${table}_${columns.join('_')}`);
  return (
    `CREATE INDEX ${quoteTrusted(schema)}.${quoteTrusted(name)}` +
    ` ON ${quoteTrusted(schema)}.${quoteTrusted(table)} (${columns.map(quoteTrusted).join(', ')})`
  );
}

/** Recorta a 128 caracteres con un sufijo hash: el límite de Oracle 12c+ es de bytes. */
function truncateIndexName(name: string): string {
  if (name.length <= MAX_INDEX_NAME) return name;
  const hash = (javaHash(name) >>> 0).toString(16);
  return `${name.slice(0, Math.max(MAX_INDEX_NAME - 1 - hash.length, 1))}_${hash}`;
}

/** `String.hashCode()` del Java, para que el sufijo sea el mismo en ambos ports. */
function javaHash(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (Math.imul(31, hash) + text.charCodeAt(i)) | 0;
  }
  return hash;
}

/** Identificador ya confiable: solo se escapan las comillas dobles. */
function quoteTrusted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Columnas de los predicados de acceso y filtro, deduplicadas sin distinguir mayúsculas. */
function extractColumns(accessPredicates: unknown, filterPredicates: unknown): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const predicates of [accessPredicates, filterPredicates]) {
    if (predicates === null || predicates === undefined) continue;
    for (const match of text(predicates).matchAll(PREDICATE_COLUMN)) {
      const column = match[1]!;
      const key = column.toUpperCase();
      if (!seen.has(key)) {
        seen.add(key);
        ordered.push(column);
      }
    }
  }
  return ordered;
}

// ---- list_unused_indexes ----------------------------------------------------

/**
 * Fuente del histórico de uso. `V$OBJECT_USAGE` no existe en las bases 26ai
 * Free (autónomas, sin V$ de performance): su equivalente por usuario es
 * `USER_OBJECT_USAGE`, con las mismas seis columnas. Se prueban en orden y solo
 * se cae al segundo ante ORA-00942 (vista ausente o sin privilegio).
 */
const USAGE_SOURCES = ['v$object_usage', 'user_object_usage'];

function indexUsageQuery(usage: string): string {
  return `SELECT i.owner AS index_owner, i.index_name,
              i.table_owner, i.table_name,
              (SELECT LISTAGG(ic.column_name, ', ') WITHIN GROUP (ORDER BY ic.column_position)
               FROM all_ind_columns ic
               WHERE ic.index_owner = i.owner AND ic.index_name = i.index_name) AS columns,
              i.uniqueness, i.status, i.last_analyzed,
              COALESCE(u.monitoring, 'NO') AS monitoring,
              CASE WHEN u.used = 'NO' AND u.monitoring = 'YES' THEN 'YES'
                   WHEN u.used = 'YES' THEN 'NO'
                   ELSE 'UNKNOWN' END AS likely_unused,
              u.start_monitoring, u.end_monitoring
       FROM all_indexes i
       LEFT JOIN ${usage} u
         ON u.index_name = i.index_name AND u.table_name = i.table_name
       WHERE i.table_owner = :schema
       ORDER BY i.table_owner, i.table_name, i.index_name`;
}

async function listUnusedIndexes(dataAccess: DataAccess, schema: string): Promise<OracleRow[]> {
  for (const usage of USAGE_SOURCES) {
    try {
      return await dataAccess.queryForList(indexUsageQuery(usage), [schema]);
    } catch (error) {
      if (!String((error as Error)?.message ?? '').includes('ORA-00942')) throw error;
    }
  }
  return [
    {
      NOTE:
        'Index usage view V$OBJECT_USAGE is not accessible on this database (missing grant or the view ' +
        'does not exist on this Oracle release), so unused-index detection is unavailable. ' +
        'Ask the DBA to grant SELECT on SYS.V_$OBJECT_USAGE or verify the view exists.',
    },
  ];
}

// ---- run_sql_tuning_advisor -------------------------------------------------

async function runSqlTuningAdvisor(dataAccess: DataAccess, sql: string): Promise<string> {
  const taskName = nextId('mcp_sta');
  try {
    await scalar(
      dataAccess,
      // CREATE_TUNING_TASK, no CREATE_SQL_TUNING_TASK: desde 26ai la versión
      // antigua no es callable desde SQL (ORA-00904) y esta devuelve el task_name.
      `SELECT DBMS_SQLTUNE.CREATE_TUNING_TASK(
                sql_text => :sql, scope => 'COMPREHENSIVE',
                time_limit => 30, task_name => :task,
                description => 'MCP SQL Tuning Advisor') FROM dual`,
      [sql, taskName],
    );
    await dataAccess.execute('BEGIN DBMS_SQLTUNE.EXECUTE_TUNING_TASK(task_name => :task); END;', [
      taskName,
    ]);
    return await scalar(
      dataAccess,
      // SUBSTR y no el CLOB directo: el pool cierra la conexión tras la
      // sentencia y un LOB se vuelve ilegible. Tope: 32767 bytes de VARCHAR2.
      // shortcut: si Oracle devolviera el LOB materializado, leerlo entero.
      `SELECT DBMS_LOB.SUBSTR(DBMS_SQLTUNE.REPORT_TUNING_TASK(
                task_name => :task, type => 'TEXT', level => 'TYPICAL', section => 'ALL'),
                32767, 1) AS report FROM dual`,
      [taskName],
    );
  } catch (error) {
    const message = String((error as Error)?.message ?? '');
    if (ADVISOR_MISSING.test(message.toUpperCase())) {
      throw new DataAccessError(
        'SQL Tuning Advisor requires the ADVISOR privilege, which the current Oracle user does not have. ' +
          'Have a DBA run: GRANT ADVISOR TO <mcp_user>; (see db/setup_least_privilege_user.sql, section 8).',
      );
    }
    throw new DataAccessError(
      'SQL Tuning Advisor failed; the detail has been logged server-side. ' +
        'If the ADVISOR privilege is missing, grant it (see db/setup_least_privilege_user.sql, section 8); ' +
        'otherwise inspect the server logs.',
    );
  } finally {
    try {
      await dataAccess.execute('BEGIN DBMS_SQLTUNE.DROP_TUNING_TASK(task_name => :task); END;', [
        taskName,
      ]);
    } catch {
      // El reporte ya se devolvió (o falló con su mensaje): no se enmascara con la limpieza.
    }
  }
}

/**
 * Valor escalar de una fila de una función SQL (el Java lo mapea a String).
 * El reporte del advisor sale como VARCHAR2 y no como CLOB a propósito: el
 * pool cierra la conexión al terminar la sentencia y un LOB perezoso se
 * quedaría ilegible (NJS-003).
 */
async function scalar(dataAccess: DataAccess, sql: string, binds: string[]): Promise<string> {
  const row = await dataAccess.queryForObject(sql, binds);
  return text(Object.values(row ?? {})[0]);
}

// ---- helpers ----------------------------------------------------------------

/** `String.valueOf` del Java: solo primitivos, para no imprimir `[object Object]`. */
function text(value: unknown): string {
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
    ? String(value)
    : '';
}

/** Columna del plan: `null` si no vino, igual que `String.valueOf` sobre null en Java. */
function str(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function toLong(value: unknown): number {
  if (typeof value === 'number') return Math.trunc(value);
  const parsed = Number.parseInt(text(value).trim(), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** `List.toString()` del Java, para que los mensajes sean los mismos en ambos ports. */
function javaList(values: string[]): string {
  return `[${values.join(', ')}]`;
}

function json(value: unknown): { type: 'text'; text: string } {
  return { type: 'text', text: JSON.stringify(value) };
}

/**
 * Notificador de progreso MCP: solo existe si el cliente pidió token en la
 * petición. Los fallos se tragan: el progreso es informativo, no un resultado.
 */
function progressReporter(
  ctx: ServerContext,
  token: string | number | undefined,
  requestId: string | number,
): (progress: number, message: string) => void {
  if (token === undefined) return () => undefined;

  return (progress, message) => {
    void ctx.server.server
      .notification(
        {
          method: 'notifications/progress',
          params: { progressToken: token, progress, total: PROGRESS_TOTAL, message },
        },
        { relatedRequestId: requestId },
      )
      .catch(() => undefined);
  };
}

/** Explain — el plan sin ejecutar el SQL y el asesor de índices. */
export function registerExplain(ctx: ServerContext): void {
  ctx.server.registerTool(
    'explain_plan',
    {
      description:
        'Generate and return the Oracle execution plan for a SQL statement via EXPLAIN PLAN and DBMS_XPLAN, without executing the statement. Needs a PLAN_TABLE; if it is missing or the user lacks access, the failure is surfaced as an error result. Reports progress to clients that pass a progress token.',
      inputSchema: {
        sql: z
          .string()
          .describe(
            'The SQL statement to plan (typically SELECT, INSERT, UPDATE, DELETE or MERGE).',
          ),
      },
    },
    async (args, extra) =>
      withToolContext('explain_plan', args, () =>
        guardTool(async () => {
          const report = progressReporter(ctx, extra._meta?.progressToken, extra.requestId);
          report(10, `Planning ${args.sql}`);
          const plan = await explainPlan(ctx.dataAccess, args.sql);
          report(90, 'Plan ready');
          return { content: [{ type: 'text', text: plan }] };
        }),
      ),
  );

  ctx.server.registerTool(
    'suggest_index',
    {
      description:
        'Analyse a SQL statement via EXPLAIN PLAN and, when a table is read by full scan, propose a CREATE INDEX statement. Returns the recommended DDL as text; it is never executed. Apply it manually only after DBA review.',
      inputSchema: {
        sql: z
          .string()
          .describe('The SQL statement to analyse (typically SELECT; DML is also supported).'),
        targetTable: z
          .string()
          .describe('Optional table name to focus on when several tables are scanned.')
          .optional(),
      },
    },
    async (args) =>
      withToolContext('suggest_index', args, () =>
        guardTool(async () => ({
          content: [json(await suggestIndex(ctx.dataAccess, args.sql, args.targetTable))],
        })),
      ),
  );

  ctx.server.registerTool(
    'list_unused_indexes',
    {
      description:
        "List indexes with their columns and best-effort usage information. The likely_unused flag is YES/NO when index monitoring is enabled, otherwise UNKNOWN. Definitive 'unused' answers require a DBA to run ALTER INDEX ... MONITORING USAGE.",
      inputSchema: {
        schema: z
          .string()
          .describe(
            'Schema (table owner). Omit rather than guess: defaults to the schema of the current session.',
          )
          .optional(),
      },
    },
    async (args) =>
      withToolContext('list_unused_indexes', args, () =>
        guardTool(async () => ({
          content: [
            json(
              await listUnusedIndexes(
                ctx.dataAccess,
                resolveSchema(args.schema, ctx.config.schema, 'list_unused_indexes'),
              ),
            ),
          ],
        })),
      ),
  );

  ctx.server.registerTool(
    'run_sql_tuning_advisor',
    {
      description:
        "Run Oracle's SQL Tuning Advisor (DBMS_SQLTUNE) on a statement and return its TEXT report with recommendations (indexes, SQL profiles, statistics, rewrites). Requires the ADVISOR privilege; a missing privilege is surfaced as an error result. Reports progress to clients that pass a progress token.",
      inputSchema: {
        sql: z.string().describe('The SQL statement to tune.'),
      },
    },
    async (args, extra) =>
      withToolContext('run_sql_tuning_advisor', args, () =>
        guardTool(async () => {
          const report = progressReporter(ctx, extra._meta?.progressToken, extra.requestId);
          report(10, 'Running SQL Tuning Advisor');
          const tuning = await runSqlTuningAdvisor(ctx.dataAccess, args.sql);
          report(90, 'Tuning report ready');
          return { content: [{ type: 'text', text: tuning }] };
        }),
      ),
  );
}
