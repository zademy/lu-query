import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import {
  loadOracle,
  type OracleConnection,
  type OraclePool,
  type OracleRow,
} from '../../src/db/oracle-types.js';
import { createServer, type ServerHandle } from '../../src/server.js';

/**
 * Integration de las tools de performance (V$) contra el contenedor Oracle real.
 * Requiere el privilegio de catálogo; se aplica con
 * `scripts/test-grants-performance.sql`:
 *   docker exec -i oracle-26ai-free \
 *     bash -c "sqlplus -s system/OraclePassword123@FREEPDB1" < scripts/test-grants-performance.sql
 *
 *   LU_TEST_INTEGRATION=1 ORACLE_DB_URL='jdbc:oracle:thin:@//localhost:1521/FREEPDB1' \
 *   ORACLE_DB_USERNAME=DEVUSER ORACLE_DB_PASSWORD=DevPassword123 npm run test:integration
 */
const optIn = process.env.LU_TEST_INTEGRATION === '1';

const GOOD_ENV: NodeJS.ProcessEnv = {
  ORACLE_DB_URL: process.env.ORACLE_DB_URL ?? 'jdbc:oracle:thin:@//localhost:1521/FREEPDB1',
  ORACLE_DB_USERNAME: process.env.ORACLE_DB_USERNAME ?? 'DEVUSER',
  ORACLE_DB_PASSWORD: process.env.ORACLE_DB_PASSWORD ?? 'DevPassword123',
};

/** SYSTEM del contenedor de pruebas: solo para crear el usuario sin privilegios. */
const SYSTEM_ENV: NodeJS.ProcessEnv = {
  ORACLE_DB_URL: 'jdbc:oracle:thin:@//localhost:1521/FREEPDB1',
  ORACLE_DB_USERNAME: 'system',
  ORACLE_DB_PASSWORD: 'OraclePassword123',
};

/** Tabla de bloqueo para el escenario de sesión bloqueada; se borra al terminar. */
const TABLE = 'T14_PERF_LOCK';
const NOPRIV_USER = 'LU14_NOPRIV';
const NOPRIV_PASSWORD = 'Lu14NoPriv123';

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

interface Session {
  client: Client;
  call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
  close: () => Promise<void>;
}

/** Server MCP con el pool real, como en producción (createServer sin dataAccess). */
async function connect(env: NodeJS.ProcessEnv): Promise<Session> {
  const handle: ServerHandle = createServer({
    config: loadConfig({ ...env, MCP_AUDIT_ENABLED: 'false' }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'lu-query-performance-integration', version: '0.0.0' });
  await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    call: (name, args = {}) => client.callTool({ name, arguments: args }) as Promise<ToolResult>,
    close: async () => {
      await client.close();
      await handle.close();
    },
  };
}

/** Conexión suelta de node-oracledb (para simular las otras sesiones de la BD). */
const pools: OraclePool[] = [];

async function rawConnection(env: NodeJS.ProcessEnv): Promise<OracleConnection> {
  const config = loadConfig(env);
  const pool = await (
    await loadOracle()
  ).createPool({
    user: config.user,
    password: config.password,
    connectString: config.connectString,
    poolMin: 0,
    poolMax: 1,
    poolIncrement: 1,
    connectTimeout: 15,
    // Nombre único por pool: node-oracledb reutiliza el pool si el alias existe.
    poolAlias: `lu-query-it-${pools.length}`,
  });
  pools.push(pool);
  const connection = await pool.getConnection();
  connection.callTimeout = 60_000;
  return connection;
}

/** Cierra los pools de las conexiones sueltas, ya sin conexiones prestadas. */
async function closePools(): Promise<void> {
  await Promise.all(pools.splice(0).map((pool) => pool.close().catch(() => undefined)));
}

describe.skipIf(!optIn)('performance — vistas V$ contra Oracle real', () => {
  let oracle: Session;

  beforeAll(async () => {
    oracle = await connect(GOOD_ENV);
  });

  afterAll(async () => {
    await oracle.close();
  });

  /** Tool que debe responder bien: devuelve el JSON ya parseado. */
  async function read(name: string, args: Record<string, unknown> = {}): Promise<OracleRow[]> {
    return JSON.parse(await readText(name, args)) as OracleRow[];
  }

  async function readText(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await oracle.call(name, args);
    expect(result.isError, `${name}: ${result.content[0]?.text}`).toBeFalsy();
    return result.content[0]?.text ?? '';
  }

  it('lista al menos la sesión propia entre las activas', async () => {
    const sessions = await read('list_active_sessions', { username: 'DEVUSER' });

    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions.every((row) => row.STATUS === 'ACTIVE')).toBe(true);
    expect(sessions.every((row) => row.USERNAME === 'DEVUSER')).toBe(true);
    expect(sessions[0]).toHaveProperty('SECONDS_SINCE_LAST_CALL');
  }, 60_000);

  it('el filtro por sid recorta el resultado', async () => {
    const [session] = await read('list_active_sessions', { username: 'DEVUSER' });
    const ownSid = session?.SID as number;

    expect(await read('list_active_sessions', { sid: ownSid })).toHaveLength(1);
    expect(await read('list_active_sessions', { sid: 999_999 })).toHaveLength(0);
  }, 60_000);

  it('get_instance_info y get_database_info devuelven datos de la instancia', async () => {
    const instance = JSON.parse(await readText('get_instance_info')) as OracleRow;
    const database = JSON.parse(await readText('get_database_info')) as OracleRow;

    expect(instance).toMatchObject({ STATUS: expect.stringMatching(/^(OPEN|STARTED)$/) });
    expect(instance.HOST_NAME).toBeTruthy();
    expect(database).toMatchObject({ NAME: expect.any(String), LOG_MODE: expect.any(String) });
  }, 60_000);

  it('list_locks responde con los locks vivos de la instancia', async () => {
    const locks = await read('list_locks');

    expect(locks.length).toBeGreaterThan(0);
    expect(locks[0]).toHaveProperty('LOCK_TYPE');
    expect(locks[0]).toHaveProperty('SID');
  }, 60_000);

  it('list_top_sql trae diez sentencias por defecto y respeta orderBy/limit', async () => {
    const top = await read('list_top_sql');

    expect(top.length).toBeGreaterThan(0);
    expect(top.length).toBeLessThanOrEqual(10);
    expect(top[0]).toHaveProperty('SQL_ID');

    const byGets = await read('list_top_sql', { orderBy: 'buffer_gets', limit: 3 });
    expect(byGets).toHaveLength(3);
  }, 60_000);

  it('get_parameter filtra por patrón LIKE sin distinguir mayúsculas', async () => {
    const all = await read('get_parameter', { name: 'sga_target' });

    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ NAME: 'sga_target' });
  }, 60_000);

  it('get_system_stats, get_db_time_model, get_session_longops y list_datafile_io responden', async () => {
    expect((await read('get_system_stats')).length).toBeGreaterThan(0);
    expect((await read('get_db_time_model')).length).toBeGreaterThan(0);
    expect(await read('get_session_longops')).toBeInstanceOf(Array);
    expect((await read('list_datafile_io')).length).toBeGreaterThan(0);
  }, 60_000);
});

describe.skipIf(!optIn)('performance — sesión bloqueada', () => {
  let oracle: Session;
  let blocker: OracleConnection;
  let waiter: OracleConnection;

  beforeAll(async () => {
    oracle = await connect(GOOD_ENV);
    blocker = await rawConnection(GOOD_ENV);
    waiter = await rawConnection(GOOD_ENV);

    await blocker.execute(`DROP TABLE ${TABLE} PURGE`).catch(() => undefined);
    await blocker.execute(`CREATE TABLE ${TABLE} (id NUMBER PRIMARY KEY, v NUMBER)`);
    await blocker.execute(`INSERT INTO ${TABLE} VALUES (1, 0)`);
    await blocker.execute('COMMIT');
    // Lock de fila sin commit: el waiter se queda esperando en la cola TX.
    await blocker.execute(`UPDATE ${TABLE} SET v = 1 WHERE id = 1`);
  }, 60_000);

  afterAll(async () => {
    await blocker?.execute(`DROP TABLE ${TABLE} PURGE`).catch(() => undefined);
    await waiter?.close().catch(() => undefined);
    await blocker?.close().catch(() => undefined);
    await closePools();
    await oracle?.close();
  }, 60_000);

  it('ve la sesión bloqueada, su SQL en curso y su wait event', async () => {
    const pending = waiter
      .execute(`SELECT /* lu-query-t14 */ v FROM ${TABLE} WHERE id = 1 FOR UPDATE`)
      .catch(() => undefined); // se resuelve al hacer COMMIT en el test

    const blocked = await waitFor(async () => {
      const result = await oracle.call('list_blocked_sessions');
      const rows = JSON.parse(result.content[0]?.text ?? '[]') as OracleRow[];
      return rows.filter((row) => row.WAITING_USER === GOOD_ENV.ORACLE_DB_USERNAME);
    });
    const waiting = blocked[0];

    expect(waiting).toBeDefined();
    expect(waiting?.BLOCKING_SID).toBeGreaterThan(0);

    const sqlText = await oracle.call('get_session_sql_text', {
      sid: waiting?.WAITING_SID,
      serialNum: waiting?.WAITING_SERIAL,
    });
    expect(sqlText.isError).toBeFalsy();
    expect(JSON.parse(sqlText.content[0]?.text ?? '')).toContain('lu-query-t14');

    const waits = JSON.parse(
      (await oracle.call('get_wait_events', { sid: waiting?.WAITING_SID })).content[0]?.text ??
        '[]',
    ) as OracleRow[];
    expect(waits[0]?.EVENT).toMatch(/^enq: TX/);

    await blocker.execute('COMMIT');
    await pending;
  }, 120_000);
});

describe.skipIf(!optIn)('performance — sin privilegio de catálogo', () => {
  let nopriv: Session | undefined;

  beforeAll(async () => {
    const config = loadConfig(SYSTEM_ENV);
    let system: OracleConnection;
    try {
      system = await rawConnection(SYSTEM_ENV);
    } catch {
      return; // sin SYSTEM no se puede crear el usuario de prueba: el test se salta
    }

    await system.execute(`DROP USER ${NOPRIV_USER} CASCADE`).catch(() => undefined);
    await system.execute(`CREATE USER ${NOPRIV_USER} IDENTIFIED BY ${NOPRIV_PASSWORD}`);
    await system.execute(`GRANT CREATE SESSION TO ${NOPRIV_USER}`);
    await system.close();
    nopriv = await connect({
      ORACLE_DB_URL: config.connectString,
      ORACLE_DB_USERNAME: NOPRIV_USER,
      ORACLE_DB_PASSWORD: NOPRIV_PASSWORD,
    });
  }, 60_000);

  afterAll(async () => {
    await nopriv?.close();

    let system: OracleConnection;
    try {
      system = await rawConnection(SYSTEM_ENV);
      await system.execute(`DROP USER ${NOPRIV_USER} CASCADE`);
      await system.close();
    } catch {
      // Sin SYSTEM el usuario queda; se limpia a mano en el contenedor.
    }
    await closePools();
  }, 60_000);

  it('devuelve isError con el hint del grant faltante', async (ctx) => {
    if (!nopriv) ctx.skip();
    const result = await nopriv!.call('list_locks');

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/ORA-00942|ORA-01031/);
    expect(result.content[0]?.text).toContain('SELECT ANY DICTIONARY');
    expect(result.content[0]?.text).toContain('scripts/test-grants-performance.sql');
  }, 60_000);
});

/** Espera a que `probe` devuelva algo truthy (la sesión tarda en quedar bloqueada). */
async function waitFor<T>(probe: () => Promise<T[]>): Promise<T[]> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const rows = await probe();
    if (rows.length > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return [];
}
