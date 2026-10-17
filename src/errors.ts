import { TIMEOUTS } from './config.js';

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

/**
 * Resultado MCP de error, tal como lo espera el cliente. Son alias y no
 * `interface` porque el `CallToolResult` del SDK lleva index signature y una
 * interface sin ella no le es asignable.
 */
export type ToolErrorResult = {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
};

/** Resultado MCP de éxito de una tool que solo devuelve texto. */
export type ToolTextResult = {
  content: Array<{ type: 'text'; text: string }>;
};

/**
 * Códigos ORA que son cancelación o interrupción, no un fallo de la BD: el
 * cliente cortó la sentencia o se cayó el canal con ella. El equivalente del
 * `InterruptDiagnosticAspect` del Java: se reportan como cancelación.
 */
const CANCELLED_CODES = ['ORA-01013', 'ORA-03113', 'ORA-03114'];

const ORACLE_PREFIX = 'Oracle error: ';

const HINT_FOOTER = '\n  ↳ Pull the @oracle-sql-style prompt for the full authoring rules.';

/**
 * Código ORA → causa probable y arreglo, verbatim del `SqlErrorHints` del
 * Java. Solo texto estático: el hint nunca copia datos de la base de datos.
 */
const ORA_HINTS: Record<string, string> = {
  'ora-00923':
    'Likely cause: a reserved word used as an alias without AS, a missing comma between SELECT-list columns, or a non-quoted/mis-quoted identifier. Fix: alias with AS or "alias"; separate every column with a comma; quote mixed-case identifiers with double quotes.',
  'ora-00936':
    'Likely cause: missing operand — empty SELECT list, dangling/trailing comma, or a missing value after an operator. Fix: complete each expression and remove trailing commas.',
  'ora-00904':
    'Likely cause: a column/alias name is misspelled or absent from this table. Fix: call describe_table to confirm the exact name; remember Oracle folds unquoted identifiers to UPPERCASE.',
  'ora-00911':
    "Likely cause: a trailing semicolon ';' or a wrong quote character (backtick/bracket). Fix: send a single statement with no trailing ';' and use double quotes for identifiers, single quotes for literals.",
  'ora-00933':
    'Likely cause: extra text after the statement, or a non-Oracle clause (e.g. MySQL LIMIT). Fix: send one statement only; paginate with OFFSET n ROWS FETCH NEXT m ROWS ONLY, not LIMIT.',
  'ora-00907':
    "Likely cause: an unbalanced '('. Fix: count and match parentheses in function calls and subqueries.",
  'ora-01756':
    "Likely cause: an unterminated string literal. Fix: close every '...'; escape a literal quote as '' (two single quotes).",
  'ora-01790':
    'Likely cause: mismatched column types/counts in a UNION/UNION ALL/MINUS/INTERSECT. Fix: align the number and type of columns in each branch; use TO_DATE/TO_NUMBER for explicit conversion.',
  'ora-00942':
    'Likely cause: the table/view name is wrong, or the least-privilege user has no SELECT grant on it. Fix: call list_tables/describe_table to confirm the exact schema.name; visibility is bounded by the grants in db/setup_least_privilege_user.sql.',
  'ora-01031':
    'By design: the least-privilege user has no DDL/DCL privileges. Fix: structural changes (CREATE/ALTER/DROP/GRANT/...) must be run by a DBA; do not widen the MCP user grants.',
  'ora-00939':
    'Likely cause: the current schema has no privilege on the object. Fix: qualify the name with its owner and ask a DBA for the SELECT grant.',
};

/** Código ORA mentioned anywhere in the error text (message + `code`). */
function oracleCode(text: string): string | undefined {
  return /ORA-\d{5}/i.exec(text)?.[0];
}

/** Código y mensaje del error, como los ve el driver (sin repetir el código). */
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || code === '' || message.includes(code)) return message;
  return `${code} ${message}`;
}

/**
 * Traduce el error al texto que ve el cliente: los hints de ORA del Java para
 * los códigos frecuentes, y una cancelación (no un fallo de la BD) cuando el
 * cliente interrumpió la sentencia, sin copiar el detalle del driver.
 */
function errorMessage(error: unknown): string {
  const text = errorText(error);
  const code = oracleCode(text);

  if (code !== undefined && CANCELLED_CODES.includes(code.toUpperCase())) {
    return `Query cancelled by the client (${code}); the statement did not fail in the database.`;
  }

  if (code === undefined) return text;

  const lower = text.toLowerCase();
  const hint = Object.entries(ORA_HINTS).find(([known]) => lower.includes(known))?.[1];
  return hint === undefined
    ? ORACLE_PREFIX + text
    : `${ORACLE_PREFIX}${text}\n  ↳ ${hint}${HINT_FOOTER}`;
}

/** Convierte cualquier excepción en un resultado de tool con mensaje útil (#5). */
export function asToolError(error: unknown): ToolErrorResult {
  return { isError: true, content: [{ type: 'text', text: errorMessage(error) }] };
}

/**
 * Envuelve el handler de una tool para que ninguna excepción llegue al
 * transporte: es el `ToolErrors.propagate` del Java, el mismo contrato que
 * aplica la tool de sistema.
 */
export async function guardTool<T extends ToolTextResult>(
  run: () => Promise<T>,
  timeoutMs: number = TIMEOUTS.requestMs,
): Promise<T | ToolErrorResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new DataAccessError(
                `La tool excedió el timeout de request MCP (${timeoutMs} ms); el statement se cancela antes por el timeout de ${TIMEOUTS.statementMs} ms.`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    return asToolError(error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
