import type { OracleBind, OracleRow } from './oracle-types.js';

/** Opciones comunes de una sentencia. */
export interface QueryOptions {
  /** Filas máximas a traer; las tools usan el clamp de sql/capped-select. */
  maxRows?: number;
  /** Override del timeout de sentencia (default: TIMEOUTS.statementMs). */
  timeoutMs?: number;
}

/** Llamada registrada por el backend fake, útil para afirmar en tests. */
export interface DataAccessCall {
  method: 'queryForList' | 'queryForObject' | 'execute' | 'call';
  sql: string;
  binds?: OracleBind[];
  options?: QueryOptions;
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
  /** Llamada a procedimiento/función PL/SQL: devuelve las filas de salida. */
  call(callString: string, binds?: OracleBind[]): Promise<OracleRow[]>;
  /** Libera el pool. Idempotente. */
  close(): Promise<void>;
}
