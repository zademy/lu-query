import { TIMEOUTS, type ResolvedConfig } from '../config.js';
import type { DataAccess, QueryOptions } from './data-access.js';
import {
  loadOracle,
  type OracleBind,
  type OracleConnection,
  type OraclePool,
} from './oracle-types.js';

/**
 * Proveedor perezoso de pool: no se conecta a Oracle hasta la primera query,
 * para que el arranque del server MCP no dependa de la base de datos.
 */
export interface PoolProvider {
  get(): Promise<OraclePool>;
  close(): Promise<void>;
}

export function createPoolProvider(config: ResolvedConfig): PoolProvider {
  let pending: Promise<OraclePool> | undefined;

  return {
    get() {
      pending ??= loadOracle().then((oracledb) => {
        oracledb.thin = true; // thin mode puro: no requiere Oracle Client
        return oracledb.createPool({
          user: config.user,
          password: config.password,
          connectString: config.connectString,
          poolMin: 0,
          poolMax: config.poolSize,
          poolIncrement: 1,
          connectTimeout: TIMEOUTS.socketSeconds,
        });
      });
      return pending;
    },
    async close() {
      const pool = await pending?.catch(() => undefined);
      pending = undefined;
      await pool?.close();
    },
  };
}

async function withConnection<T>(
  provider: PoolProvider,
  run: (connection: OracleConnection, outFormat: number) => Promise<T>,
): Promise<T> {
  const [oracledb, pool] = await Promise.all([loadOracle(), provider.get()]);
  const connection = await pool.getConnection();
  try {
    return await run(connection, oracledb.OUT_FORMAT_OBJECT);
  } finally {
    await connection.close();
  }
}

/** Implementación real sobre node-oracledb thin; #3 la endurece (test_connection). */
export function createOracleDataAccess(provider: PoolProvider): DataAccess {
  const execute = (sql: string, binds: OracleBind[] | undefined, options?: QueryOptions) =>
    withConnection(provider, (connection, outFormat) =>
      connection.execute(sql, binds, {
        outFormat,
        stmtTimeout: options?.timeoutMs ?? TIMEOUTS.statementMs,
        maxRows: options?.maxRows,
      }),
    );

  return {
    async queryForList(sql, binds, options) {
      return (await execute(sql, binds, options)).rows;
    },
    async queryForObject(sql, binds, options) {
      return (await execute(sql, binds, options)).rows[0] ?? null;
    },
    async execute(sql, binds, options) {
      return (await execute(sql, binds, options)).rowsAffected ?? 0;
    },
    async call(callString, binds) {
      return (await execute(`BEGIN ${callString}; END;`, binds)).rows;
    },
    close() {
      return provider.close();
    },
  };
}
