import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createServer } from '../../src/server.js';

/**
 * Integration de la auditoría end-to-end contra el contenedor Oracle real.
 * Opt-in (con la auditoría activada por defecto):
 *   LU_TEST_INTEGRATION=1 MCP_AUDIT_DIR=$(mktemp -d) \
 *   ORACLE_DB_URL='jdbc:oracle:thin:@//localhost:1521/FREEPDB1' \
 *   ORACLE_DB_USERNAME=DEVUSER ORACLE_DB_PASSWORD=DevPassword123 npm run test:integration
 */
const optIn = process.env.LU_TEST_INTEGRATION === '1';

const GOOD_ENV: NodeJS.ProcessEnv = {
  ORACLE_DB_URL: process.env.ORACLE_DB_URL ?? 'jdbc:oracle:thin:@//localhost:1521/FREEPDB1',
  ORACLE_DB_USERNAME: process.env.ORACLE_DB_USERNAME ?? 'DEVUSER',
  ORACLE_DB_PASSWORD: process.env.ORACLE_DB_PASSWORD ?? 'DevPassword123',
};

const FILE_NAME = /^lu-query-(\d{8}T\d{6}\.\d{9}[+-]\d{4})-log\.md$/;

describe.skipIf(!optIn)('auditoría Markdown end-to-end', () => {
  it('una tool real deja su entrada en el .md de la sesión y el recurso la sirve', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lu-query-audit-it-'));
    // Mismo camino que producción: pool real, auditoría con su default (true).
    const handle = createServer({ config: loadConfig({ ...GOOD_ENV, MCP_AUDIT_DIR: dir }) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'lu-query-audit-integration', version: '0.0.0' });
    await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      expect(await readdir(dir).catch(() => [])).toEqual([]); // lazy: nada hasta la 1ª entrada

      const result = await client.callTool({ name: 'test_connection', arguments: {} });
      expect(result.isError).toBeFalsy();

      const [file] = await readdir(dir);
      const sessionId = FILE_NAME.exec(file ?? '')?.[1] ?? '';
      expect(sessionId).not.toBe('');
      expect(file).toBeTruthy();

      const markdown = await readFile(join(dir, file!), 'utf8');
      expect(markdown).toContain(`| session-id     | ${sessionId} |`);
      expect(markdown).toContain('| format-version | 3-md |');
      expect(markdown).toMatch(/### #1 · \d\d:\d\d:\d\d · test_connection · SELECT · READ · ✅ OK/);
      expect(markdown).toContain('```sql\nSELECT (SELECT banner FROM v$version');
      expect(markdown).toMatch(/\| Filas      \| 1 \|/);

      const current = await client.readResource({ uri: 'oracle://audit/session/current' });
      expect(String((current.contents[0] as { text?: string }).text)).toBe(markdown);

      const completion = await client.complete({
        ref: { type: 'ref/resource', uri: 'oracle://audit/session/{id}' },
        argument: { name: 'id', value: sessionId },
      });
      expect(completion.completion.values).toEqual([sessionId]);
    } finally {
      await client.close();
      await handle.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
