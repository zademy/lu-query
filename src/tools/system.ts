import { withToolContext } from '../audit/context.js';
import type { DataAccess } from '../db/data-access.js';
import { asToolError } from '../errors.js';
import type { ServerContext } from '../server.js';

/** Identidad de la conexión, con los mismos campos que el record ConnectionInfo del Java. */
export interface ConnectionInfo {
  databaseVersion: string;
  databaseName: string;
  currentUser: string;
  currentSchema: string;
  instanceName: string;
}

/** Una sola ida y vuelta, como el SystemService#connectionInfo del Java. */
const CONNECTION_INFO_SQL = `SELECT (SELECT banner FROM v$version WHERE ROWNUM = 1) AS version,
       SYS_CONTEXT('USERENV', 'DB_NAME')       AS db_name,
       SYS_CONTEXT('USERENV', 'SESSION_USER')   AS current_user,
       SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS current_schema,
       SYS_CONTEXT('USERENV', 'INSTANCE_NAME')  AS instance_name
FROM   dual`;

function text(value: unknown): string {
  // Estas cinco columnas son VARCHAR2/NUMBER; null o cualquier otra cosa va vacía.
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

/** Estado de la conexión a Oracle; todo el SQL pasa por el chokepoint DataAccess. */
export async function connectionInfo(dataAccess: DataAccess): Promise<ConnectionInfo> {
  const row = (await dataAccess.queryForObject(CONNECTION_INFO_SQL)) ?? {};

  return {
    databaseVersion: text(row.VERSION),
    databaseName: text(row.DB_NAME),
    currentUser: text(row.CURRENT_USER),
    currentSchema: text(row.CURRENT_SCHEMA),
    instanceName: text(row.INSTANCE_NAME),
  };
}

/** System — verifica conectividad e identidad (test_connection). */
export function registerSystem(ctx: ServerContext): void {
  ctx.server.registerTool(
    'test_connection',
    {
      description:
        'Verify connectivity to Oracle and report the database version, name, current user, current schema and instance name. WHEN TO CALL: only when the user explicitly asks to verify the connection or diagnose reachability; do NOT call as a preamble before answering a query about tables, data, or schema objects.',
    },
    async () =>
      // El contexto de auditoría viaja por AsyncLocalStorage hasta el DataAccess.
      withToolContext('test_connection', {}, async () => {
        try {
          const info = await connectionInfo(ctx.dataAccess);
          return { content: [{ type: 'text' as const, text: JSON.stringify(info) }] };
        } catch (error) {
          // Nunca una excepción por el transporte: el Java devuelve isError con el mensaje.
          return { ...asToolError(error) };
        }
      }),
  );
}
