import { ConfigError } from '../errors.js';

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
