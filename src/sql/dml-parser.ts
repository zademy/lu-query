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
