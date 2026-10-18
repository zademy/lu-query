import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import type { DataAccess } from '../../src/db/data-access.js';
import { createServer, type ServerHandle } from '../../src/server.js';

/**
 * Integration del tope de filas del chokepoint contra el contenedor Oracle real.
 *
 * El default de maxRows en oracledb son 100 filas, no las MAX_ROWS (1000) que
 * promete el server. Antes de unificarlo, toda tool de lectura que no pasaba el
 * tope explicito truncaba en 100 filas sin avisar. Aqui se crean mas de 100
 * constraints en una tabla propia para que la truncacion sea visible por MCP:
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

const TABLE = 'T90_IT_ROWS';
/** Uno por encima del default del driver (100): si el tope no se aplica, se ve. */
const CONSTRAINT_COUNT = 101;
const constraintName = (n: number): string => 'T90_IT_ROWS_C' + n;

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

describe.skipIf(!optIn)('tope de filas del chokepoint contra Oracle real', () => {
  let handle: ServerHandle;
  let client: Client;
  let db: DataAccess;
  let auditDir: string;

  beforeAll(async () => {
    auditDir = await mkdtemp(join(tmpdir(), 'lu-query-maxrows-it-'));
    handle = createServer({ config: loadConfig({ ...GOOD_ENV, MCP_AUDIT_DIR: auditDir }) });
    db = handle.context.dataAccess;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'lu-query-maxrows-integration', version: '0.0.0' });
    await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);

    await db.execute('CREATE TABLE ' + TABLE + ' (ID NUMBER PRIMARY KEY, TXT VARCHAR2(50))');
    // Oracle admite varios CHECK sobre la misma columna si el nombre cambia.
    for (let i = 0; i < CONSTRAINT_COUNT; i++) {
      await db.execute(
        'ALTER TABLE ' + TABLE + ' ADD CONSTRAINT ' + constraintName(i) + ' CHECK (TXT IS NOT NULL)',
      );
    }
  }, 180_000);

  afterAll(async () => {
    await db.execute('DROP TABLE ' + TABLE + ' PURGE').catch(() => undefined);
    await client.close();
    await handle.close();
    await rm(auditDir, { recursive: true, force: true });
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as ToolResult;

  const rows = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>[]> => {
    const resultado = await call(name, args);
    if (resultado.isError) throw new Error(resultado.content[0]?.text ?? "sin texto");
    return JSON.parse(resultado.content[0]?.text ?? '[]') as Record<string, unknown>[];
  };

  const runQueryRows = async (sql: string): Promise<Record<string, unknown>[]> => {
    const resultado = await call('run_query', { sql });
    expect(resultado.isError).toBeFalsy();
    return (JSON.parse(resultado.content[0]?.text ?? '{}') as { rows: Record<string, unknown>[] })
      .rows;
  };

  it('list_constraints devuelve las 102 y no se queda en 100', async () => {
    const constraints = await rows('list_constraints', { table: TABLE });
    expect(constraints).toHaveLength(CONSTRAINT_COUNT + 1); // + la PK
    const names = constraints.map((row) => String(row.CONSTRAINT_NAME));
    expect(names).toContain(constraintName(0));
    expect(names).toContain(constraintName(CONSTRAINT_COUNT - 1));
  });

  it('run_query sin limite explicito tampoco corta en 100', async () => {
    const resultado = await runQueryRows(
      "SELECT constraint_name FROM user_constraints WHERE table_name = '" + TABLE + "'",
    );
    expect(resultado).toHaveLength(CONSTRAINT_COUNT + 1);
  });
});
