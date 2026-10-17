import type { ServerContext } from '../server.js';
import { ConfigError } from '../errors.js';

/**
 * Schema de respaldo para las tools: el configurado (ORACLE_DB_SCHEMA) o, si
 * no hay, el schema de la sesión ya resuelto (`SYS_CONTEXT`), que es lo que
 * devuelve `SchemaCatalog.currentSchema()` en el Java.
 */
export function schemaFallback(ctx: ServerContext): string | undefined {
  return ctx.config.schema ?? ctx.sessionSchema;
}

/**
 * Resuelve contra qué schema opera una tool: el pedido explícito gana; si no,
 * el schema de la sesión o el configurado (ORACLE_DB_SCHEMA). Sin ninguno de
 * los dos no hay forma de armar las queries de catálogo, así que se falla.
 */
export function resolveSchema(
  requested: string | undefined,
  fallback: string | undefined,
  toolName: string,
): string {
  const schema = requested?.trim() || fallback?.trim();
  if (!schema) {
    throw new ConfigError(
      `${toolName} necesita un schema: pasa el argumento schema o define ORACLE_DB_SCHEMA`,
    );
  }
  return schema;
}

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
      const session = row?.current_schema;
      if (typeof session === 'string' && session.length > 0) ctx.sessionSchema = session;
    } catch {
      // sin sesión no hay schema: resolveSchema lanza el mensaje de la tool
    }
  }

  return resolveSchema(requested, schemaFallback(ctx), toolName);
}
