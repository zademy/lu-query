/**
 * Tipos del subset de node-oracledb que usa lu-query. El paquete oracledb@26
 * no publica tipos, así que se declara aquí la superficie mínima en vez de
 * dejar cualquier `any` en el chokepoint.
 */

export type OracleBind = string | number | boolean | Date | Uint8Array | null;

/** Fila como objeto (OUT_FORMAT_OBJECT), que es lo que exponen las tools. */
export type OracleRow = Record<string, unknown>;

export interface OracleResult<Row = OracleRow> {
  rows: Row[];
  rowsAffected?: number;
  outBinds?: OracleBind[];
}

export interface OracleConnection {
  /** Timeout de ida y vuelta en ms (capa de socket del Java: readTimeout). */
  callTimeout: number;
  execute<Row = OracleRow>(
    sql: string,
    binds?: OracleBind[],
    options?: Record<string, unknown>,
  ): Promise<OracleResult<Row>>;
  /** Cancela la sentencia en curso en el servidor (el ORA-01013 del Java). */
  breakExecution(): Promise<void>;
  close(): Promise<void>;
  /** Commit explícito: en thin `autoCommit` no persiste el DML. */
  commit(): Promise<void>;
}

export interface OraclePool {
  getConnection(): Promise<OracleConnection>;
  close(): Promise<void>;
}

/** Corre el init de sesión de una conexión recién creada (connection-init-sql del Java). */
export type OracleSessionCallback = (
  connection: OracleConnection,
  tag: string,
  done: (error?: unknown) => void,
) => void;

export interface OraclePoolAttributes {
  user?: string;
  password?: string;
  connectString?: string;
  poolMin: number;
  poolMax: number;
  poolIncrement: number;
  /** Segundos (verificado en thin: NJS-510 lo reporta en segundos). */
  connectTimeout: number;
  poolAlias: string;
  sessionCallback?: OracleSessionCallback;
  /**
   * Columnas que se traen como string en vez de Lob/Readable; sin esto el
   * thin corta los DDL de DBMS_METADATA a 4000 caracteres.
   */
  fetchAsString?: unknown[];
}

export interface OracleModule {
  CLOB: unknown;
  OUT_FORMAT_OBJECT: number;
  createPool(attributes: OraclePoolAttributes): Promise<OraclePool>;
}

let cached: Promise<OracleModule> | undefined;

/**
 * Carga perezosa de node-oracledb (thin, sin Oracle Client): solo se carga
 * cuando una query lo necesita, para que el arranque del server y los tests
 * unitarios no dependan del binario nativo.
 */
export function loadOracle(): Promise<OracleModule> {
  cached ??= import('oracledb').then((module) => {
    const esm = module as unknown as { default?: OracleModule };
    return esm.default ?? (module as unknown as OracleModule);
  });
  return cached;
}
