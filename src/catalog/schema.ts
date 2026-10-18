import type { ServerContext } from '../server.js';
import { ConfigError } from '../errors.js';

/** `SYS_CONTEXT`, el equivalente de `SchemaCatalog.currentSchema()` del Java. */
const SESSION_SCHEMA_SQL =
  "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS current_schema FROM DUAL";

/**
 * Schema efectivo de una tool de catálogo: el pedido explícito gana; si no,
 * el configurado (ORACLE_DB_SCHEMA); y si tampoco hay, el de la sesión,
 * consultado una sola vez y cacheado en el contexto. El pool es lazy, así
 * que la sesión no se toca hasta que una tool la necesita.
 */
export async function resolveSchemaFor(
  ctx: ServerContext,
  requested: string | undefined,
  toolName: string,
): Promise<string> {
  const explicit = requested?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;

  // La sesión es el último recurso: con ORACLE_DB_SCHEMA no se consulta.
  if (ctx.config.schema === undefined && ctx.sessionSchema === undefined) {
    try {
      const row = await ctx.dataAccess.queryForObject(SESSION_SCHEMA_SQL);
      // oracledb devuelve el nombre de columna en mayúsculas, como system.ts:35.
      const session = row?.CURRENT_SCHEMA;
      if (typeof session === 'string' && session.length > 0) ctx.sessionSchema = session;
    } catch {
      // sin sesión no hay schema: el mensaje de la tool lo dice más abajo
    }
  }

  const resolved = explicit || ctx.config.schema?.trim() || ctx.sessionSchema?.trim();
  if (resolved === undefined || resolved.length === 0) {
    throw new ConfigError(
      `${toolName} necesita un schema: pasa el argumento schema o define ORACLE_DB_SCHEMA`,
    );
  }
  return resolved;
}
