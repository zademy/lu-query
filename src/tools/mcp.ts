import type { ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import { withToolContext } from '../audit/context.js';
import type { DataAccess } from '../db/data-access.js';
import { guardTool, type ToolTextResult } from '../errors.js';
import type { ServerContext } from '../server.js';

/** Los args de una tool: lo que el SDK entrega tras validar el inputSchema. */
type ShapeOutput<Shape extends z.ZodRawShape> = { [K in keyof Shape]: z.infer<Shape[K]> };

/** Lo unico del `extra` del SDK que una tool puede necesitar. */
type ToolExtra = Parameters<ToolCallback<z.ZodRawShape>>[1];

type ToolRun = (
  dataAccess: DataAccess,
  args: Record<string, unknown>,
  extra: ToolExtra,
) => Promise<ToolTextResult>;

/**
 * Registra una tool por el camino que comparten las 75: contexto de auditoria,
 * timeout de request y excepcion convertida en resultado MCP. Que texto sale lo
 * decide `run` con los helpers de abajo, que es donde vive la paridad.
 */
export function vTool<Shape extends z.ZodRawShape>(
  ctx: ServerContext,
  name: string,
  description: string,
  shape: Shape,
  run: (
    dataAccess: DataAccess,
    args: ShapeOutput<Shape>,
    extra: ToolExtra,
  ) => Promise<ToolTextResult>,
): void;
/** Tool sin parámetros: sin inputSchema, como las que no reciben nada del cliente. */
export function vTool(ctx: ServerContext, name: string, description: string, run: ToolRun): void;
export function vTool(
  ctx: ServerContext,
  name: string,
  description: string,
  shapeOrRun: z.ZodRawShape | ToolRun,
  maybeRun?: ToolRun,
): void {
  const shape = maybeRun === undefined ? undefined : (shapeOrRun as z.ZodRawShape);
  const run = (maybeRun ?? shapeOrRun) as ToolRun;
  // Sin inputSchema el SDK llama al handler con un solo argumento (`extra`),
  // no con los args: por eso esta rama no los inventa.
  if (shape === undefined) {
    const sinArgs: ToolCallback<undefined> = (extra) =>
      withToolContext(name, {}, () => guardTool(() => run(ctx.dataAccess, {}, extra)));
    ctx.server.registerTool(name, { description }, sinArgs);
    return;
  }

  // El SDK solo puede tipar el handler con el shape ya resuelto; el cast
  // de `raw` traduce ese shape al que declara `run`.
  const handler: ToolCallback<z.ZodRawShape> = (raw, extra) =>
    withToolContext(name, raw, () => guardTool(() => run(ctx.dataAccess, raw, extra)));
  ctx.server.registerTool(name, { description, inputSchema: shape }, handler);
}

/** Bloque de texto con el valor en JSON: la respuesta de las tools con estructura. */
export function jsonResult(value: unknown): ToolTextResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/** Texto literal: la respuesta cruda que devuelve el driver (DDL, EXPLAIN). */
export function rawResult(text: string): ToolTextResult {
  return { content: [{ type: 'text', text }] };
}

/**
 * Regla del catalogo: un `string` es el aviso literal del Java (p. ej.
 * `Sequence not found: X.Y`); cualquier otro valor va serializado como JSON.
 */
export function catalogResult(value: unknown): ToolTextResult {
  return rawResult(typeof value === 'string' ? value : JSON.stringify(value));
}

/** Contenido de un recurso MCP de texto plano. */
export function plainResource(
  uri: string,
  text: string,
): {
  contents: { uri: string; mimeType: string; text: string }[];
} {
  return { contents: [{ uri, mimeType: 'text/plain', text }] };
}

/** Total que anuncia cada notificación de progreso (no hay pasos reales). */
export const PROGRESS_TOTAL = 100;

/** Aviso de progreso MCP; sin token del cliente no hay nada que avisar. */
export function progressReporter(
  ctx: ServerContext,
  token: string | number | undefined,
  requestId: string | number,
): (progress: number, message: string) => void {
  if (token === undefined) return () => undefined;

  return (progress, message) => {
    void ctx.server.server
      .notification(
        {
          method: 'notifications/progress',
          params: { progressToken: token, progress, total: PROGRESS_TOTAL, message },
        },
        { relatedRequestId: requestId },
      )
      .catch(() => undefined);
  };
}
