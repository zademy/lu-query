import { assertNodeVersion, loadConfig } from './config.js';
import { startStdioServer } from './server.js';

// Guard de runtime: `engines` de npm no cubre ejecutar dist/index.js directo.
try {
  assertNodeVersion(process.versions.node);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

// stdout queda reservado al JSON-RPC del server MCP; los logs van a stderr.
try {
  const config = loadConfig();
  const handle = await startStdioServer(config);
  process.stderr.write(`lu-query ${config.serverVersion} escuchando MCP sobre stdio\n`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void handle.close().finally(() => process.exit(0));
    });
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`lu-query no pudo arrancar: ${message}\n`);
  process.exit(1);
}
