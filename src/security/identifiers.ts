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

/** Literal seguro y ya entrecomillado, para tools que no aceptan binds. */
export function safeLiteral(value: string): string {
  if (!SAFE_LITERAL.test(value)) {
    throw new SecurityError(`literal no permitido: ${JSON.stringify(value)}`);
  }
  return quoteLiteral(value);
}
