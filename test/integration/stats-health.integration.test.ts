import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { loadConfig } from '../../src/config.js';
import { createServer, type ServerHandle } from '../../src/server.js';

/**
 * Integration de stats/sesión/health (#10) contra el contenedor Oracle real,
 * como DEVUSER. Objetos propios con prefijo T10_IT_; nunca se tocan las tablas
 * de ejemplo del esquema.
 *   LU_TEST_INTEGRATION=1 ORACLE_DB_URL='jdbc:oracle:thin:@//localhost:1521/FREEPDB1' \
 *   ORACLE_DB_USERNAME=DEVUSER ORACLE_DB_PASSWORD=DevPassword123 npm run test:integration
 */
const optIn = process.env.LU_TEST_INTEGRATION === '1';

const GOOD_ENV: NodeJS.ProcessEnv = {
  ORACLE_DB_URL: process.env.ORACLE_DB_URL ?? 'jdbc:oracle:thin:@//localhost:1521/FREEPDB1',
  ORACLE_DB_USERNAME: process.env.ORACLE_DB_USERNAME ?? 'DEVUSER',
  ORACLE_DB_PASSWORD: process.env.ORACLE_DB_PASSWORD ?? 'DevPassword123',
};
const OWNER = GOOD_ENV.ORACLE_DB_USERNAME as string;

const STATS_TABLE = 'T10_IT_STATS';
const BROKEN_PROC = 'T10_IT_BROKEN';

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

interface HealthReport {
  overallStatus: string;
  databaseName: string | null;
  checks: { name: string; status: string; detail: string }[];
}

type Row = Record<string, unknown>;

describe.skipIf(!optIn)('stats, sesión y health contra Oracle real', () => {
  let handle: ServerHandle;
  let client: Client;

  /** Llama una tool MCP (el seam público) y parsea las filas JSON. */
  async function rows(name: string, args: Record<string, unknown> = {}): Promise<Row[]> {
    const result = (await client.callTool({ name, arguments: args })) as ToolResult;
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content[0]?.text ?? '') as Row[];
  }

  beforeAll(async () => {
    handle = createServer({ config: loadConfig({ ...GOOD_ENV, MCP_AUDIT_ENABLED: 'false' }) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'lu-query-stats-health-integration', version: '0.0.0' });
    await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);

    const db = handle.context.dataAccess;
    await db.execute(`CREATE TABLE ${STATS_TABLE} (id NUMBER PRIMARY KEY, tag VARCHAR2(20))`);
    await db.execute(
      `INSERT INTO ${STATS_TABLE} SELECT 1, 'a' FROM dual UNION ALL SELECT 2, 'b' FROM dual UNION ALL SELECT 3, 'a' FROM dual`,
    );
    await db.execute(`BEGIN DBMS_STATS.GATHER_TABLE_STATS(USER, '${STATS_TABLE}'); END;`);
    // Procedimiento con error de compilación: queda INVALID con filas en ALL_ERRORS.
    await db.execute(
      `CREATE OR REPLACE PROCEDURE ${BROKEN_PROC} AS BEGIN t10_it_undefined := 1; END;`,
    );
  });

  /** Borra los objetos propios del test (idempotente). */
  async function dropObjects(): Promise<void> {
    const db = handle.context.dataAccess;
    await db
      .execute(
        `BEGIN EXECUTE IMMEDIATE 'DROP TABLE ${STATS_TABLE} PURGE'; EXCEPTION WHEN OTHERS THEN NULL; END;`,
      )
      .catch(() => undefined);
    await db
      .execute(
        `BEGIN EXECUTE IMMEDIATE 'DROP PROCEDURE ${BROKEN_PROC}'; EXCEPTION WHEN OTHERS THEN NULL; END;`,
      )
      .catch(() => undefined);
  }

  afterAll(async () => {
    if (handle === undefined) return;
    await dropObjects().catch(() => undefined);
    await handle.close();
  });

  it('get_table_stats devuelve las estadísticas del optimizador', async () => {
    const stats = await rows('get_table_stats', { schema: OWNER, table: STATS_TABLE });

    expect(stats).toHaveLength(1);
    expect(stats[0]?.SCHEMA_NAME).toBe(OWNER);
    expect(stats[0]?.NAME).toBe(STATS_TABLE);
    expect(Number(stats[0]?.NUM_ROWS)).toBe(3);
    expect(stats[0]?.LAST_ANALYZED).not.toBeNull();
  });

  it('get_column_stats filtra por columna y expone NDV', async () => {
    const all = await rows('get_column_stats', { schema: OWNER, table: STATS_TABLE });
    expect(all.map((row) => row.COLUMN_NAME)).toEqual(['ID', 'TAG']);

    const tag = await rows('get_column_stats', {
      schema: OWNER,
      table: STATS_TABLE,
      column: 'TAG',
    });
    expect(tag).toHaveLength(1);
    expect(Number(tag[0]?.NDV)).toBe(2);
  });

  it('get_histogram devuelve los endpoints de la columna', async () => {
    const buckets = await rows('get_histogram', {
      schema: OWNER,
      table: STATS_TABLE,
      column: 'TAG',
    });

    expect(Array.isArray(buckets)).toBe(true);
    for (const bucket of buckets) {
      expect(bucket).toHaveProperty('ENDPOINT_NUMBER');
      expect(bucket).toHaveProperty('ENDPOINT_VALUE');
    }
  });

  it('get_session_privs refleja los privilegios de la sesión real', async () => {
    const privs = await rows('get_session_privs');

    expect(privs.length).toBeGreaterThan(0);
    expect(privs.some((row) => row.PRIVILEGE === 'CREATE SESSION')).toBe(true);
  });

  it('get_session_roles devuelve rol/admin/default de la sesión', async () => {
    const roles = await rows('get_session_roles');

    expect(Array.isArray(roles)).toBe(true);
    for (const role of roles) {
      expect(role).toHaveProperty('ROLE');
    }
  });

  it('get_plsql_errors filtra por name y type (PACKAGE BODY, TRIGGER, ...)', async () => {
    const byName = await rows('get_plsql_errors', { schema: OWNER, name: BROKEN_PROC });
    expect(byName.length).toBeGreaterThan(0);
    expect(byName[0]?.TYPE).toBe('PROCEDURE');
    expect(byName[0]?.ATTRIBUTE).toBe('ERROR');
    expect(Number(byName[0]?.LINE)).toBeGreaterThan(0);
    expect(String(byName[0]?.TEXT)).toMatch(/PLS-|ORA-/);

    const byType = await rows('get_plsql_errors', {
      schema: OWNER,
      name: BROKEN_PROC,
      type: 'PROCEDURE',
    });
    expect(byType.length).toBeGreaterThan(0);

    const wrongType = await rows('get_plsql_errors', {
      schema: OWNER,
      name: BROKEN_PROC,
      type: 'TRIGGER',
    });
    expect(wrongType).toEqual([]);
  });

  it('oracle_mcp_health_report agrega las 5 sondas con la config efectiva', async () => {
    const result = (await client.callTool({
      name: 'oracle_mcp_health_report',
      arguments: {},
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    const report = JSON.parse(result.content[0]?.text ?? '') as HealthReport;

    expect(['UP', 'DEGRADED']).toContain(report.overallStatus);
    expect(report.databaseName).toBe('FREEPDB1');
    expect(report.checks.map((check) => check.name)).toEqual([
      'database-connectivity',
      'database-version',
      'catalog-role',
      'invalid-objects',
      'server-config',
    ]);
    expect(report.checks[0]?.status).toBe('PASS');
    expect(report.checks[1]?.detail).toMatch(/Oracle/i);
    // T10_IT_BROKEN quedó inválido: la sonda lo cuenta (WARN) o hay más inválidos.
    expect(['PASS', 'WARN']).toContain(report.checks[3]?.status);
    expect(report.checks[4]?.detail).toBe('max-rows=1000, query-timeout=120s, audit=disabled');
  });

  it('el health report muestra audit=enabled cuando la sesión escribe de verdad', async () => {
    // Un solo pool por proceso (NJS-046 por alias duplicado): limpiamos y
    // liberamos el primer server antes de levantar el auditado.
    await dropObjects();
    await handle.close();

    const auditDir = await mkdtemp(join(tmpdir(), 'lu-query-t10-it-'));
    const audited = createServer({
      config: loadConfig({ ...GOOD_ENV, MCP_AUDIT_ENABLED: 'true', MCP_AUDIT_DIR: auditDir }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const auditClient = new Client({ name: 'lu-query-t10-audit', version: '0.0.0' });
    await Promise.all([
      audited.server.connect(serverTransport),
      auditClient.connect(clientTransport),
    ]);

    try {
      const result = (await auditClient.callTool({
        name: 'oracle_mcp_health_report',
        arguments: {},
      })) as ToolResult;
      const report = JSON.parse(result.content[0]?.text ?? '') as HealthReport;

      // Las propias sondas pasan por el chokepoint auditable: la sesión existe.
      expect(report.overallStatus).not.toBe('DOWN');
      expect(report.checks[4]?.detail).toContain('audit=enabled');
    } finally {
      await auditClient.close();
      await audited.close();
    }
  });
});
