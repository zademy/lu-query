/** Tipo de sentencia que decide el camino de validación de una tool. */
export type StatementKind =
  'select' | 'insert' | 'update' | 'delete' | 'merge' | 'ddl' | 'plsql' | 'explain' | 'unknown';

/** Quita comentarios y punto y coma inicial/final para poder leer el verbo. */
export function stripSqlNoise(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/;\s*$/, '')
    .trim();
}

const KIND_BY_KEYWORD: Record<string, StatementKind> = {
  SELECT: 'select',
  INSERT: 'insert',
  UPDATE: 'update',
  DELETE: 'delete',
  MERGE: 'merge',
  CREATE: 'ddl',
  ALTER: 'ddl',
  DROP: 'ddl',
  TRUNCATE: 'ddl',
  RENAME: 'ddl',
  COMMENT: 'ddl',
  GRANT: 'ddl',
  REVOKE: 'ddl',
  BEGIN: 'plsql',
  DECLARE: 'plsql',
  EXPLAIN: 'explain',
};

/** Kind de la sentencia a partir de su primera palabra clave. */
export function detectStatementKind(sql: string): StatementKind {
  const cleaned = stripSqlNoise(sql);
  if (!cleaned) return 'unknown';

  const keyword = /^[A-Za-z]+/.exec(cleaned)?.[0].toUpperCase();
  if (!keyword) return 'unknown';
  if (keyword === 'WITH') return 'select'; // CTE: el kind es el de la sentencia principal
  return KIND_BY_KEYWORD[keyword] ?? 'unknown';
}
