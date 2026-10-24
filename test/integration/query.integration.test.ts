import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { loadConfig } from '../../src/config.js';
import { createServer, type ServerHandle } from '../../src/server.js';

/**
 * Integration de las tools de lectura contra el contenedor Oracle real.
 *   LU_TEST_INTEGRATION=1 \
 *   ORACLE_DB_URL='jdbc:oracle:thin:@//localhost:1521/FREEPDB1' \
 *   ORACLE_DB_USERNAME=DEVUSER ORACLE_DB_PASSWORD=DevPassword123 npm run test:integration
 */
const optIn = process.env.LU_TEST_INTEGRATION === '1';

const GOOD_ENV: NodeJS.ProcessEnv = {
  ORACLE_DB_URL: process.env.ORACLE_DB_URL ?? 'jdbc:oracle:thin:@//localhost:1521/FREEPDB1',
  ORACLE_DB_USERNAME: process.env.ORACLE_DB_USERNAME ?? 'DEVUSER',
  ORACLE_DB_PASSWORD: process.env.ORACLE_DB_PASSWORD ?? 'DevPassword123',
};

/** Tabla de lectura del contenedor (esquema del usuario de conexión). */
const TABLE = 'EMPLOYEES';

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

describe.skipIf(!optIn)('tools de lectura contra Oracle real', () => {
  let handle: ServerHandle;
  let client: Client;
  let auditDir: string;

  beforeAll(async () => {
    auditDir = await mkdtemp(join(tmpdir(), 'lu-query-query-it-'));
    handle = createServer({ config: loadConfig({ ...GOOD_ENV, MCP_AUDIT_DIR: auditDir }) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'lu-query-query-integration', version: '0.0.0' });
    await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await handle.close();
    await rm(auditDir, { recursive: true, force: true });
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as ToolResult;

  const query = async (args: Record<string, unknown>) => {
    const result = await call('run_query', args);
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content[0]?.text ?? '') as {
      columns: string[];
      rows: Record<string, unknown>[];
      rowCount: number;
      truncated: boolean;
      rowLimit: number;
      offset: number;
      limit: number;
    };
  };

  it('pagina EMPLOYEES con offset/limit y marca truncated con honestidad', async () => {
    const sql = `SELECT * FROM ${TABLE} ORDER BY emp_id`;
    const total = (await query({ sql, limit: 1000 })).rowCount;

    const first = await query({ sql, offset: 0, limit: 2 });
    const second = await query({ sql, offset: 2, limit: 2 });
    const past = await query({ sql, offset: total + 10, limit: 2 });

    expect(total).toBeGreaterThan(0);
    expect(first.columns).toContain('EMP_ID');
    expect(first).toMatchObject({
      rowCount: 2,
      truncated: true,
      offset: 0,
      limit: 2,
      rowLimit: 1000,
    });
    expect(second).toMatchObject({ rowCount: 2, truncated: true, offset: 2, limit: 2 });
    // La segunda página no repite filas de la primera.
    expect(second.rows[0]?.EMP_ID).not.toBe(first.rows[0]?.EMP_ID);
    expect(past).toMatchObject({ rowCount: 0, truncated: false, columns: [] });
  }, 60_000);

  it('devuelve un sample de la tabla con el schema explícito', async () => {
    const result = await call('get_sample_data', {
      schema: GOOD_ENV.ORACLE_DB_USERNAME,
      table: TABLE,
      rows: 3,
    });

    expect(result.isError).toBeFalsy();
    const sample = JSON.parse(result.content[0]?.text ?? '') as { rowCount: number; limit: number };
    expect(sample.limit).toBe(3);
    expect(sample.rowCount).toBe(3);
  }, 60_000);

  it('muestra el default de 10 filas sin pedir número de filas', async () => {
    const result = await call('get_sample_data', { table: TABLE });

    expect(result.isError).toBeFalsy();
    expect((JSON.parse(result.content[0]?.text ?? '') as { limit: number }).limit).toBe(10);
  }, 60_000);

  it('devuelve un SQL inválido como isError, sin romper el transporte', async () => {
    const result = await call('run_query', { sql: 'SELECT FROM WHERE' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('ORA-');

    // El canal sigue vivo: la siguiente llamada funciona.
    expect((await query({ sql: `SELECT 1 FROM dual` })).rowCount).toBe(1);
  }, 60_000);

  it('deja en el .md de auditoría cada lectura con tool, parámetros y tipo READ', async () => {
    await query({ sql: `SELECT * FROM ${TABLE} ORDER BY emp_id`, offset: 1, limit: 2 });
    await call('get_sample_data', { schema: GOOD_ENV.ORACLE_DB_USERNAME, table: TABLE, rows: 2 });

    const [file] = await readdir(auditDir);
    const markdown = await readFile(join(auditDir, file!), 'utf8');

    expect(markdown).toMatch(/### #\d+ · \d\d:\d\d:\d\d · run_query · SELECT · READ · ✅ OK/);
    expect(markdown).toContain(
      `| Parámetros | sql=SELECT * FROM ${TABLE} ORDER BY emp_id, offset=1, limit=2 |`,
    );
    expect(markdown).toContain(`OFFSET 1 ROWS FETCH NEXT 2 ROWS ONLY`);
    expect(markdown).toMatch(/### #\d+ · \d\d:\d\d:\d\d · get_sample_data · SELECT · READ · ✅ OK/);
    expect(markdown).toContain(
      '```sql\nSELECT * FROM "DEVUSER"."EMPLOYEES" FETCH FIRST 2 ROWS ONLY',
    );
    expect(markdown).toMatch(/\| Filas      \| 2 \|/);
  }, 60_000);
});
