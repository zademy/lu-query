import type { OracleBind } from '../db/oracle-types.js';

/**
 * Substring del cliente → patrón LIKE de Oracle (`LikePatterns` del Java).
 * Si el cliente ya trae `%` o `_` se usa tal cual (sin escaparlos), y se
 * mayuscula siempre porque el diccionario de Oracle guarda los nombres asi.
 */
export function likePattern(namePattern: string | undefined): string {
  if (namePattern === undefined || namePattern.trim() === '') return '%';
  if (namePattern.includes('%') || namePattern.includes('_')) return namePattern.toUpperCase();
  return `%${namePattern.toUpperCase()}%`;
}

/** Filtro opcional de owner: sin schema, el predicado `IS NULL` matchea todo. */
export function ownerBinds(schema: string | undefined): OracleBind[] {
  return [schema ?? null, schema ?? null];
}

/**
 * Punto y coma final, aunque detrás venga un comentario. Sólo el terminador: el
 * cuerpo de la sentencia viaja verbatim a Oracle, así que un `--` dentro de un
 * literal no se toca (no hay `;` detrás, y el regex exige el final).
 */
export function stripTrailingTerminator(sql: string): string {
  return sql.replace(/;(\s*(?:--[^\n]*\n?|\/\*[\s\S]*?\*\/)*\s*)$/, '$1').trim();
}
