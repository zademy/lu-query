import sqlParser from 'node-sql-parser';
import { stripSqlNoise } from './kind.js';
import { stripTrailingTerminator } from './text.js';

/** Verbo y objeto destino de una sentencia DML. */
export interface DmlTarget {
  kind: 'insert' | 'update' | 'delete' | 'merge';
  /** Como aparece en el SQL (puede incluir schema); el allow-list lo valida. */
  table: string;
}

const DML_VERB = /^(?<verb>INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO)\s+(?<table>[^\s(,]+)/i;

/**
 * Saca el objeto destino de un INSERT/UPDATE/DELETE/MERGE, o null si la
 * sentencia no es DML. No valida el identificador: eso es security/identifiers.
 */
export function parseDmlTarget(sql: string): DmlTarget | null {
  const match = DML_VERB.exec(stripSqlNoise(sql));
  const verb = match?.groups?.verb;
  const table = match?.groups?.table;
  if (!verb || !table) return null;

  const kind = /insert/i.test(verb)
    ? 'insert'
    : /update/i.test(verb)
      ? 'update'
      : /delete/i.test(verb)
        ? 'delete'
        : 'merge';

  return { kind, table };
}

/**
 * node-sql-parser no tiene dialecto Oracle. El de PostgreSQL es el único que
 * emite los identificadores sin entrecomillar, que es lo que Oracle acepta (con
 * MySQL saldrían `` `col` ``, con Snowflake `"col"` casaría mayúsculas).
 */
const PARSER_OPTIONS = { database: 'PostgreSQL' };

const parser = new sqlParser.Parser();

/** Kind de DML que el parser reconoce; `UNKNOWN` deja decidir a Oracle. */
export type DmlKind = 'INSERT' | 'UPDATE' | 'DELETE' | 'MERGE' | 'UNKNOWN';

/** Kind del DML y su WHERE ya serializado, para armar el SELECT espejo. */
export interface DmlClassification {
  kind: DmlKind;
  /** Predicado del WHERE tal cual lo escribió el usuario; null si no filtra. */
  where: string | null;
  /** Alias de la tabla destino, si la sentencia lleva uno. */
  alias: string | null;
}

/** Parte del AST que nos interesa; el resto del árbol no se usa. */
interface DmlAst {
  type?: string;
  table?: unknown;
}

/**
 * Clasifica el DML y extrae su WHERE. Es *best effort* como el `detectKind` del
 * Java: si node-sql-parser no entiende la sentencia (MERGE, DDL, basura) el
 * kind es `UNKNOWN` y la sentencia se envía igual a Oracle, que es el juez.
 */
export function classifyDml(sql: string): DmlClassification {
  let statement: DmlAst | undefined;
  try {
    const parsed = parser.astify(sql, PARSER_OPTIONS);
    statement = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    return { kind: 'UNKNOWN', where: null, alias: null };
  }

  const type = statement?.type?.toUpperCase();
  const kind: DmlKind =
    type === 'INSERT' || type === 'UPDATE' || type === 'DELETE' || type === 'MERGE'
      ? type
      : 'UNKNOWN';
  return { kind, where: originalWhere(sql), alias: tableAlias(statement) };
}

/** Alias de la tabla destino, si lo hay y es un identificador válido. */
function tableAlias(statement: DmlAst | undefined): string | null {
  const tables = statement?.table;
  if (!Array.isArray(tables)) return null;
  const alias = (tables[0] as { as?: string | null } | undefined)?.as;
  return typeof alias === 'string' && /^[A-Za-z][A-Za-z0-9_$#]*$/.test(alias) ? alias : null;
}

/**
 * Predicado del WHERE tal cual lo escribió el usuario, sin la palabra WHERE.
 *
 * No se re-serializa el AST: node-sql-parser con dialecto PostgreSQL
 * entrecomilla el alias y las tablas, y en Oracle `"e"` es un identificador
 * en mayúsculas que no existe (ORA-00904). Con el texto original, el SELECT
 * espejo lleva el mismo predicado que la sentencia, subconsultas correlacionadas
 * incluidas.
 */
function originalWhere(sql: string): string | null {
  const upper = sql.toUpperCase();
  let depth = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      i = skipString(sql, i);
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const eol = sql.indexOf('\n', i);
      i = eol === -1 ? sql.length : eol;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const fin = sql.indexOf('*/', i + 2);
      i = fin === -1 ? sql.length : fin + 2;
      continue;
    }
    if (ch === '(') {
      depth++;
      i++;
      continue;
    }
    if (ch === ')') {
      depth--;
      i++;
      continue;
    }
    if (
      depth === 0 &&
      upper.startsWith('WHERE', i) &&
      !isWordChar(sql[i - 1]) &&
      !isWordChar(sql[i + 5])
    ) {
      // El `;` final se va: el driver de Oracle no lo acepta en un SELECT.
      return literalizeBinds(stripTrailingTerminator(sql.slice(i + 5).trim()));
    }
    i++;
  }
  return null;
}

/** Índice justo después del literal que empieza en `start`. */
function skipString(sql: string, start: number): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === "'") {
      if (sql[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return i;
}

/**
 * Los binds `:nombre` se cambian por el literal `'nombre'`, que es lo que
 * hacía la serialización del AST: el SELECT espejo no puede llevar binds.
 */
function literalizeBinds(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'") {
      const fin = skipString(text, i);
      out += text.slice(i, fin);
      i = fin;
      continue;
    }
    if (ch === ':') {
      const bind = /^:([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(i));
      if (bind) {
        out += `'${bind[1]}'`;
        i += bind[0].length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$#]/.test(ch);
}

