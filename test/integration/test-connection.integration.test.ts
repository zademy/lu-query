import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vite-plus/test';
import { loadConfig } from '../../src/config.js';
import { createServer } from '../../src/server.js';

/**
 * Integration contra el contenedor Oracle real. Opt-in:
 *   LU_TEST_INTEGRATION=1 ORACLE_DB_URL='jdbc:oracle:thin:@//localhost:1521/FREEPDB1' \
 *   ORACLE_DB_USERNAME=DEVUSER ORACLE_DB_PASSWORD=DevPassword123 npm run test:integration
 */
const optIn = process.env.LU_TEST_INTEGRATION === '1';

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

interface RealOracle {
  testConnection: () => Promise<ToolResult>;
  close: () => Promise<void>;
}

/** Server MCP con el pool real (createServer sin dataAccess = camino de producción). */
async function connectRealOracle(env: NodeJS.ProcessEnv): Promise<RealOracle> {
  const handle = createServer({ config: loadConfig({ ...env, MCP_AUDIT_ENABLED: 'false' }) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'lu-query-integration', version: '0.0.0' });
  await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    testConnection: () =>
      client.callTool({ name: 'test_connection', arguments: {} }) as Promise<ToolResult>,
    close: async () => {
      await client.close();
      await handle.close();
    },
  };
}

const GOOD_ENV: NodeJS.ProcessEnv = {
  ORACLE_DB_URL: process.env.ORACLE_DB_URL ?? 'jdbc:oracle:thin:@//localhost:1521/FREEPDB1',
  ORACLE_DB_USERNAME: process.env.ORACLE_DB_USERNAME ?? 'DEVUSER',
  ORACLE_DB_PASSWORD: process.env.ORACLE_DB_PASSWORD ?? 'DevPassword123',
};

describe.skipIf(!optIn)('test_connection contra Oracle', () => {
  it('devuelve versión, nombre de BD, usuario, schema e instancia', async () => {
    const oracle = await connectRealOracle(GOOD_ENV);

    try {
      const result = await oracle.testConnection();
      const info = JSON.parse(result.content[0]?.text ?? '') as Record<string, string>;

      expect(result.isError).toBeFalsy();
      expect(info.databaseVersion).toMatch(/Oracle/i);
      expect(info.databaseName).toBe('FREEPDB1');
      expect(info.currentUser).toBe(GOOD_ENV.ORACLE_DB_USERNAME);
      expect(info.currentSchema).not.toBe('');
      expect(info.instanceName).not.toBe('');
    } finally {
      await oracle.close();
    }
  }, 60_000);

  it('aplica ORACLE_DB_SCHEMA como CURRENT_SCHEMA de la sesión', async () => {
    // PDBADMIN es otro usuario del contenedor al que DEVUSER puede cambiar de
    // schema, así el connection-init se ve en el resultado y no solo "no rompe".
    const oracle = await connectRealOracle({ ...GOOD_ENV, ORACLE_DB_SCHEMA: 'PDBADMIN' });

    try {
      const result = await oracle.testConnection();
      const info = JSON.parse(result.content[0]?.text ?? '') as Record<string, string>;

      expect(result.isError).toBeFalsy();
      expect(info.currentSchema).toBe('PDBADMIN');
      expect(info.currentUser).toBe(GOOD_ENV.ORACLE_DB_USERNAME);
    } finally {
      await oracle.close();
    }
  }, 60_000);

  it('ignora un ORACLE_DB_SCHEMA inválido con warning y sigue operando', async () => {
    const oracle = await connectRealOracle({
      ...GOOD_ENV,
      ORACLE_DB_SCHEMA: 'evil"; DROP TABLE t; --',
    });

    try {
      const result = await oracle.testConnection();
      const info = JSON.parse(result.content[0]?.text ?? '') as Record<string, string>;

      expect(result.isError).toBeFalsy();
      expect(info.currentSchema).toBe(GOOD_ENV.ORACLE_DB_USERNAME);
    } finally {
      await oracle.close();
    }
  }, 60_000);

  it('responde isError, sin excepción, con credenciales incorrectas', async () => {
    const oracle = await connectRealOracle({ ...GOOD_ENV, ORACLE_DB_PASSWORD: 'no-es-la-clave' });

    try {
      const result = await oracle.testConnection();

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/ORA-01017|logon denied/i);
    } finally {
      await oracle.close();
    }
  }, 60_000);
});
