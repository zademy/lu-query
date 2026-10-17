/**
 * Errores del dominio. Toda excepción que cruza una tool se convierte en un
 * resultado MCP `isError` (contrato del Java: nunca rompen el transporte).
 */

/** Configuración inválida o ausente (env vars, URL JDBC, versión de runtime). */
export class ConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConfigError';
  }
}

/** Fallo de la capa Oracle (ORA-xxxxx envuelto, pool, timeout). */
export class DataAccessError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'DataAccessError';
  }
}

/** Entrada de usuario que no pasa la allow-list (identificadores, literales). */
export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

/** Resultado MCP de error, tal como lo espera el cliente. */
export interface ToolErrorResult {
  isError: true;
  content: [{ type: 'text'; text: string }];
}

/** Convierte cualquier excepción en un resultado de tool con mensaje útil (#5). */
export function asToolError(error: unknown): ToolErrorResult {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: 'text', text: message }] };
}
