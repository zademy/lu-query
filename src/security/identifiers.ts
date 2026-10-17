import { SecurityError } from '../errors.js';

/** Allow-list de identificadores del Java: `^[A-Za-z][A-Za-z0-9_$#]{0,127}$`. */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_$#]{0,127}$/;

/** Un literal no puede inyectar una segunda sentencia: nada de `;`. */
const SAFE_LITERAL = /^[^;]*$/;

export function isValidIdentifier(name: string): boolean {
  return IDENTIFIER.test(name);
}

/** Valida el identificador y lo devuelve; si no, SecurityError con el valor. */
export function assertIdentifier(name: string, label = 'identificador'): string {
  if (!isValidIdentifier(name)) {
    throw new SecurityError(`${label} inválido: ${JSON.stringify(name)}`);
  }
  return name;
}

/** Escapa la comilla simple duplicándola (paridad con el escape del Java). */
export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Valida el identificador y lo entrecomilla: `EMP` → `"EMP"`. */
export function quoteIdentifier(name: string, label = 'identificador'): string {
  return `"${assertIdentifier(name, label)}"`;
}

/** Nombre cualificado de dos partes, ambas validadas: `S`,`T` → `"S"."T"`. */
export function qualifiedName(schema: string, name: string): string {
  return `${quoteIdentifier(schema, 'schema')}.${quoteIdentifier(name)}`;
}

/** CSV de identificadores validados y entrecomillados: `[A,B]` → `"A", "B"`. */
export function quoteCsv(names: readonly string[]): string {
  return names.map((name) => quoteIdentifier(name, 'columna')).join(', ');
}

/**
 * Entrecomilla SIN validar, duplicando la doble comilla: para nombres leídos
 * del diccionario de Oracle (`ALL_*`), que son identificadores reales y pueden
 * traer caracteres especiales. Nunca para entrada de usuario.
 */
export function quoteTrustedIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Nombre cualificado de dos partes del diccionario, sin validar. */
export function qualifiedTrustedName(schema: string, name: string): string {
  return `${quoteTrustedIdentifier(schema)}.${quoteTrustedIdentifier(name)}`;
}

/** Literal seguro y ya entrecomillado, para tools que no aceptan binds. */
export function safeLiteral(value: string): string {
  if (!SAFE_LITERAL.test(value)) {
    throw new SecurityError(`literal no permitido: ${JSON.stringify(value)}`);
  }
  return quoteLiteral(value);
}
