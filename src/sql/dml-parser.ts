import sqlParser from 'node-sql-parser';
import { stripSqlNoise } from './kind.js';

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
  /** Expresión WHERE sin la palabra `WHERE`; null si no filtra o no se pudo parsear. */
  where: string | null;
}

/** Parte del AST que nos interesa; el resto del árbol no se usa. */
interface DmlAst {
  type?: string;
  where?: unknown;
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
    return { kind: 'UNKNOWN', where: null };
  }

  const type = statement?.type?.toUpperCase();
  const kind: DmlKind =
    type === 'INSERT' || type === 'UPDATE' || type === 'DELETE' || type === 'MERGE'
      ? type
      : 'UNKNOWN';
  return { kind, where: whereToSql(statement?.where) };
}

/** Serializa la expresión WHERE; null si no hay WHERE o no se puede emitir. */
function whereToSql(where: unknown): string | null {
  if (where === undefined || where === null) return null;
  try {
    return parser.exprToSQL(where, PARSER_OPTIONS) ?? null;
  } catch {
    return null;
  }
}
