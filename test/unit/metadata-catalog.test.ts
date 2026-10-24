import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { loadConfig } from '../../src/config.js';
import { FakeDataAccess } from '../../src/db/fake-data-access.js';
import { DataAccessError } from '../../src/errors.js';
import { createServer } from '../../src/server.js';
import { createHarness, type Harness, type HarnessOptions } from '../helpers/harness.js';

/** El SDK tipa el content como unión de bloques; estas tools devuelven texto. */
interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

async function call(harness: Harness, name: string, args: Record<string, unknown>) {
  return (await harness.client.callTool({ name, arguments: args })) as ToolResult;
}

async function withHarness<T>(
  options: HarnessOptions,
  run: (harness: Harness) => Promise<T>,
): Promise<T> {
  const harness = await createHarness(options);
  try {
    return await run(harness);
  } finally {
    await harness.close();
  }
}

/** JSON del bloque de texto de un resultado correcto. */
function payload(result: ToolResult): unknown {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]?.text ?? '');
}

const DEVUSER = 'DEVUSER';
const TABLE = 'EMPLOYEES';

const CATALOG_TOOLS = [
  'list_indexes',
  'list_constraints',
  'list_sequences',
  'get_sequence_info',
  'list_triggers',
  'list_procedures',
  'list_synonyms',
  'list_db_links',
  'list_directories',
  'list_external_tables',
  'list_materialized_views',
  'list_mview_logs',
  'list_partitions',
  'list_ind_partitions',
  'list_subpartitions',
  'list_lob_columns',
  'list_types',
  'list_invalid_objects',
  'list_dependencies',
  'list_scheduler_jobs',
  'list_scheduler_job_runs',
] as const;

/** Tools que necesitan owner: sin schema resuelven al actual (como `orCurrent`). */
const OWNER_TOOLS = [
  'list_indexes',
  'list_constraints',
  'list_partitions',
  'list_subpartitions',
  'list_ind_partitions',
  'list_lob_columns',
  'list_dependencies',
] as const;

describe('tools/list · grupo MetadataCatalog', () => {
  it('publica las 21 tools del catálogo con las descripciones del Java', async () => {
    await withHarness({}, async (harness) => {
      const { tools } = await harness.client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool]));

      for (const name of CATALOG_TOOLS) expect(byName.has(name)).toBe(true);
      expect(byName.get('list_indexes')?.description).toBe(
        'List indexes on a table with their columns, uniqueness and status.',
      );
      expect(byName.get('list_scheduler_jobs')?.description).toBe(
        'List DBMS_SCHEDULER jobs with state, run/failure counts, last start, next run and repeat interval.',
      );
      // Owner resuelto contra el schema actual: `table` es el único requerido.
      expect(byName.get('list_indexes')?.inputSchema).toMatchObject({ required: ['table'] });
      expect(byName.get('get_sequence_info')?.inputSchema).toMatchObject({
        required: ['sequence'],
      });
      expect(byName.get('list_sequences')?.inputSchema).toMatchObject({ type: 'object' });
      expect(byName.get('list_sequences')?.inputSchema.required).toBeUndefined();
      // Sin filtros: no piden nada, como en el Java.
      expect(byName.get('list_db_links')?.inputSchema.required).toBeUndefined();
      expect(byName.get('list_directories')?.inputSchema.required).toBeUndefined();
    });
  });

  it('list_indexes usa el schema actual cuando el cliente omite schema', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({
      rows: [
        { INDEX_NAME: 'EMP_PK', COLUMNS: 'EMPLOYEE_ID', UNIQUENESS: 'UNIQUE', STATUS: 'VALID' },
      ],
    }));

    await withHarness({ dataAccess, config: { schema: DEVUSER } }, async (harness) => {
      expect(payload(await call(harness, 'list_indexes', { table: TABLE }))).toEqual([
        { INDEX_NAME: 'EMP_PK', COLUMNS: 'EMPLOYEE_ID', UNIQUENESS: 'UNIQUE', STATUS: 'VALID' },
      ]);
      expect(dataAccess.calls[0]?.sql).toContain('FROM all_indexes i');
      expect(dataAccess.calls[0]?.sql).toContain('FROM all_ind_columns ic');
      expect(dataAccess.calls[0]?.binds).toEqual([DEVUSER, TABLE]);
    });
  });

  it.each(OWNER_TOOLS)('%s consulta la sesión y falla si tampoco hay schema', async (name) => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: [] }));
    const args = name === 'list_dependencies' ? { name: TABLE } : { table: TABLE };

    await withHarness({ dataAccess }, async (harness) => {
      const result = await call(harness, name, args);

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain(`${name} necesita un schema`);
      // Sólo la consulta del schema de sesión: la de catálogo nunca sale.
      expect(dataAccess.calls).toHaveLength(1);
      expect(dataAccess.calls[0]?.sql).toContain('SYS_CONTEXT');
    });
  });

  it.each(OWNER_TOOLS.filter((tool) => tool !== 'list_dependencies'))(
    '%s valida el nombre de la tabla contra la allow-list',
    async (name) => {
      const dataAccess = new FakeDataAccess().always(() => ({ rows: [] }));

      await withHarness({ dataAccess, config: { schema: DEVUSER } }, async (harness) => {
        const result = await call(harness, name, { table: 'EMP; DROP TABLE X' });

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain('tabla inválido');
        expect(dataAccess.calls).toHaveLength(0);
      });
    },
  );

  it('los listados por owner con schema omitido consultan todos los schemas', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: [] }));

    await withHarness({ dataAccess, config: { schema: DEVUSER } }, async (harness) => {
      await call(harness, 'list_sequences', {});
      await call(harness, 'list_triggers', {});
      await call(harness, 'list_types', {});
      await call(harness, 'list_mview_logs', {});
      await call(harness, 'list_external_tables', {});
      await call(harness, 'list_scheduler_jobs', {});

      for (const call_ of dataAccess.calls) expect(call_.binds).toEqual([null, null]);
      expect(dataAccess.calls[0]?.sql).toContain('FROM all_sequences');
    });
  });

  it('los listados por owner con schema explícito filtran por él', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: [] }));

    await withHarness({ dataAccess }, async (harness) => {
      await call(harness, 'list_scheduler_jobs', { schema: DEVUSER });

      expect(dataAccess.calls[0]?.binds).toEqual([DEVUSER, DEVUSER]);
    });
  });

  it.each([
    ['list_synonyms', 'synonym_name'],
    ['list_materialized_views', 'mview_name'],
    ['list_procedures', 'object_name'],
  ] as const)('%s aplica el patrón LIKE por defecto y el del cliente', async (name, column) => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: [] }));

    await withHarness({ dataAccess, config: { schema: DEVUSER } }, async (harness) => {
      await call(harness, name, {});
      await call(harness, name, { namePattern: 'EMP%' });

      expect(dataAccess.calls[0]?.sql).toContain(`${column} LIKE :pattern`);
      expect(dataAccess.calls[0]?.binds?.at(-1)).toBe('%');
      expect(dataAccess.calls[1]?.binds?.at(-1)).toBe('EMP%');
    });
  });

  it('list_procedures y list_invalid_objects rechazan un tipo fuera de la allow-list', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: [] }));

    await withHarness({ dataAccess, config: { schema: DEVUSER } }, async (harness) => {
      const procedures = await call(harness, 'list_procedures', { type: 'PROC; DROP' });
      const invalid = await call(harness, 'list_invalid_objects', { type: "' OR '1'='1" });

      expect(procedures.isError).toBe(true);
      expect(procedures.content[0]?.text).toContain('tipo inválido');
      expect(invalid.isError).toBe(true);
      expect(dataAccess.calls).toHaveLength(0);
    });
  });

  it('list_db_links y list_directories no piden argumentos ni binds', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: [{ NAME: 'LOOPBACK' }] }));

    await withHarness({ dataAccess, config: { schema: DEVUSER } }, async (harness) => {
      expect(payload(await call(harness, 'list_db_links', {}))).toEqual([{ NAME: 'LOOPBACK' }]);
      expect(payload(await call(harness, 'list_directories', {}))).toEqual([{ NAME: 'LOOPBACK' }]);
      expect(dataAccess.calls[0]?.binds).toBeUndefined();
      expect(dataAccess.calls[1]?.binds).toBeUndefined();
      expect(dataAccess.calls[0]?.sql).toContain('FROM all_db_links');
      expect(dataAccess.calls[1]?.sql).toContain('FROM all_directories');
    });
  });

  it('get_sequence_info devuelve la fila de la secuencia', async () => {
    const row = { SCHEMA_NAME: DEVUSER, SEQUENCE_NAME: 'EMP_SEQ', INCREMENT_BY: 1 };
    const dataAccess = new FakeDataAccess().always(() => ({ rows: [row] }));

    await withHarness({ dataAccess, config: { schema: DEVUSER } }, async (harness) => {
      expect(payload(await call(harness, 'get_sequence_info', { sequence: 'EMP_SEQ' }))).toEqual(
        row,
      );
      expect(dataAccess.calls[0]?.sql).toContain('order_flag');
      expect(dataAccess.calls[0]?.binds).toEqual([DEVUSER, 'EMP_SEQ']);
    });
  });

  it('get_sequence_info avisa cuando la secuencia no existe, sin JSON', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: [] }));

    await withHarness({ dataAccess, config: { schema: DEVUSER } }, async (harness) => {
      const result = await call(harness, 'get_sequence_info', { sequence: 'NOPE' });

      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toBe(`Sequence not found: ${DEVUSER}.NOPE`);
    });
  });

  it('list_scheduler_job_runs filtra por job y corta en 20 filas por defecto', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: [] }));

    await withHarness({ dataAccess, config: { schema: DEVUSER } }, async (harness) => {
      await call(harness, 'list_scheduler_job_runs', { jobName: 'NIGHTLY' });
      await call(harness, 'list_scheduler_job_runs', { limit: 5 });

      expect(dataAccess.calls[0]?.sql).toContain('FETCH FIRST :limit ROWS ONLY');
      expect(dataAccess.calls[0]?.binds).toEqual([null, null, 'NIGHTLY', 'NIGHTLY', 20]);
      expect(dataAccess.calls[1]?.binds).toEqual([null, null, null, null, 5]);
    });
  });

  it('un fallo del diccionario sale como isError y no rompe el transporte', async () => {
    const dataAccess = new FakeDataAccess().alwaysFail(
      new DataAccessError('ORA-00942: table or view does not exist', 'SELECT 1 FROM all_sequences'),
    );

    await withHarness({ dataAccess, config: { schema: DEVUSER } }, async (harness) => {
      const result = await call(harness, 'list_sequences', {});

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('ORA-00942');
    });
  });

  it('la llamada queda auditada en el Markdown de la sesión', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lu-query-catalog-audit-'));
    const handle = createServer({
      config: { ...loadConfig({}), audit: { enabled: true, dir } },
      dataAccess: new FakeDataAccess().always(() => ({ rows: [] })),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'lu-query-catalog-audit-test', version: '0.0.0' });

    try {
      await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);
      await client.callTool({
        name: 'list_indexes',
        arguments: { schema: DEVUSER, table: TABLE },
      });
      const { contents } = await client.readResource({
        uri: `oracle://audit/session/${handle.context.audit.sessionId()}`,
      });
      const markdown = String((contents[0] as { text?: string } | undefined)?.text);

      expect(contents[0]?.mimeType).toBe('text/markdown');
      expect(markdown).toContain('list_indexes');
      expect(markdown).toContain('FROM all_indexes i');
    } finally {
      await client.close();
      await handle.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
