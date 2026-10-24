import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createHarness } from '../helpers/harness.js';

/**
 * Integration del transporte real: el MCP sobre stdio en un proceso hijo, no el
 * InMemoryTransport de las demas suites. Es el camino de produccion (npx
 * lu-query) y el unico que nadie probaba: banner a stderr, stdout reservado al
 * JSON-RPC, arranque y cierre limpios, y configuracion por entorno.
 *
 * El entry point se construye con `npm run build` (vp pack, dist/index.js,
 * el artefacto real de produccion) para poder arrancarlo como proceso hijo:
 * node no puede ejecutar el TS tal cual (los
 * imports usan extension .js y hay parameter properties).
 *   LU_TEST_INTEGRATION=1 \
 *   ORACLE_DB_URL='jdbc:oracle:thin:@//localhost:1521/FREEPDB1' \
 *   ORACLE_DB_USERNAME=DEVUSER ORACLE_DB_PASSWORD=DevPassword123 npm run test:integration
 */
const optIn = process.env.LU_TEST_INTEGRATION === '1';

const exec = promisify(execFile);

const GOOD_ENV: NodeJS.ProcessEnv = {
  ORACLE_DB_URL: process.env.ORACLE_DB_URL ?? 'jdbc:oracle:thin:@//localhost:1521/FREEPDB1',
  ORACLE_DB_USERNAME: process.env.ORACLE_DB_USERNAME ?? 'DEVUSER',
  ORACLE_DB_PASSWORD: process.env.ORACLE_DB_PASSWORD ?? 'DevPassword123',
};

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ENTRY = join(ROOT, 'dist/index.js');

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

const spawnServer = async (
  env: NodeJS.ProcessEnv = {},
): Promise<{ client: Client; transport: StdioClientTransport }> => {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [ENTRY],
    env: Object.fromEntries(
      Object.entries({ ...process.env, ...GOOD_ENV, ...env }).filter((par) => par[1] !== undefined),
    ) as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'lu-query-stdio-integration', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
};

describe.skipIf(!optIn)('el MCP sobre stdio real, en un proceso hijo', () => {
  let auditDir: string;

  beforeAll(async () => {
    await exec('npm', ['run', 'build'], { cwd: ROOT });
    auditDir = await mkdtemp(join(tmpdir(), 'lu-query-stdio-it-'));
  }, 120_000);

  afterAll(async () => {
    await rm(auditDir, { recursive: true, force: true });
  });

  it('arranca por stdio y responde initialize', async () => {
    const { client, transport } = await spawnServer();
    try {
      expect(client.getServerVersion()?.name).toBe('lu-query');
      expect(client.getServerVersion()?.version).toBeTruthy();
      expect(client.getServerCapabilities()?.tools).toBeDefined();
    } finally {
      await client.close();
      await transport.close();
    }
  }, 60_000);

  it('publica las mismas tools que el server en proceso', async () => {
    const { client, transport } = await spawnServer();
    try {
      const porStdio = (await client.listTools()).tools.map((t) => t.name).sort();
      const harness = await createHarness();
      try {
        const enProceso = (await harness.client.listTools()).tools.map((t) => t.name).sort();
        expect(porStdio).toEqual(enProceso);
        expect(porStdio.length).toBe(75);
      } finally {
        await harness.close();
      }
    } finally {
      await client.close();
      await transport.close();
    }
  }, 60_000);

  it('consulta de verdad contra Oracle por stdio', async () => {
    const { client, transport } = await spawnServer();
    try {
      const resultado = (await client.callTool({
        name: 'run_query',
        arguments: { sql: 'SELECT 1 AS N FROM DUAL' },
      })) as ToolResult;
      expect(resultado.isError).toBeFalsy();
      expect(resultado.content[0]?.text).toContain('"N"');

      const conexion = (await client.callTool({
        name: 'test_connection',
        arguments: {},
      })) as ToolResult;
      expect(conexion.isError).toBeFalsy();
      expect(conexion.content[0]?.text).toContain('Oracle');
    } finally {
      await client.close();
      await transport.close();
    }
  }, 60_000);

  it('el banner va a stderr y stdout solo lleva JSON-RPC', async () => {
    // A mano, sin el SDK, para poder mirar el stdout crudo del hijo.
    const hijo = spawn('node', [ENTRY], {
      env: { ...process.env, ...GOOD_ENV },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    hijo.stdout.on('data', (trozo: Buffer) => (stdout += trozo.toString()));
    hijo.stderr.on('data', (trozo: Buffer) => (stderr += trozo.toString()));
    hijo.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'lu-query-stdio-integration', version: '0.0.0' },
        },
      }) + '\n',
    );

    try {
      await new Promise((resolver) => setTimeout(resolver, 2500));
      const lineas = stdout.split('\n').filter((linea) => linea.trim() !== '');
      expect(lineas.length).toBeGreaterThan(0);
      for (const linea of lineas) {
        const mensaje = JSON.parse(linea) as { jsonrpc?: string };
        expect(mensaje.jsonrpc).toBe('2.0');
      }
      expect(stderr).toContain('escuchando MCP sobre stdio');
    } finally {
      hijo.kill('SIGKILL');
    }
  }, 60_000);

  it('el proceso sale con codigo 0 cuando el cliente cierra', async () => {
    const { client, transport } = await spawnServer();
    const proceso = (transport as unknown as { _process?: { exitCode: number | null } })._process;
    expect(proceso).toBeDefined();

    await client.close();
    await transport.close();

    expect(proceso?.exitCode).toBe(0);
  }, 60_000);

  it('con credenciales malas la tool responde isError y el server sigue vivo', async () => {
    const { client, transport } = await spawnServer({ ORACLE_DB_PASSWORD: 'no-es-la-clave' });
    try {
      const resultado = (await client.callTool({
        name: 'test_connection',
        arguments: {},
      })) as ToolResult;
      expect(resultado.isError).toBe(true);
      expect(resultado.content[0]?.text).toMatch(/ORA-|credencial|password|密码/i);

      // El server no se cae: sigue respondiendo el catalogo de tools.
      expect((await client.listTools()).tools.length).toBe(75);
    } finally {
      await client.close();
      await transport.close();
    }
  }, 60_000);

  it('la auditoria escribe su .md con el MCP_AUDIT_DIR del entorno', async () => {
    const { client, transport } = await spawnServer({ MCP_AUDIT_DIR: auditDir });
    try {
      const resultado = (await client.callTool({
        name: 'run_query',
        arguments: { sql: 'SELECT 1 AS N FROM DUAL' },
      })) as ToolResult;
      expect(resultado.isError).toBeFalsy();

      const [archivo] = await readdir(auditDir);
      expect(archivo).toMatch(/^lu-query-.*-log\.md$/);
      const markdown = await readFile(join(auditDir, archivo!), 'utf8');
      expect(markdown).toContain('| format-version | 3-md |');
      expect(markdown).toContain('SELECT 1 AS N FROM DUAL');
    } finally {
      await client.close();
      await transport.close();
    }
  }, 60_000);
});
