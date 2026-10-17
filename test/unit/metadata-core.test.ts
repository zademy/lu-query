import { describe, expect, it } from 'vitest';
import { FakeDataAccess } from '../../src/db/fake-data-access.js';
import { DataAccessError } from '../../src/errors.js';
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

/** Texto del bloque de texto de una tool o de un recurso MCP. */
function text(result: unknown): string {
  const blocks = result as { content?: { text: string }[]; contents?: { text: string }[] };
  return blocks.content?.[0]?.text ?? blocks.contents?.[0]?.text ?? '';
}

const DEVUSER = 'DEVUSER';

/**
 * Binds del driver: son posicionales, así que un placeholder repetido (`:schema`
 * aparece dos veces en el filtro opcional) repite su valor en el array.
 */
const SQL = String.raw;

describe('tools/list · grupo MetadataCore', () => {
  it('publica las ocho tools de metadata con las descripciones del Java', async () => {
    await withHarness({}, async (harness) => {
      const { tools } = await harness.client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool]));

      expect([...byName.keys()]).toEqual(
        expect.arrayContaining([
          'list_schemas',
          'list_tables',
          'list_views',
          'describe_table',
          'table_exists',
          'search_objects',
          'list_objects',
          'get_ddl',
        ]),
      );
      expect(byName.get('list_schemas')?.description).toBe(
        'List all Oracle schemas (users) visible to the current connection.',
      );
      expect(byName.get('list_tables')?.description).toBe(
        "List tables. Supports an optional schema and a case-insensitive LIKE name pattern (use '%' and '_' wildcards; defaults to '%').",
      );
      expect(byName.get('list_views')?.description).toBe(
        "List views. Optional schema and case-insensitive LIKE name pattern (defaults to '%').",
      );
      expect(byName.get('describe_table')?.inputSchema).toMatchObject({ required: ['table'] });
      expect(byName.get('table_exists')?.inputSchema).toMatchObject({ required: ['table'] });
      expect(byName.get('search_objects')?.inputSchema).toMatchObject({
        required: ['namePattern'],
      });
      expect(byName.get('get_ddl')?.inputSchema).toMatchObject({ required: ['name', 'type'] });
      // Sin `required`: las tools con filtros solo opcionales no lo declaran.
      expect(byName.get('list_objects')?.inputSchema).not.toHaveProperty('required');
    });
  });
});

describe('list_schemas', () => {
  it('devuelve los usuarios del diccionario, ordenados por la query', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({
      rows: [{ USERNAME: 'APPUSER' }, { USERNAME: DEVUSER }],
    }));

    await withHarness({ dataAccess }, async (harness) => {
      expect(payload(await call(harness, 'list_schemas', {}))).toEqual(['APPUSER', DEVUSER]);
      expect(dataAccess.calls[0]?.sql).toBe('SELECT username FROM all_users ORDER BY username');
      expect(dataAccess.calls[0]?.binds).toBeUndefined();
    });
  });
});

describe('list_tables', () => {
  it('busca en todos los schemas con patrón % cuando no se filtró', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: [] }));

    await withHarness({ dataAccess }, async (harness) => {
      await call(harness, 'list_tables', {});

      expect(dataAccess.calls[0]?.sql).toContain('FROM all_tables');
      expect(dataAccess.calls[0]?.sql).toContain(SQL`ESCAPE '\'`);
      expect(dataAccess.calls[0]?.binds).toEqual([null, null, '%']);
    });
  });

  it('envuelve el substring en comodines y lo pasa en mayúsculas', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: [] }));

    await withHarness({ dataAccess }, async (harness) => {
      await call(harness, 'list_tables', { schema: DEVUSER, namePattern: 'emp' });

      expect(dataAccess.calls[0]?.binds).toEqual([DEVUSER, DEVUSER, '%EMP%']);
    });
  });

  it('respeta el comodín que ya trae el patrón en vez de envolverlo', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: [] }));

    await withHarness({ dataAccess }, async (harness) => {
      await call(harness, 'list_tables', { namePattern: 'EMP%' });

      expect(dataAccess.calls[0]?.binds).toEqual([null, null, 'EMP%']);
    });
  });

  it('devuelve las filas del diccionario con schema_name y table_name', async () => {
    const rows = [{ SCHEMA_NAME: DEVUSER, TABLE_NAME: 'EMPLOYEES' }];
    const dataAccess = new FakeDataAccess().always(() => ({ rows }));

    await withHarness({ dataAccess }, async (harness) => {
      expect(payload(await call(harness, 'list_tables', {}))).toEqual(rows);
    });
  });
});

describe('list_views', () => {
  it('filtra por owner y patrón sobre all_views', async () => {
    const rows = [{ SCHEMA_NAME: DEVUSER, VIEW_NAME: 'V_EMPLOYEE_DETAILS' }];
    const dataAccess = new FakeDataAccess().always(() => ({ rows }));

    await withHarness({ dataAccess }, async (harness) => {
      expect(payload(await call(harness, 'list_views', { namePattern: 'employee' }))).toEqual(rows);
      expect(dataAccess.calls[0]?.sql).toContain('FROM all_views');
      expect(dataAccess.calls[0]?.binds).toEqual([null, null, '%EMPLOYEE%']);
    });
  });
});

describe('describe_table', () => {
  const COLUMNS = [
    { COLUMN_NAME: 'EMP_ID', DATA_TYPE: 'NUMBER(10,0)', NULLABLE: 'N', COMMENTS: '' },
    { COLUMN_NAME: 'FIRST_NAME', DATA_TYPE: 'VARCHAR2(20)', NULLABLE: 'Y', COMMENTS: 'Nombre' },
  ];

  it('usa el schema del servidor cuando el cliente lo omite', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: COLUMNS }));

    await withHarness({ dataAccess, config: { schema: DEVUSER } }, async (harness) => {
      expect(payload(await call(harness, 'describe_table', { table: 'EMPLOYEES' }))).toEqual(
        COLUMNS,
      );
      expect(dataAccess.calls[0]?.sql).toContain('LEFT JOIN all_col_comments');
      expect(dataAccess.calls[0]?.sql).toContain('ORDER BY t.column_id');
      expect(dataAccess.calls[0]?.binds).toEqual([DEVUSER, 'EMPLOYEES']);
    });
  });

  it('falla con isError cuando no hay schema explícito ni configurado', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: COLUMNS }));

    await withHarness({ dataAccess, config: { schema: undefined } }, async (harness) => {
      const result = await call(harness, 'describe_table', { table: 'EMPLOYEES' });

      expect(result.isError).toBe(true);
      expect(text(result)).toContain('describe_table necesita un schema');
      expect(dataAccess.calls).toHaveLength(0);
    });
  });

  it('rechaza un identificador fuera de la allow-list sin tocar la base', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: COLUMNS }));

    await withHarness({ dataAccess, config: { schema: DEVUSER } }, async (harness) => {
      const result = await call(harness, 'describe_table', { table: 'EMPLOYEES; DROP TABLE X' });

      expect(result.isError).toBe(true);
      expect(text(result)).toContain('tabla inválido');
      expect(dataAccess.calls).toHaveLength(0);
    });
  });
});

describe('table_exists', () => {
  it('devuelve true cuando el conteo de all_tables es positivo', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: [{ CNT: 1 }] }));

    await withHarness({ dataAccess, config: { schema: DEVUSER } }, async (harness) => {
      expect(payload(await call(harness, 'table_exists', { table: 'EMPLOYEES' }))).toBe(true);
      expect(dataAccess.calls[0]?.sql).toContain('FROM all_tables');
      expect(dataAccess.calls[0]?.binds).toEqual([DEVUSER, 'EMPLOYEES']);
    });
  });

  it('devuelve false cuando la tabla no existe', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: [{ CNT: 0 }] }));

    await withHarness({ dataAccess, config: { schema: DEVUSER } }, async (harness) => {
      expect(payload(await call(harness, 'table_exists', { table: 'NO_SUCH_TABLE' }))).toBe(false);
    });
  });

  it('propaga el error de Oracle como resultado isError', async () => {
    const dataAccess = new FakeDataAccess().alwaysFail(
      new DataAccessError('ORA-00942: table or view does not exist'),
    );

    await withHarness({ dataAccess, config: { schema: DEVUSER } }, async (harness) => {
      const result = await call(harness, 'table_exists', { table: 'EMPLOYEES' });

      expect(result.isError).toBe(true);
      expect(text(result)).toContain('ORA-00942');
    });
  });
});

describe('search_objects', () => {
  it('busca por patrón y tipo sobre all_objects, sin filtro de schema', async () => {
    const rows = [{ SCHEMA_NAME: DEVUSER, OBJECT_NAME: 'EMPLOYEES', OBJECT_TYPE: 'TABLE' }];
    const dataAccess = new FakeDataAccess().always(() => ({ rows }));

    await withHarness({ dataAccess }, async (harness) => {
      expect(payload(await call(harness, 'search_objects', { namePattern: 'EMP%' }))).toEqual(rows);
      expect(dataAccess.calls[0]?.sql).toContain('FROM all_objects');
      expect(dataAccess.calls[0]?.binds).toEqual(['EMP%', null, null]);
    });
  });

  it('pasa el tipo de objeto como filtro opcional', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: [] }));

    await withHarness({ dataAccess }, async (harness) => {
      await call(harness, 'search_objects', { namePattern: '%order%', type: 'VIEW' });

      expect(dataAccess.calls[0]?.binds).toEqual(['%ORDER%', 'VIEW', 'VIEW']);
    });
  });

  it('rechaza un tipo de objeto mal formado', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: [] }));

    await withHarness({ dataAccess }, async (harness) => {
      const result = await call(harness, 'search_objects', {
        namePattern: 'X',
        type: 'VIEW) OR 1=1',
      });

      expect(result.isError).toBe(true);
      expect(dataAccess.calls).toHaveLength(0);
    });
  });
});

describe('list_objects', () => {
  it('deja ambos filtros en NULL cuando el cliente no los pasa', async () => {
    const rows = [
      { SCHEMA_NAME: DEVUSER, OBJECT_NAME: 'EMPLOYEES', OBJECT_TYPE: 'TABLE', STATUS: 'VALID' },
    ];
    const dataAccess = new FakeDataAccess().always(() => ({ rows }));

    await withHarness({ dataAccess }, async (harness) => {
      expect(payload(await call(harness, 'list_objects', {}))).toEqual(rows);
      expect(dataAccess.calls[0]?.sql).toContain('FROM all_objects');
      expect(dataAccess.calls[0]?.binds).toEqual([null, null, null, null]);
    });
  });

  it('filtra por schema y tipo cuando llegan', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: [] }));

    await withHarness({ dataAccess }, async (harness) => {
      await call(harness, 'list_objects', { schema: DEVUSER, type: 'PROCEDURE' });

      expect(dataAccess.calls[0]?.binds).toEqual([DEVUSER, DEVUSER, 'PROCEDURE', 'PROCEDURE']);
    });
  });
});

describe('get_ddl', () => {
  it('resuelve el objeto exacto en ALL_OBJECTS y pide el DDL con esos valores', async () => {
    const dataAccess = new FakeDataAccess()
      .on(
        (call) => call.sql.includes('FROM all_objects'),
        () => ({ rows: [{ OWNER: DEVUSER, OBJECT_NAME: 'EMPLOYEES', OBJECT_TYPE: 'TABLE' }] }),
      )
      .on(
        (call) => call.sql.includes('DBMS_METADATA.GET_DDL'),
        () => ({ rows: [{ DDL: '\n  CREATE TABLE "DEVUSER"."EMPLOYEES" ...\n' }] }),
      );

    await withHarness({ dataAccess, config: { schema: DEVUSER } }, async (harness) => {
      expect(payload(await call(harness, 'get_ddl', { name: 'employees', type: 'table' }))).toBe(
        '\n  CREATE TABLE "DEVUSER"."EMPLOYEES" ...\n',
      );

      const [resolve, getDdlCall] = dataAccess.calls;
      expect(resolve?.sql).toContain('UPPER(object_name) = UPPER(:name)');
      expect(resolve?.sql).toContain('FETCH FIRST 1 ROWS ONLY');
      expect(resolve?.binds).toEqual([DEVUSER, 'employees', 'table']);
      expect(getDdlCall?.binds).toEqual(['TABLE', 'EMPLOYEES', DEVUSER]);
    });
  });

  it('falla con el mensaje de objeto inexistente cuando ALL_OBJECTS no lo ve', async () => {
    const dataAccess = new FakeDataAccess().on(
      (call) => call.sql.includes('FROM all_objects'),
      () => ({ rows: [] }),
    );

    await withHarness({ dataAccess, config: { schema: DEVUSER } }, async (harness) => {
      const result = await call(harness, 'get_ddl', { name: 'NO_SUCH_TABLE', type: 'TABLE' });

      expect(result.isError).toBe(true);
      expect(text(result)).toContain('was not found in ALL_OBJECTS');
      expect(dataAccess.calls).toHaveLength(1);
    });
  });

  it('rechaza el nombre fuera de la allow-list antes de preguntar al diccionario', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: [] }));

    await withHarness({ dataAccess, config: { schema: DEVUSER } }, async (harness) => {
      const result = await call(harness, 'get_ddl', { name: 'EMP" || 1=1 --', type: 'TABLE' });

      expect(result.isError).toBe(true);
      expect(dataAccess.calls).toHaveLength(0);
    });
  });
});

describe('recursos MCP de schema', () => {
  const COLUMNS = [
    {
      COLUMN_NAME: 'EMP_ID',
      DATA_TYPE: 'NUMBER(10,0)',
      NULLABLE: 'N',
      DATA_DEFAULT: null,
      COMMENTS: '',
    },
    {
      COLUMN_NAME: 'FIRST_NAME',
      DATA_TYPE: 'VARCHAR2(20)',
      NULLABLE: 'Y',
      DATA_DEFAULT: null,
      COMMENTS: 'Nombre',
    },
  ];

  it('describe la tabla en texto plano con columnas, nulabilidad, default y comentarios', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: COLUMNS }));

    await withHarness({ dataAccess }, async (harness) => {
      const read = await harness.client.readResource({
        uri: 'oracle://schema/DEVUSER/table/EMPLOYEES',
      });

      expect(text(read)).toContain('Table: DEVUSER.EMPLOYEES');
      expect(text(read)).toContain('Column');
      expect(text(read)).toContain('EMP_ID');
      expect(text(read)).toContain('NOT NULL');
      expect(text(read)).toContain('FIRST_NAME');
      expect(text(read)).toContain('NULL');
      expect(text(read)).toContain('Nombre');
    });
  });

  it('avisa en el texto cuando la tabla no tiene columnas visibles', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: [] }));

    await withHarness({ dataAccess }, async (harness) => {
      const read = await harness.client.readResource({
        uri: 'oracle://schema/DEVUSER/table/GHOST',
      });

      expect(text(read)).toBe(
        '(No columns found for DEVUSER.GHOST — the object may not exist or is not accessible.)',
      );
    });
  });

  it('devuelve el DDL del objeto detectado en ALL_OBJECTS', async () => {
    const dataAccess = new FakeDataAccess()
      .on(
        (call) => call.sql.includes('FROM all_objects'),
        () => ({ rows: [{ OBJECT_TYPE: 'TABLE' }] }),
      )
      .on(
        (call) => call.sql.includes('DBMS_METADATA.GET_DDL'),
        () => ({ rows: [{ DDL: '\n  CREATE TABLE "DEVUSER"."EMPLOYEES"\n' }] }),
      );

    await withHarness({ dataAccess }, async (harness) => {
      const read = await harness.client.readResource({
        uri: 'oracle://schema/DEVUSER/object/EMPLOYEES/ddl',
      });

      expect(text(read)).toBe('CREATE TABLE "DEVUSER"."EMPLOYEES"');
      expect(dataAccess.calls[0]?.binds).toEqual([DEVUSER, 'EMPLOYEES']);
    });
  });

  it('avisa cuando el objeto no existe en el diccionario', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: [] }));

    await withHarness({ dataAccess }, async (harness) => {
      const read = await harness.client.readResource({
        uri: 'oracle://schema/DEVUSER/object/GHOST/ddl',
      });

      expect(text(read)).toBe('(Object not found: DEVUSER.GHOST)');
    });
  });

  it('reporta el error de base de datos dentro del contenido del recurso', async () => {
    const dataAccess = new FakeDataAccess().alwaysFail(
      new DataAccessError('ORA-31603: no such object'),
    );

    await withHarness({ dataAccess }, async (harness) => {
      const read = await harness.client.readResource({
        uri: 'oracle://schema/DEVUSER/table/EMPLOYEES',
      });

      expect(text(read)).toContain('(Database error describing DEVUSER.EMPLOYEES:');
      expect(text(read)).toContain('ORA-31603');
    });
  });

  it('publica los dos templates junto al de auditoría, sin pisarlo', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: COLUMNS }));

    await withHarness({ dataAccess }, async (harness) => {
      const { resourceTemplates } = await harness.client.listResourceTemplates();
      const uris = resourceTemplates.map((template) => template.uriTemplate);

      expect(uris).toContain('oracle://schema/{schema}/table/{table}');
      expect(uris).toContain('oracle://schema/{schema}/object/{object}/ddl');
      expect(uris).toContain('oracle://audit/session/{id}');
    });
  });
});
