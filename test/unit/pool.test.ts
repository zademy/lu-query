import { describe, expect, it } from 'vite-plus/test';
import { loadConfig, MAX_ROWS } from '../../src/config.js';
import { DataAccessError } from '../../src/errors.js';
import {
  createOracleDataAccess,
  createPoolProvider,
  currentSchemaInitSql,
  POOL_ALIAS,
  type PoolProvider,
} from '../../src/db/pool.js';
import type {
  OracleBind,
  OracleConnection,
  OraclePool,
  OracleResult,
  OracleRow,
} from '../../src/db/oracle-types.js';

interface Executed {
  sql: string;
  binds: OracleBind[] | undefined;
  options: Record<string, unknown> | undefined;
}

/**
 * Pool fake: el chokepoint se prueba contra un contrato de una conexión, sin
 * Oracle. `reply` devuelve el resultado de execute, o undefined para colgar la
 * sentencia (así se dispara el timeout de 120s de la capa 1).
 */
function fakeBackend(reply: (executed: Executed) => OracleResult<OracleRow> | undefined) {
  const executed: Executed[] = [];
  const state = { breaks: 0, closed: false, callTimeout: 0, outcomes: [] as string[] };

  const connection: OracleConnection = {
    commit() {
      state.outcomes.push('commit');
      return Promise.resolve();
    },
    rollback() {
      state.outcomes.push('rollback');
      return Promise.resolve();
    },
    async execute<Row = OracleRow>(
      sql: string,
      binds?: OracleBind[],
      options?: Record<string, unknown>,
    ): Promise<OracleResult<Row>> {
      const call = { sql, binds, options };
      executed.push(call);
      const result = reply(call);
      if (!result) return new Promise<never>(() => undefined);
      return result as OracleResult<Row>;
    },
    breakExecution() {
      state.breaks += 1;
      return Promise.resolve();
    },
    set callTimeout(ms: number) {
      state.callTimeout = ms;
    },
    get callTimeout() {
      return state.callTimeout;
    },
    close() {
      state.closed = true;
      return Promise.resolve();
    },
  };

  const pool: OraclePool = {
    getConnection() {
      return Promise.resolve(connection);
    },
    close() {
      state.closed = true;
      return Promise.resolve();
    },
  };
  const provider: PoolProvider = {
    get: () => Promise.resolve(pool),
    close: () => Promise.resolve(),
  };

  return { provider, executed, state };
}

describe('currentSchemaInitSql', () => {
  it('prepara el ALTER SESSION de connection-init para un identificador válido', () => {
    expect(currentSchemaInitSql('APP_USER')).toBe('ALTER SESSION SET CURRENT_SCHEMA = "APP_USER"');
  });

  it('no hace init si no hay schema configurado', () => {
    expect(currentSchemaInitSql(undefined)).toBeUndefined();
    expect(currentSchemaInitSql('')).toBeUndefined();
  });

  it('ignora con warning un schema que no pasa la allow-list, sin romper el arranque', () => {
    const warnings: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      expect(currentSchemaInitSql('evil"; DROP TABLE t; --')).toBeUndefined();
      expect(currentSchemaInitSql('1INVALID')).toBeUndefined();
    } finally {
      console.warn = warn;
    }

    expect(warnings).toHaveLength(2);
    expect(String(warnings[0]?.[0])).toMatch(/ORACLE_DB_SCHEMA/);
  });
});

describe('createOracleDataAccess sobre el pool', () => {
  it('mapea filas y columnas a objetos y cierra la conexión', async () => {
    const { provider, executed, state } = fakeBackend(() => ({
      rows: [{ ID: 7, FULL_NAME: 'Ada' }],
      rowsAffected: 1,
    }));
    const db = createOracleDataAccess(provider);

    await expect(db.queryForList('SELECT id, full_name FROM employees')).resolves.toEqual([
      { ID: 7, FULL_NAME: 'Ada' },
    ]);

    expect(executed[0]?.sql).toBe('SELECT id, full_name FROM employees');
    expect(state.closed).toBe(true);
  });

  it('aplica el clamp de filas y el timeout que le pasa la tool', async () => {
    const { provider, executed } = fakeBackend(() => ({ rows: [] }));
    const db = createOracleDataAccess(provider);

    await db.queryForList('SELECT * FROM employees', [], { maxRows: 10, timeoutMs: 5_000 });

    expect(executed[0]?.options).toMatchObject({ maxRows: 10 });
  });

  it('sin tope explicito manda MAX_ROWS, no el default de 100 filas del driver', async () => {
    const { provider, executed } = fakeBackend(() => ({ rows: [] }));
    const db = createOracleDataAccess(provider);

    await db.queryForList('SELECT * FROM employees', []);

    expect(executed[0]?.options).toMatchObject({ maxRows: MAX_ROWS });
  });

  it('executeInTransaction confirma o revierte segun el desenlace', async () => {
    const { provider, state } = fakeBackend(() => ({ rows: [], rowsAffected: 4 }));
    const db = createOracleDataAccess(provider);

    await expect(db.executeInTransaction('UPDATE t SET a = 1', 'commit')).resolves.toBe(4);
    await expect(db.executeInTransaction('UPDATE t SET a = 1', 'rollback')).resolves.toBe(4);

    expect(state.outcomes).toEqual(['commit', 'rollback']);
  });

  it('queryForObject devuelve la primera fila o null', async () => {
    const withRow = createOracleDataAccess(
      fakeBackend(() => ({ rows: [{ A: 1 }, { A: 2 }] })).provider,
    );
    const empty = createOracleDataAccess(fakeBackend(() => ({ rows: [] })).provider);

    await expect(withRow.queryForObject('SELECT 1 FROM dual')).resolves.toEqual({ A: 1 });
    await expect(empty.queryForObject('SELECT 1 FROM dual')).resolves.toBeNull();
  });

  it('execute devuelve las filas afectadas', async () => {
    const { provider } = fakeBackend(() => ({ rows: [], rowsAffected: 3 }));
    const db = createOracleDataAccess(provider);

    await expect(db.execute('DELETE FROM employees WHERE id = :id', [42])).resolves.toBe(3);
  });

  it('call devuelve los OUT binds serializados y envuelve en BEGIN', async () => {
    const { provider, executed } = fakeBackend(() => ({ rows: [], outBinds: { '1': 5 } }));
    const db = createOracleDataAccess(provider);

    await expect(db.call('get_employee_count(:id)', [{ dir: 'OUT' }])).resolves.toEqual({ '1': 5 });
    expect(executed[0]?.sql).toBe('BEGIN get_employee_count(:id); END;');
  });

  it('call fetchea los REF CURSOR a filas antes de cerrarlos', async () => {
    let closed = false;
    const cursor = {
      getRows: () => Promise.resolve([{ A: 1 }, { A: 2 }]),
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    };
    const { provider } = fakeBackend(() => ({ rows: [], outBinds: { '1': cursor, '2': 42 } }));
    const db = createOracleDataAccess(provider);

    await expect(
      db.call('open_cursor', [{ dir: 'OUT', type: 'CURSOR' }, { dir: 'OUT' }]),
    ).resolves.toEqual({ '1': [{ A: 1 }, { A: 2 }], '2': 42 });
    expect(closed).toBe(true);
  });

  it('envuelve un ORA del driver en DataAccessError con su código', async () => {
    const ora = Object.assign(new Error('ORA-00942: table or view does not exist'), {
      code: 'ORA-00942',
    });
    const db = createOracleDataAccess(
      fakeBackend(() => {
        throw ora;
      }).provider,
    );

    const error = await db.queryForList('SELECT * FROM nope').catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(DataAccessError);
    expect((error as DataAccessError).code).toBe('ORA-00942');
    expect((error as DataAccessError).message).toContain('ORA-00942');
  });

  it('cancela la sentencia y reporta ORA-01013 cuando supera el timeout', async () => {
    const { provider, state } = fakeBackend(() => undefined);
    const db = createOracleDataAccess(provider);

    const error = await db
      .queryForList('SELECT * FROM slow', [], { timeoutMs: 20 })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(DataAccessError);
    expect((error as Error).message).toContain('ORA-01013');
    expect(state.breaks).toBe(1);
    expect(state.closed).toBe(true);
  });

  it('el pool real es lazy y usa el alias del Java', async () => {
    const config = loadConfig({
      ORACLE_DB_URL: 'jdbc:oracle:thin:@//localhost:1521/FREEPDB1',
      ORACLE_DB_USERNAME: 'DEVUSER',
      ORACLE_DB_PASSWORD: 'DevPassword123',
    });
    const provider = createPoolProvider(config);

    // Nada de conexiones hasta la primera query: crear el provider no toca Oracle.
    expect(POOL_ALIAS).toBe('mcp-oracle-pool');
    expect(config.poolSize).toBe(4);
    await expect(provider.close()).resolves.toBeUndefined();
  });
});
