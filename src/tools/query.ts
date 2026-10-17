import { z } from 'zod';
import { withToolContext } from '../audit/context.js';
import { MAX_ROWS } from '../config.js';
import type { DataAccess } from '../db/data-access.js';
import type { OracleRow } from '../db/oracle-types.js';
import { guardTool, SecurityError } from '../errors.js';
import { assertIdentifier } from '../security/identifiers.js';
import type { ServerContext } from '../server.js';
import { buildPagedSelect, clampMaxRows, clampPage, type Page } from '../sql/capped-select.js';
import { detectStatementKind } from '../sql/kind.js';

/** Filas por defecto de `get_sample_data` (`oracle.mcp.default-sample-rows`). */
const DEFAULT_SAMPLE_ROWS = 10;

/** Escala de las notificaciones de progreso MCP (10 al empezar, 90 al terminar). */
const PROGRESS_TOTAL = 100;

/** Resultado de una lectura, con los mismos campos que el record QueryResult del Java. */
export interface QueryResult {
  /** Etiquetas de columna, en orden, tal como las devuelve Oracle. */
  columns: string[];
  /** Cada fila como mapa etiqueta→valor. */
  rows: OracleRow[];
  /** Filas realmente devueltas en esta página. */
  rowCount: number;
  /** La página viene llena: es probable que haya más filas detrás del tope. */
  truncated: boolean;
  /** Tope global de filas del server (`max-rows`). */
  rowLimit: number;
  /** Offset aplicado (0 si no se paginó). */
  offset: number;
  /** Límite aplicado a la página. */
  limit: number;
}

interface RunQueryArgs {
  sql: string;
  offset?: number;
  limit?: number;
}

interface SampleDataArgs {
  schema?: string;
  table: string;
  rows?: number;
}

/** Normaliza filas crudas a QueryResult; columnas desde la primera fila. */
function toResult(rows: OracleRow[], page: Page): QueryResult {
  return {
    columns: rows[0] === undefined ? [] : Object.keys(rows[0]),
    rows,
    rowCount: rows.length,
    truncated: rows.length === page.limit,
    rowLimit: MAX_ROWS,
    offset: page.offset,
    limit: page.limit,
  };
}

/**
 * Un SELECT y solo uno. El Java se apoya en el usuario de mínimos privilegios
 * para rechazar el resto; aquí el contrato de la tool de lectura corta antes,
 * que es más barato y no depende de los permisos del usuario Oracle.
 */
function assertSelect(sql: string): void {
  if (sql.trim() === '') throw new SecurityError('SQL vacío: se esperaba un SELECT');
  const kind = detectStatementKind(sql);
  if (kind !== 'select') {
    throw new SecurityError(`run_query solo admite un SELECT (recibido: ${kind})`);
  }
}

/** Identificador validado por la allow-list y entrecomillado, como el Java. */
function quoted(name: string, label: string): string {
  return `"${assertIdentifier(name, label)}"`;
}

/** `SELECT * FROM ( sql ) OFFSET n ROWS FETCH NEXT m ROWS ONLY` según la página pedida. */
async function runQuery(dataAccess: DataAccess, args: RunQueryArgs): Promise<QueryResult> {
  assertSelect(args.sql);
  const page = clampPage(args.offset, args.limit);

  // El SQL ya trae el tope; maxRows es la segunda barrera del driver (su
  // default son 100 filas, no las 1000 del server).
  const rows = await dataAccess.queryForList(buildPagedSelect(args.sql, page), undefined, {
    maxRows: page.limit,
  });
  return toResult(rows, page);
}

/** Primeras N filas de una tabla, con schema explícito o el de la sesión. */
async function sampleData(
  dataAccess: DataAccess,
  defaultSchema: string | undefined,
  args: SampleDataArgs,
  onProgress?: (progress: number, message: string) => void,
): Promise<QueryResult> {
  const owner = args.schema ?? defaultSchema;
  const name = owner
    ? `${quoted(owner, 'schema')}.${quoted(args.table, 'tabla')}`
    : quoted(args.table, 'tabla');
  const requested = args.rows ?? DEFAULT_SAMPLE_ROWS;
  const limit = requested > 0 ? clampMaxRows(requested) : DEFAULT_SAMPLE_ROWS;

  onProgress?.(10, `Sampling ${name}`);
  const rows = await dataAccess.queryForList(
    `SELECT * FROM ${name} FETCH FIRST ${limit} ROWS ONLY`,
  );
  onProgress?.(90, `Sampled ${rows.length} rows from ${name}`);
  return toResult(rows, { offset: 0, limit });
}

function json(value: QueryResult): { type: 'text'; text: string } {
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

/** Query — la herramienta de lectura: run_query y get_sample_data. */
export function registerQuery(ctx: ServerContext): void {
  ctx.server.registerTool(
    'run_query',
    {
      description:
        'Run a single SELECT statement and return the result set. Optional offset/limit enable stateless pagination (non-deterministic without an ORDER BY in the SQL). Non-SELECT statements or privilege failures return an Oracle error string. NOTE: recursive constructs like CONNECT BY and WITH (CTE) may be rejected by the SQL parser; for set differences use MINUS, and for row-number/gap problems prefer computing on the returned result set rather than relying on recursive SQL.',
      inputSchema: {
        sql: z.string().describe('A single SELECT statement.'),
        offset: z
          .number()
          .int()
          .describe('0-based row offset for pagination. Defaults to 0.')
          .optional(),
        limit: z
          .number()
          .int()
          .describe(
            'Maximum rows to return for this page. Capped at the server max-rows. Defaults to the server max.',
          )
          .optional(),
      },
    },
    async (args) =>
      // El contexto de auditoría viaja por AsyncLocalStorage hasta el DataAccess.
      withToolContext('run_query', args, () =>
        guardTool(async () => ({ content: [json(await runQuery(ctx.dataAccess, args))] })),
      ),
  );

  ctx.server.registerTool(
    'get_sample_data',
    {
      description: 'Return the first N rows of a table as a quick data preview.',
      inputSchema: {
        schema: z.string().describe('Schema (owner) of the table.').optional(),
        table: z.string().describe('Table name.'),
        rows: z
          .number()
          .int()
          .describe('Number of rows to return. Defaults to the server default (10).')
          .optional(),
      },
    },
    async (args, extra) =>
      withToolContext('get_sample_data', args, () =>
        guardTool(async () => ({
          content: [
            json(
              await sampleData(
                ctx.dataAccess,
                ctx.config.schema,
                args,
                progressReporter(ctx, extra._meta?.progressToken, extra.requestId),
              ),
            ),
          ],
        })),
      ),
  );
}
