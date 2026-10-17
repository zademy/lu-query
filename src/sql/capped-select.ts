import { MAX_ROWS } from '../config.js';

/** Acota max_rows al rango [1, MAX_ROWS] del Java. */
export function clampMaxRows(requested: number | undefined): number {
  if (requested === undefined || Number.isNaN(requested)) return MAX_ROWS;
  return Math.min(Math.max(Math.trunc(requested), 1), MAX_ROWS);
}

const ALREADY_CAPPED = /\bfetch\s+(first|next)\b|\brow_limiting|\brownum\b/i;

/**
 * Envuelve un SELECT en un tope de ROWNUM para que ninguna query se traiga
 * más filas de las permitidas. Si el SQL ya trae su propio tope, se respeta.
 */
export function buildCappedSelect(sql: string, maxRows?: number): string {
  const body = sql.replace(/;\s*$/, '').trim();
  if (ALREADY_CAPPED.test(body)) return body;
  return `SELECT * FROM ( ${body} ) WHERE ROWNUM <= ${clampMaxRows(maxRows)}`;
}
