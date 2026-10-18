import { z } from 'zod';

import type { DataAccess } from '../db/data-access.js';
import type { OracleRow } from '../db/oracle-types.js';
import { SecurityError } from '../errors.js';
import { jsonResult, vTool } from './mcp.js';
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

/**
 * SELECT espejo del DML: el conteo y la muestra salen del WHERE parseado, nunca
 * de ejecutar el DML. Solo UPDATE y DELETE; INSERT y MERGE no se pueden predecir
 * con un SELECT, así que se rechazan.
 */
async function previewDml(dataAccess: DataAccess, sql: string): Promise<DmlPreviewResult> {
  const { kind, where, alias } = classifyDml(sql);
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

  // El alias va con la tabla: si el WHERE lo menciona, el SELECT espejo lo necesita.
  const from =
    `FROM ${target.table}${alias === null ? '' : ` ${alias}`}` +
    `${where === null ? '' : ` WHERE ${where}`}`;
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

/**
 * Aplica el DML y lo confirma. El kind solo etiqueta el resultado: Oracle es el
 * que autoriza, así que un kind `UNKNOWN` (MERGE y compañía) se manda igual.
 */
async function executeDml(ctx: ServerContext, sql: string): Promise<DmlResult> {
  const statementKind = classifyDml(sql).kind;
  const rowsAffected = await ctx.dataAccess.executeInTransaction(sql, 'commit');
  return { statementKind, rowsAffected };
}

/** Ejecuta el DML y lo revierte siempre: valida la sentencia sin persistir nada. */
async function rollbackFirstDml(ctx: ServerContext, sql: string): Promise<DmlDryRunResult> {
  const detectedKind = classifyDml(sql).kind;
  const rowsAffected = await ctx.dataAccess.executeInTransaction(sql, 'rollback');

  return {
    detectedKind,
    rowsAffected,
    rolledBack: true,
    note: 'Statement executed and rolled back; nothing was persisted. Call execute_dml to apply the change.',
  };
}
/** Dml — las tres modalidades de escritura del DmlService del Java. */
export function registerDml(ctx: ServerContext): void {
  // Las tres tools comparten un único parámetro \`sql\` y el mismo envoltorio.
  vTool(
    ctx,
    'execute_dml',
    'Execute a single INSERT, UPDATE, DELETE or MERGE statement on existing tables and auto-commit it (no explicit COMMIT needed; there is no cross-call transaction boundary). One statement per call. Returns the number of rows affected; if the Oracle user lacks the required privileges the failure surfaces as an error result (isError=true).',
    { sql: z.string().describe('A single INSERT, UPDATE, DELETE or MERGE statement.') },
    async (_dataAccess, args) => jsonResult(await executeDml(ctx, args.sql)),
  );
  vTool(
    ctx,
    'execute_dml_preview',
    'Dry-run an UPDATE or DELETE without executing it. Returns the total number of rows that would be affected plus a sample of those rows. INSERT and MERGE are not supported; use execute_dml_rollback_first for those.',
    { sql: z.string().describe('A single UPDATE or DELETE statement to preview (not execute).') },
    async (_dataAccess, args) => jsonResult(await previewDml(ctx.dataAccess, args.sql)),
  );
  vTool(
    ctx,
    'execute_dml_rollback_first',
    'Execute an INSERT, UPDATE, DELETE or MERGE inside a transaction that is immediately rolled back. Nothing is persisted; the tool only proves the statement is valid and reports the number of rows affected. Call execute_dml afterwards to apply the change for real.',
    {
      sql: z
        .string()
        .describe(
          'A single INSERT, UPDATE, DELETE or MERGE statement to dry-run (executed then rolled back).',
        ),
    },
    async (_dataAccess, args) => jsonResult(await rollbackFirstDml(ctx, args.sql)),
  );
}
