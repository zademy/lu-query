import { TIMEOUTS, type ResolvedConfig } from '../config.js';
import { DataAccessError } from '../errors.js';
import { isValidIdentifier } from '../security/identifiers.js';
import type { DataAccess, QueryOptions } from './data-access.js';
import {
  loadOracle,
  type OracleBind,
  type OracleConnection,
  type OraclePool,
  type OracleResult,
  type OracleSessionCallback,
} from './oracle-types.js';

/** pool-name del Java (`spring.datasource.hikari.pool-name: mcp-oracle-pool`). */
export const POOL_ALIAS = 'mcp-oracle-pool';

/**
 * Proveedor perezoso de pool: no se conecta a Oracle hasta la primera query,
 * para que el arranque del server MCP no dependa de la base de datos.
 */
export interface PoolProvider {
  get(): Promise<OraclePool>;
  close(): Promise<void>;
}

/**
 * `ALTER SESSION` de inicialización de conexión para ORACLE_DB_SCHEMA, paridad
 * con el `connection-init-sql` de Hikari. Sin schema no hay init; uno que no
 * pasa la allow-list se ignora con warning en vez de romper el arranque (igual
 * que DefaultSchemaEnvPostProcessor).
 */
export function currentSchemaInitSql(schema: string | undefined): string | undefined {
  if (!schema) return undefined;
  if (!isValidIdentifier(schema)) {
    console.warn(
      `ORACLE_DB_SCHEMA inválido: ${JSON.stringify(schema)}; se ignora y las tools usan el schema del usuario de conexión`,
    );
    return undefined;
  }
  return `ALTER SESSION SET CURRENT_SCHEMA = "${schema}"`;
}

function sessionCallback(initSql: string | undefined): OracleSessionCallback | undefined {
  if (!initSql) return undefined;
  return (connection, _tag, done) => {
    connection.execute(initSql).then(() => done(), done);
  };
}

export function createPoolProvider(config: ResolvedConfig): PoolProvider {
  let pending: Promise<OraclePool> | undefined;
  const initSql = currentSchemaInitSql(config.schema);

  return {
    get() {
      pending ??= loadOracle()
        .then((oracledb) =>
          oracledb.createPool({
            user: config.user,
            password: config.password,
            connectString: config.connectString,
            poolMin: 0, // lazy: el server abre sesiones solo cuando hacen falta
            poolMax: config.poolSize,
            poolIncrement: 1,
            connectTimeout: TIMEOUTS.socketSeconds,
            poolAlias: POOL_ALIAS,
            sessionCallback: sessionCallback(initSql),
          }),
        )
        .catch((error: unknown) => {
          pending = undefined; // un pool que no se pudo crear no se cachea: la siguiente query reintenta
          throw asDataAccessError(error, 'No se pudo crear el pool de Oracle');
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

/** Traduce el error del driver (ORA-xxxxx / NJS-xxx) a DataAccessError con su código. */
function asDataAccessError(error: unknown, action: string): DataAccessError {
  if (error instanceof DataAccessError) return error;
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
  const detail = error instanceof Error ? error.message : String(error);
  return new DataAccessError(`${action}: ${code ? `${code} ` : ''}${detail}`, code, {
    cause: error,
  });
}

/**
 * Capa 1 de timeouts (query 120s): node-oracledb@26 ya no trae `stmtTimeout`,
 * así que la sentencia se corta con `breakExecution`, que es la señal de
 * cancelación que Oracle responde como ORA-01013 (el ORA-00913 del Java).
 */
async function withStatementTimeout<T>(
  connection: OracleConnection,
  timeoutMs: number,
  run: () => Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void connection.breakExecution().catch(() => undefined);
      reject(
        new DataAccessError(
          `La consulta superó el timeout de ${timeoutMs} ms y fue cancelada (ORA-01013)`,
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([run(), expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function withConnection<T>(
  provider: PoolProvider,
  run: (connection: OracleConnection, outFormat: number) => Promise<T>,
): Promise<T> {
  const [oracledb, pool] = await Promise.all([loadOracle(), provider.get()]);

  let connection: OracleConnection;
  try {
    connection = await pool.getConnection();
  } catch (error) {
    throw asDataAccessError(error, 'No se pudo obtener una conexión de Oracle');
  }

  try {
    // Capa 2 (socket): readTimeout 30s del Java, que en thin es el timeout de
    // ida y vuelta de la conexión.
    connection.callTimeout = TIMEOUTS.socketSeconds * 1000;
    return await run(connection, oracledb.OUT_FORMAT_OBJECT);
  } finally {
    await connection.close().catch(() => undefined);
  }
}

/** Implementación real sobre node-oracledb thin. Único camino de todo el SQL. */
export function createOracleDataAccess(provider: PoolProvider): DataAccess {
  const execute = (
    sql: string,
    binds: OracleBind[] | undefined,
    options: QueryOptions | undefined,
  ): Promise<OracleResult> =>
    withConnection(provider, (connection, outFormat) =>
      withStatementTimeout(connection, options?.timeoutMs ?? TIMEOUTS.statementMs, () =>
        connection
          // node-oracledb rechaza `binds` undefined cuando se pasan 3 argumentos.
          .execute(sql, binds ?? [], { outFormat, maxRows: options?.maxRows })
          .catch((error: unknown) => {
            throw asDataAccessError(error, 'Oracle rechazó la sentencia');
          }),
      ),
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
      return (await execute(`BEGIN ${callString}; END;`, binds, undefined)).rows;
    },
    close() {
      return provider.close();
    },
  };
}
