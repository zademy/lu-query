import { stripTrailingTerminator } from './text.js';
import { MAX_ROWS } from '../config.js';

/** Página stateless que se aplica a un SELECT: offset base 0 y limit con tope. */
export interface Page {
  offset: number;
  limit: number;
}

/** Acota max_rows al rango [1, MAX_ROWS] del Java. */
export function clampMaxRows(requested: number | undefined): number {
  if (requested === undefined || Number.isNaN(requested)) return MAX_ROWS;
  return Math.min(Math.max(Math.trunc(requested), 1), MAX_ROWS);
}

/** Normaliza offset/limit del cliente: offset base 0, limit al rango [1, MAX_ROWS]. */
export function clampPage(offset: number | undefined, limit: number | undefined): Page {
  const from = offset === undefined || Number.isNaN(offset) ? 0 : Math.trunc(offset);
  return { offset: Math.max(from, 0), limit: clampMaxRows(limit) };
}

const ALREADY_CAPPED = /\bfetch\s+(first|next)\b|\brow_limiting|\brownum\b/i;

/**
 * Envuelve un SELECT en un tope de ROWNUM para que ninguna query se traiga
 * más filas de las permitidas. Si el SQL ya trae su propio tope, se respeta.
 */
export function buildCappedSelect(sql: string, maxRows?: number): string {
  const body = stripTrailingTerminator(sql);
  if (ALREADY_CAPPED.test(body)) return body;
  return `SELECT * FROM ( ${body} ) WHERE ROWNUM <= ${clampMaxRows(maxRows)}`;
}

/**
 * Envoltura de la página pedida, como el `paginate` de QueryService (Java):
 * con offset > 0 envuelve en `OFFSET n ROWS FETCH NEXT m ROWS ONLY`; sin
 * offset, el SQL original solo lleva el tope de filas heredado.
 */
export function buildPagedSelect(sql: string, page: Page): string {
  if (page.offset === 0) return buildCappedSelect(sql, page.limit);
  return `SELECT * FROM ( ${stripTrailingTerminator(sql)} ) OFFSET ${page.offset} ROWS FETCH NEXT ${page.limit} ROWS ONLY`;
}
