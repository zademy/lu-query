import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { loadConfig } from '../../src/config.js';
import { createServer, type ServerHandle } from '../../src/server.js';

/**
 * Integration de las tres tools DML contra el contenedor Oracle real.
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

/** Tabla propia del test; se crea al principio y se borra al final. */
const TABLE = 'LU_TEST_DML';

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

describe.skipIf(!optIn)('tools DML contra Oracle real', () => {
  let handle: ServerHandle;
  let client: Client;
  let auditDir: string;

  beforeAll(async () => {
    auditDir = await mkdtemp(join(tmpdir(), 'lu-query-dml-it-'));
    handle = createServer({ config: loadConfig({ ...GOOD_ENV, MCP_AUDIT_DIR: auditDir }) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'lu-query-dml-integration', version: '0.0.0' });
    await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);

    await call('execute_dml', `DROP TABLE ${TABLE}`).catch(() => undefined);
    await execute(
      `CREATE TABLE ${TABLE} (ID NUMBER PRIMARY KEY, LABEL VARCHAR2(50), AMOUNT NUMBER)`,
    );
    for (const id of [1, 2, 3]) {
      await execute(
        `INSERT INTO ${TABLE} (ID, LABEL, AMOUNT) VALUES (${id}, 'seed-${id}', ${id * 10})`,
      );
    }
  });

  afterAll(async () => {
    await call('execute_dml', `DROP TABLE ${TABLE} PURGE`).catch(() => undefined);
    await client.close();
    await handle.close();
    await rm(auditDir, { recursive: true, force: true });
  });

  const call = async (name: string, sql: string): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: { sql } })) as ToolResult;

  /**DDL y seed también por la tool: es el único camino que confirma cambios. */
  const execute = async (sql: string) => {
    const result = await call('execute_dml', sql);
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content[0]?.text ?? '') as Record<string, unknown>;
  };

  const dml = async (name: string, sql: string) => {
    const result = await call(name, sql);
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content[0]?.text ?? '') as Record<string, unknown>;
  };

  /** Lectura directa por el chokepoint, para comprobar qué quedó en la tabla. */
  const rows = (where = '') =>
    handle.context.dataAccess.queryForList(
      `SELECT ID, LABEL, AMOUNT FROM ${TABLE} ${where} ORDER BY ID`.trim(),
    );

  it('execute_dml_preview cuenta y muestrea sin tocar los datos', async () => {
    const preview = await dml(
      'execute_dml_preview',
      `UPDATE ${TABLE} SET AMOUNT = 0 WHERE ID <= 2`,
    );

    expect(preview).toMatchObject({
      detectedKind: 'UPDATE',
      table: TABLE,
      affectedRowCount: 2,
      sampleCount: 2,
      sampleColumns: ['ID', 'LABEL', 'AMOUNT'],
    });
    expect((await rows('WHERE ID <= 2')).map((row) => row.AMOUNT)).toEqual([10, 20]);
  });

  it('execute_dml_preview rechaza INSERT con isError', async () => {
    const result = await call('execute_dml_preview', `INSERT INTO ${TABLE} (ID) VALUES (9)`);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('execute_dml_rollback_first');
    expect(await rows('WHERE ID = 9')).toHaveLength(0);
  });

  it('execute_dml_rollback_first no persiste el DELETE que dice haber afectado', async () => {
    const dryRun = await dml('execute_dml_rollback_first', `DELETE FROM ${TABLE} WHERE ID = 3`);

    expect(dryRun).toMatchObject({ detectedKind: 'DELETE', rowsAffected: 1, rolledBack: true });
    expect(await rows('WHERE ID = 3')).toHaveLength(1);
  });

  it('execute_dml_rollback_first no persiste el INSERT que dice haber afectado', async () => {
    const dryRun = await dml(
      'execute_dml_rollback_first',
      `INSERT INTO ${TABLE} (ID, LABEL, AMOUNT) VALUES (99, 'ghost', 1)`,
    );

    expect(dryRun).toMatchObject({ detectedKind: 'INSERT', rowsAffected: 1, rolledBack: true });
    expect(await rows('WHERE ID = 99')).toHaveLength(0);
  });

  it('execute_dml confirma el cambio de verdad', async () => {
    expect(await dml('execute_dml', `UPDATE ${TABLE} SET AMOUNT = 99 WHERE ID = 1`)).toEqual({
      statementKind: 'UPDATE',
      rowsAffected: 1,
    });
    expect((await rows('WHERE ID = 1'))[0]?.AMOUNT).toBe(99);
  });

  it('execute_dml manda a Oracle el MERGE que el parser no entiende (UNKNOWN)', async () => {
    expect(
      await dml(
        'execute_dml',
        `MERGE INTO ${TABLE} t USING (SELECT 1 AS ID FROM dual) s ON (t.ID = s.ID) WHEN MATCHED THEN UPDATE SET t.LABEL = 'merged'`,
      ),
    ).toEqual({ statementKind: 'UNKNOWN', rowsAffected: 1 });
    expect((await rows('WHERE ID = 1'))[0]?.LABEL).toBe('merged');
  });

  it('deja las sentencias DML auditadas con type WRITE', async () => {
    const [file] = await readdir(auditDir);
    const markdown = await readFile(join(auditDir, file ?? ''), 'utf8');

    expect(markdown).toMatch(/· execute_dml · UPDATE · WRITE · ✅ OK/);
    expect(markdown).toMatch(/· execute_dml_rollback_first · DELETE · WRITE · ✅ OK/);
  });
});
