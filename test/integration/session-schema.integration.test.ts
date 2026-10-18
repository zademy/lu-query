import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createServer, type ServerHandle } from '../../src/server.js';

/**
 * Integration del Schema de sesion contra el contenedor Oracle real, con el
 * server arrancado SIN ORACLE_DB_SCHEMA: las tools de catalogo tienen que
 * operated contra SYS_CONTEXT('USERENV','CURRENT_SCHEMA') de la sesion viva.
 *
 * node-oracledb devuelve el nombre de columna en mayusculas, no el alias del
 * SQL, asi que un fake que devuelve la clave en minusculas esconde el fallo:
 * por eso esto se prueba contra el driver de verdad y no con el Fake.
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

const TABLE = 'EMPLOYEES';
const OWNER = GOOD_ENV.ORACLE_DB_USERNAME as string;

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

describe.skipIf(!optIn)('Schema de sesion contra Oracle real, sin ORACLE_DB_SCHEMA', () => {
  let handle: ServerHandle;
  let client: Client;
  let auditDir: string;

  beforeAll(async () => {
    auditDir = await mkdtemp(join(tmpdir(), 'lu-query-schema-it-'));
    // A proposito sin ORACLE_DB_SCHEMA: esa es la condicion que ejercita SYS_CONTEXT.
    handle = createServer({ config: loadConfig({ ...GOOD_ENV, MCP_AUDIT_DIR: auditDir }) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'lu-query-schema-integration', version: '0.0.0' });
    await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await handle.close();
    await rm(auditDir, { recursive: true, force: true });
  });

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as ToolResult;

  const rows = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>[]> => {
    const resultado = await call(name, args);
    if (resultado.isError) throw new Error(name + ': ' + (resultado.content[0]?.text ?? 'sin texto'));
    return JSON.parse(resultado.content[0]?.text ?? '[]') as Record<string, unknown>[];
  };

  it.each([
    ['list_tables', { namePattern: 'EMPLOYEES' }],
    ['list_indexes', { table: TABLE }],
    ['list_constraints', { table: TABLE }],
    ['list_views', { namePattern: '%' }],
  ])('%s opera contra el schema de la sesion sin pedir schema', async (name, args) => {
    const resultado = await rows(name, args);
    expect(resultado.length).toBeGreaterThan(0);
  });

  it('describe_table resuelve el schema de la sesion', async () => {
    const resultado = await rows('describe_table', { table: TABLE });
    expect(resultado.length).toBeGreaterThan(0);
  });

  it('el schema explicito manda sobre el de la sesion', async () => {
    const resultado = await rows('list_indexes', { table: TABLE, schema: 'SYS' });
    expect(resultado).toEqual([]);
  });

  it('un schema en blanco cae al de la sesion en vez de fallar', async () => {
    const resultado = await rows('list_indexes', { table: TABLE, schema: '   ' });
    expect(resultado.length).toBeGreaterThan(0);
  });

  it('test_connection informa del schema de la sesion', async () => {
    const resultado = await call('test_connection');
    expect(resultado.isError).toBeFalsy();
    expect(resultado.content[0]?.text).toContain(OWNER);
  });
});
