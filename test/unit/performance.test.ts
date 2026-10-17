import { describe, expect, it } from 'vitest';
import { FakeDataAccess } from '../../src/db/fake-data-access.js';
import { DataAccessError } from '../../src/errors.js';
import { createHarness, type Harness } from '../helpers/harness.js';

/** El SDK tipa el content como unión de bloques; estas tools devuelven texto. */
interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

/** Fila tal como la devuelve Oracle (alias en mayúsculas). */
const ROW = { SID: 42, USERNAME: 'DEVUSER' };

const PERFORMANCE_TOOLS = [
  'list_active_sessions',
  'list_blocked_sessions',
  'list_locks',
  'get_session_sql_text',
  'list_top_sql',
  'get_wait_events',
  'get_session_longops',
  'get_instance_info',
  'get_database_info',
  'get_system_stats',
  'get_db_time_model',
  'get_parameter',
  'list_datafile_io',
];

async function withHarness(
  dataAccess: FakeDataAccess,
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  const harness = await createHarness({ dataAccess });
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

async function call(harness: Harness, name: string, args: Record<string, unknown> = {}) {
  return (await harness.client.callTool({ name, arguments: args })) as ToolResult;
}

async function textOf(harness: Harness, name: string, args: Record<string, unknown> = {}) {
  const result = await call(harness, name, args);
  expect(result.isError).toBeFalsy();
  return result.content[0]?.text ?? '';
}

/** Devuelve filas fijas y deja la llamada registrada para poder assertar los binds. */
function rows(row: Record<string, unknown> = ROW): FakeDataAccess {
  return new FakeDataAccess().always(() => ({ rows: [row] }));
}

describe('performance — catálogo de tools', () => {
  it('expone las trece tools de performance', async () => {
    const harness = await createHarness();

    try {
      const { tools } = await harness.client.listTools();
      const names = tools.map((tool) => tool.name);

      expect(names).toEqual(expect.arrayContaining(PERFORMANCE_TOOLS));
    } finally {
      await harness.close();
    }
  });
});

describe('performance — consultas sobre V$', () => {
  it('list_active_sessions liga el filtro de username una vez por cada aparición', async () => {
    const dataAccess = rows();

    await withHarness(dataAccess, async (harness) => {
      await textOf(harness, 'list_active_sessions', { username: 'DEVUSER' });
    });

    expect(sql(dataAccess)).toContain('v$session');
    expect(sql(dataAccess)).toContain("status = 'ACTIVE'");
    expect(binds(dataAccess)).toEqual(['DEVUSER', 'DEVUSER', null, null]);
  });

  it('list_active_sessions liga el filtro de sid y ambos filtros juntos', async () => {
    const dataAccess = rows();

    await withHarness(dataAccess, async (harness) => {
      await textOf(harness, 'list_active_sessions', { sid: 7 });
      await textOf(harness, 'list_active_sessions', { username: 'DEVUSER', sid: 7 });
    });

    expect(binds(dataAccess, 0)).toEqual([null, null, 7, 7]);
    expect(binds(dataAccess, 1)).toEqual(['DEVUSER', 'DEVUSER', 7, 7]);
  });

  it('devuelve las filas de la vista tal cual', async () => {
    await withHarness(rows(), async (harness) => {
      expect(JSON.parse(await textOf(harness, 'list_blocked_sessions'))).toEqual([ROW]);
    });
  });

  it('las tools sin filtros no mandan binds', async () => {
    const dataAccess = rows();

    await withHarness(dataAccess, async (harness) => {
      await textOf(harness, 'list_blocked_sessions');
      await textOf(harness, 'list_locks');
      await textOf(harness, 'list_datafile_io');
      await textOf(harness, 'get_system_stats');
      await textOf(harness, 'get_db_time_model');
    });

    expect(sql(dataAccess, 0)).toContain('v$session');
    expect(sql(dataAccess, 1)).toContain('v$lock');
    expect(sql(dataAccess, 2)).toContain('v$filestat');
    expect(sql(dataAccess, 3)).toContain('v$sysstat');
    expect(sql(dataAccess, 4)).toContain('v$sys_time_model');
    expect(dataAccess.calls.every((call) => call.binds === undefined)).toBe(true);
  });

  it('get_wait_events y get_session_longops ligan null cuando no hay filtro', async () => {
    const dataAccess = rows();

    await withHarness(dataAccess, async (harness) => {
      await textOf(harness, 'get_wait_events', { waitClass: 'User I/O' });
      await textOf(harness, 'get_session_longops');
    });

    expect(binds(dataAccess, 0)).toEqual([null, null, 'User I/O', 'User I/O']);
    expect(binds(dataAccess, 1)).toEqual([null, null]);
  });

  it('list_top_sql ordena por elapsed_time y trae diez filas si no se pide otra cosa', async () => {
    const dataAccess = rows();

    await withHarness(dataAccess, async (harness) => {
      await textOf(harness, 'list_top_sql');
      await textOf(harness, 'list_top_sql', { orderBy: 'buffer_gets', limit: 3 });
    });

    expect(binds(dataAccess, 0)).toEqual(['elapsed_time', 10]);
    expect(binds(dataAccess, 1)).toEqual(['buffer_gets', 3]);
  });

  it('get_session_sql_text une las piezas en orden con salto de línea', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({
      rows: [{ SQL_TEXT: 'SELECT 1' }, { SQL_TEXT: 'FROM dual' }],
    }));

    await withHarness(dataAccess, async (harness) => {
      expect(JSON.parse(await textOf(harness, 'get_session_sql_text', { sid: 7, serialNum: 9 }))).toBe(
        'SELECT 1\nFROM dual',
      );
    });

    expect(binds(dataAccess)).toEqual([7, 9]);
  });

  it('get_session_sql_text devuelve cadena vacía si la sesión no tiene SQL en curso', async () => {
    await withHarness(rows(), async (harness) => {
      expect(JSON.parse(await textOf(harness, 'get_session_sql_text', { sid: 7, serialNum: 9 }))).toBe(
        '',
      );
    });
  });

  it('get_instance_info y get_database_info devuelven el objeto de la única fila', async () => {
    const info = { INSTANCE_NAME: 'FREE', HOST_NAME: 'oracle-db' };
    const dataAccess = new FakeDataAccess().always(() => ({ rows: [info] }));

    await withHarness(dataAccess, async (harness) => {
      expect(JSON.parse(await textOf(harness, 'get_instance_info'))).toEqual(info);
      expect(JSON.parse(await textOf(harness, 'get_database_info'))).toEqual(info);
    });

    expect(dataAccess.calls.every((call) => call.method === 'queryForObject')).toBe(true);
  });

  it('get_instance_info devuelve objeto vacío si la vista no trae fila', async () => {
    await withHarness(new FakeDataAccess(), async (harness) => {
      expect(JSON.parse(await textOf(harness, 'get_instance_info'))).toEqual({});
    });
  });

  it('get_parameter traduce el nombre a patrón LIKE en mayúsculas', async () => {
    const dataAccess = rows();

    await withHarness(dataAccess, async (harness) => {
      await textOf(harness, 'get_parameter');
      await textOf(harness, 'get_parameter', { name: 'sga' });
      await textOf(harness, 'get_parameter', { name: 'SGA%' });
    });

    expect(binds(dataAccess, 0)).toEqual(['%']);
    expect(binds(dataAccess, 1)).toEqual(['%SGA%']);
    expect(binds(dataAccess, 2)).toEqual(['SGA%']);
    expect(sql(dataAccess, 0)).toContain('v$parameter');
  });
});

describe('performance — sin privilegio de catálogo', () => {
  it('responde isError con el hint del grant que falta en ORA-00942 y ORA-01031', async () => {
    for (const code of ['ORA-00942', 'ORA-01031']) {
      const dataAccess = new FakeDataAccess().alwaysFail(
        new DataAccessError(`${code}: table or view does not exist`, code),
      );

      await withHarness(dataAccess, async (harness) => {
        const result = await call(harness, 'list_locks');

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain('SELECT ANY DICTIONARY');
        expect(result.content[0]?.text).toContain('scripts/test-grants-performance.sql');
      });
    }
  });

  it('otros errores siguen siendo isError pero sin el hint del grant', async () => {
    const dataAccess = new FakeDataAccess().alwaysFail(
      new DataAccessError('ORA-00904: "L"."IDL_OBJ_ID": invalid identifier', 'ORA-00904'),
    );

    await withHarness(dataAccess, async (harness) => {
      const result = await call(harness, 'list_locks');

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).not.toContain('SELECT ANY DICTIONARY');
    });
  });
});

/** SQL de la llamada n-ésima (0 por defecto). */
function sql(dataAccess: FakeDataAccess, index = 0): string {
  return dataAccess.calls[index]?.sql ?? '';
}

/** Binds de la llamada n-ésima (0 por defecto). */
function binds(dataAccess: FakeDataAccess, index = 0): unknown[] | undefined {
  return dataAccess.calls[index]?.binds;
}
