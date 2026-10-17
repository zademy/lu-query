import { z } from 'zod';
import { withToolContext } from '../audit/context.js';
import { auditStatement } from '../audit/audit-writer.js';
import { TIMEOUTS, type ResolvedConfig } from '../config.js';
import type { DataAccess } from '../db/data-access.js';
import {
  loadOracle,
  type OracleConnection,
  type OracleModule,
  type OracleRow,
} from '../db/oracle-types.js';
import { currentSchemaInitSql } from '../db/pool.js';
import { guardTool, SecurityError } from '../errors.js';
import type { ServerContext } from '../server.js';
import { buildCappedSelect } from '../sql/capped-select.js';
import { classifyDml, parseDmlTarget, type DmlKind } from '../sql/dml-parser.js';

/** Filas de muestra del preview (`oracle.mcp.default-sample-rows` del Java). */
const PREVIEW_SAMPLE_ROWS = 10;

/** Mismos campos que el record DmlResult del Java. */
export interface DmlResult {
  statementKind: DmlKind;
  rowsAffected: number;
}

/** Mismos campos que el record DmlPreviewResult del Java. */
export interface DmlPreviewResult {
  detectedKind: DmlKind;
  table: string;
  affectedRowCount: number;
  sampleColumns: string[];
  sampleRows: OracleRow[];
  sampleCount: number;
  note: string;
}

/** Mismos campos que el record DmlDryRunResult del Java. */
export interface DmlDryRunResult {
  detectedKind: DmlKind;
  rowsAffected: number;
  rolledBack: boolean;
  note: string;
}

/** Cómo termina la transacción que ejecuta el DML. */
export type TransactionOutcome = 'commit' | 'rollback';

/**
 * Conexión con control de transacción. `db/oracle-types` declara el subset que
 * usa el chokepoint, que no incluye transacciones: lo que necesitan estas tools
 * se declara aquí.
 */
export interface TransactionConnection extends OracleConnection {
  autoCommit: boolean;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * Ejecuta el DML en una transacción propia y la cierra con commit o rollback.
 *
 * Las tools no pueden usar `DataAccess.execute`: en oracledb@26 thin solo un
 * `commit()` explícito deja el cambio persisted (con autoCommit sin efecto), y
 * cada llamada del chokepoint toma y devuelve una conexión del pool, así que
 * su DML se pierde al cerrar. Por eso el DML de escritura abre conexión y
 * decide él mismo el desenlace.
 */
export async function runInTransaction(
  open: () => Promise<TransactionConnection>,
  sql: string,
  outcome: TransactionOutcome,
): Promise<number> {
  const connection = await open();
  connection.autoCommit = false;
  try {
    const rowsAffected = (await connection.execute(sql)).rowsAffected ?? 0;
    if (outcome === 'commit') await connection.commit();
    else await connection.rollback();
    return rowsAffected;
  } finally {
    // Sin confirmar, cerrar la conexión revierte lo que quedara vivo.
    await connection.close();
  }
}

/**
 * SELECT espejo del DML: el conteo y la muestra salen del WHERE parseado, nunca
 * de ejecutar el DML. Solo UPDATE y DELETE; INSERT y MERGE no se pueden predecir
 * con un SELECT, así que se rechazan.
 */
async function previewDml(dataAccess: DataAccess, sql: string): Promise<DmlPreviewResult> {
  const { kind, where } = classifyDml(sql);
  if (kind !== 'UPDATE' && kind !== 'DELETE') {
    throw new SecurityError(
      `execute_dml_preview solo admite UPDATE o DELETE (recibido: ${kind}); para INSERT o MERGE usa execute_dml_rollback_first`,
    );
  }

  const target = parseDmlTarget(sql);
  if (!target) {
    throw new SecurityError(
      'No se pudo extraer la tabla del DML, así que no hay SELECT espejo que ejecutar.',
    );
  }

  const from = `FROM ${target.table}${where === null ? '' : ` WHERE ${where}`}`;
  const countRow = await dataAccess.queryForObject(`SELECT COUNT(*) ${from}`);
  // Oracle rotula la columna como COUNT(*); el valor es lo único que importa.
  const affectedRowCount = Number(Object.values(countRow ?? {})[0] ?? 0);

  const sampleRows = await dataAccess.queryForList(
    buildCappedSelect(`SELECT * ${from}`, PREVIEW_SAMPLE_ROWS),
    undefined,
    { maxRows: PREVIEW_SAMPLE_ROWS },
  );

  return {
    detectedKind: kind,
    table: target.table,
    affectedRowCount,
    sampleColumns: sampleRows[0] === undefined ? [] : Object.keys(sampleRows[0]),
    sampleRows,
    sampleCount: sampleRows.length,
    note:
      'Dry-run preview: the statement was NOT executed. ' +
      `${affectedRowCount} row(s) would be affected. ` +
      'Call execute_dml to apply, or execute_dml_rollback_first to dry-run the write.',
  };
}

/** node-oracledb solo tipa `createPool`; `getConnection` es la otra forma de abrir sesión. */
interface DirectOracle extends OracleModule {
  getConnection(attributes: {
    user?: string;
    password?: string;
    connectString?: string;
    connectTimeout: number;
  }): Promise<OracleConnection>;
}

/**
 * Conexión propia del DML, con el mismo `ALTER SESSION` de ORACLE_DB_SCHEMA que
 * aplica el pool. No sale del pool porque este es el pool del chokepoint DataAccess
 * y su vida la manda él, no la tool.
 */
async function openDmlConnection(config: ResolvedConfig): Promise<TransactionConnection> {
  const oracledb = (await loadOracle()) as DirectOracle;
  const connection = (await oracledb.getConnection({
    user: config.user,
    password: config.password,
    connectString: config.connectString,
    connectTimeout: TIMEOUTS.socketSeconds,
  })) as TransactionConnection;
  connection.callTimeout = TIMEOUTS.socketSeconds * 1000;

  const initSql = currentSchemaInitSql(config.schema);
  if (initSql) await connection.execute(initSql);
  return connection;
}

/**
 * Aplica el DML y lo confirma. El kind solo etiqueta el resultado: Oracle es el
 * que autoriza, así que un kind `UNKNOWN` (MERGE y compañía) se manda igual.
 */
async function executeDml(ctx: ServerContext, sql: string): Promise<DmlResult> {
  const statementKind = classifyDml(sql).kind;
  // Se audita a mano porque la conexión no pasa por el chokepoint DataAccess.
  const rowsAffected = await auditStatement(
    sql,
    () => runInTransaction(() => openDmlConnection(ctx.config), sql, 'commit'),
    (rows) => rows,
  );
  return { statementKind, rowsAffected };
}

/** Ejecuta el DML y lo revierte siempre: valida la sentencia sin persistir nada. */
async function rollbackFirstDml(ctx: ServerContext, sql: string): Promise<DmlDryRunResult> {
  const detectedKind = classifyDml(sql).kind;
  const rowsAffected = await auditStatement(
    sql,
    () => runInTransaction(() => openDmlConnection(ctx.config), sql, 'rollback'),
    (rows) => rows,
  );

  return {
    detectedKind,
    rowsAffected,
    rolledBack: true,
    note: 'Statement executed and rolled back; nothing was persisted. Call execute_dml to apply the change.',
  };
}

function json(value: unknown): { type: 'text'; text: string } {
  return { type: 'text', text: JSON.stringify(value) };
}

/** Dml — las tres modalidades de escritura del DmlService del Java. */
export function registerDml(ctx: ServerContext): void {
  /** Las tres tools comparten un único parámetro `sql` y el mismo envoltorio. */
  const register = (
    name: string,
    description: string,
    sqlParam: string,
    run: (ctx: ServerContext, sql: string) => Promise<unknown>,
  ) => {
    ctx.server.registerTool(
      name,
      { description, inputSchema: { sql: z.string().describe(sqlParam) } },
      async (args) =>
        // El contexto de auditoría viaja por AsyncLocalStorage; guardTool evita
        // que una excepción de Oracle rompa el transporte.
        withToolContext(name, args, () =>
          guardTool(async () => ({ content: [json(await run(ctx, args.sql))] })),
        ),
    );
  };

  register(
    'execute_dml',
    'Execute a single INSERT, UPDATE, DELETE or MERGE statement on existing tables and auto-commit it (no explicit COMMIT needed; there is no cross-call transaction boundary). One statement per call. Returns the number of rows affected; if the Oracle user lacks the required privileges the failure surfaces as an error result (isError=true).',
    'A single INSERT, UPDATE, DELETE or MERGE statement.',
    (context, sql) => executeDml(context, sql),
  );
  register(
    'execute_dml_preview',
    'Dry-run an UPDATE or DELETE without executing it. Returns the total number of rows that would be affected plus a sample of those rows. INSERT and MERGE are not supported; use execute_dml_rollback_first for those.',
    'A single UPDATE or DELETE statement to preview (not execute).',
    (context, sql) => previewDml(context.dataAccess, sql),
  );
  register(
    'execute_dml_rollback_first',
    'Execute an INSERT, UPDATE, DELETE or MERGE inside a transaction that is immediately rolled back. Nothing is persisted; the tool only proves the statement is valid and reports the number of rows affected. Call execute_dml afterwards to apply the change for real.',
    'A single INSERT, UPDATE, DELETE or MERGE statement to dry-run (executed then rolled back).',
    (context, sql) => rollbackFirstDml(context, sql),
  );
}
