import { auditStatement, type AuditWriter } from '../audit/audit-writer.js';
import type { OracleBind, OracleCallBind, OracleRow } from './oracle-types.js';

/** Opciones comunes de una sentencia. */
export interface QueryOptions {
  /** Filas máximas a traer; las tools usan el clamp de sql/capped-select. */
  maxRows?: number;
  /** Override del timeout de sentencia (default: TIMEOUTS.statementMs). */
  timeoutMs?: number;
}

/** Llamada registrada por el backend fake, útil para afirmar en tests. */
export interface DataAccessCall {
  method: 'queryForList' | 'queryForObject' | 'execute' | 'executeInTransaction' | 'call';
  sql: string;
  binds?: OracleBind[] | OracleCallBind[];
  options?: QueryOptions;
  outcome?: 'commit' | 'rollback';
}

/**
 * Chokepoint de acceso a datos: ninguna tool habla con node-oracledb, todas
 * pasan por esta interfaz. Así el server se puede probar con el fake.
 */
export interface DataAccess {
  /** Todas las filas de la query; lista vacía si no hay ninguna. */
  queryForList(sql: string, binds?: OracleBind[], options?: QueryOptions): Promise<OracleRow[]>;
  /** La primera fila, o null si la query no devolvió nada. */
  queryForObject(
    sql: string,
    binds?: OracleBind[],
    options?: QueryOptions,
  ): Promise<OracleRow | null>;
  /** DML/DDL: devuelve las filas afectadas. */
  execute(sql: string, binds?: OracleBind[], options?: QueryOptions): Promise<number>;
  /** DML en transacción propia: ejecuta y cierra con commit o rollback explícito. */
  executeInTransaction(sql: string, outcome: 'commit' | 'rollback'): Promise<number>;
  /** Llamada PL/SQL: devuelve los OUT binds serializados como una fila (cursores → filas). */
  call(callString: string, binds?: OracleCallBind[]): Promise<OracleRow>;
  /** Libera el pool. Idempotente. */
  close(): Promise<void>;
}

/**
 * Envuelve el chokepoint para que cada sentencia SQL deje su entrada en el log
 * Markdown de la sesión, escrita post-ejecución (éxito o error). Es el
 * equivalente del `SqlAuditAspect` del Java; el tool en curso llega por
 * AsyncLocalStorage, no por parámetro.
 */
export function withAudit(inner: DataAccess, audit: AuditWriter): DataAccess {
  return {
    queryForList(sql, binds, options) {
      return auditStatement(
        audit,
        sql,
        () => inner.queryForList(sql, binds, options),
        (rows) => rows.length,
      );
    },
    queryForObject(sql, binds, options) {
      return auditStatement(
        audit,
        sql,
        () => inner.queryForObject(sql, binds, options),
        (row) => (row === null ? 0 : 1),
      );
    },
    execute(sql, binds, options) {
      return auditStatement(
        audit,
        sql,
        () => inner.execute(sql, binds, options),
        (rowsAffected) => rowsAffected,
      );
    },
    executeInTransaction(sql, outcome) {
      return auditStatement(
        audit,
        sql,
        () => inner.executeInTransaction(sql, outcome),
        (rowsAffected) => rowsAffected,
      );
    },
    call(callString, binds) {
      return auditStatement(
        audit,
        `BEGIN ${callString}; END;`,
        () => inner.call(callString, binds),
        (row) => Object.keys(row).length,
      );
    },
    async close() {
      await audit.drain(); // flush de las entradas pendientes antes de soltar el pool
      await inner.close();
    },
  };
}
