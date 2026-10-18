import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuditWriter } from '../../src/audit/audit-writer.js';
import { loadConfig, type ResolvedConfig } from '../../src/config.js';
import { FakeDataAccess } from '../../src/db/fake-data-access.js';
import { createServer } from '../../src/server.js';

export interface Harness {
  client: Client;
  server: McpServer;
  dataAccess: FakeDataAccess;
  audit: AuditWriter;
  close: () => Promise<void>;
}

export interface HarnessOptions {
  dataAccess?: FakeDataAccess;
  config?: Partial<ResolvedConfig>;
}

/**
 * Cliente y servidor MCP en el mismo proceso (InMemoryTransport del SDK):
 * permite probar el protocolo y las tools sin Oracle ni sockets.
 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const config: ResolvedConfig = {
    ...loadConfig({ MCP_AUDIT_ENABLED: 'false' }),
    ...options.config,
  };
  const dataAccess = options.dataAccess ?? new FakeDataAccess();

  const handle = createServer({ config, dataAccess });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: 'lu-query-test-client', version: '0.0.0' });
  await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    server: handle.server,
    dataAccess,
    audit: handle.context.audit,
    async close() {
      await client.close();
      await handle.close();
    },
  };
}
