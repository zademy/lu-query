import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Contexto de la tool en curso: el equivalente del MDC del Java (`mcp.tool` y
 * `mcp.params`). Vive en `AsyncLocalStorage` para que el chokepoint DataAccess
 * lo lea sin que las tools tengan que pasarlo a mano.
 */
export interface ToolAuditContext {
  tool: string;
  /** Parámetros ya formateados `name=value, name2=value2`. */
  params: string;
}

const context = new AsyncLocalStorage<ToolAuditContext>();

function paramValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  try {
    // Objetos y arrays (IN-lists, filtros) como JSON legible, nunca [object Object].
    return JSON.stringify(value) ?? 'null';
  } catch {
    return typeof value;
  }
}

/** Formatea los argumentos de una tool como los muestra la auditoría. */
export function formatAuditParams(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([name, value]) => `${name}=${paramValue(value)}`)
    .join(', ');
}

/** Ejecuta `run` con el contexto de auditoría de la tool visible en DataAccess. */
export function withToolContext<T>(
  tool: string,
  args: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  return context.run({ tool, params: formatAuditParams(args) }, run);
}

/** Tool y parámetros de la llamada en curso; `undefined` fuera de una tool. */
export function currentToolContext(): ToolAuditContext | undefined {
  return context.getStore();
}
