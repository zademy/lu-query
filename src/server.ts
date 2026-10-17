import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAuditResource } from './audit/audit-resource.js';
import { type ResolvedConfig } from './config.js';
import { createOracleDataAccess, createPoolProvider } from './db/pool.js';
import type { DataAccess } from './db/data-access.js';
import { registerToolGroups } from './tools/registry.js';

export const SERVER_NAME = 'lu-query';

/**
 * McpServer instala el handler de `tools/list` al registrar la primera tool,
 * así que sin tools el método da "Method not found". Lo forzamos para que el
 * server responda desde el primer arranque con la lista vacía.
 */
function initToolRequestHandlers(server: McpServer): void {
  (server as unknown as { setToolRequestHandlers(): void }).setToolRequestHandlers();
}

/** Lo que cada grupo de tools recibe para registrar lo suyo. */
export interface ServerContext {
  server: McpServer;
  dataAccess: DataAccess;
  config: ResolvedConfig;
}

export interface ServerHandle {
  server: McpServer;
  context: ServerContext;
  /** Cierra transporte y pool. Idempotente. */
  close(): Promise<void>;
}

export interface CreateServerDeps {
  config: ResolvedConfig;
  /** Si no se inyecta, se usa el pool real (lazy: no conecta hasta la 1ª query). */
  dataAccess?: DataAccess;
}

export function createServer(deps: CreateServerDeps): ServerHandle {
  const { config } = deps;
  const dataAccess = deps.dataAccess ?? createOracleDataAccess(createPoolProvider(config));

  const server = new McpServer({ name: SERVER_NAME, version: config.serverVersion });
  const context: ServerContext = { server, dataAccess, config };
  registerToolGroups(context);
  registerAuditResource(context);
  initToolRequestHandlers(server);

  let closed = false;
  return {
    server,
    context,
    async close() {
      if (closed) return;
      closed = true;
      await server.server.close();
      await dataAccess.close();
    },
  };
}

/** Arranca el server MCP sobre stdio (stdout exclusivo del JSON-RPC). */
export async function startStdioServer(config: ResolvedConfig): Promise<ServerHandle> {
  const handle = createServer({ config });
  await handle.server.connect(new StdioServerTransport());
  return handle;
}
