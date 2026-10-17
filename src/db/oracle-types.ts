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
  execute<Row = OracleRow>(
    sql: string,
    binds?: OracleBind[],
    options?: Record<string, unknown>,
  ): Promise<OracleResult<Row>>;
  close(): Promise<void>;
}

export interface OraclePool {
  getConnection(): Promise<OracleConnection>;
  close(): Promise<void>;
}

export interface OraclePoolAttributes {
  user?: string;
  password?: string;
  connectString?: string;
  poolMin: number;
  poolMax: number;
  poolIncrement: number;
  connectTimeout: number;
}

export interface OracleModule {
  thin: boolean;
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
