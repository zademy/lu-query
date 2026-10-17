import { describe, expect, it } from 'vitest';
import { FakeDataAccess } from '../../src/db/fake-data-access.js';
import { DataAccessError } from '../../src/errors.js';
import { createHarness, type Harness, type HarnessOptions } from '../helpers/harness.js';

/** El SDK tipa el content como unión de bloques; estas tools devuelven texto. */
interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

/** Fila de EMPLOYEES tal como la devuelve Oracle (alias en mayúsculas). */
const EMPLOYEE = { EMPLOYEE_ID: 100, FIRST_NAME: 'Steven', SALARY: 24000 };

function employees(rows: Record<string, unknown>[]): FakeDataAccess {
  return new FakeDataAccess().always(() => ({ rows }));
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
function payload(result: ToolResult): Record<string, unknown> {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]?.text ?? '') as Record<string, unknown>;
}

describe('tools/list · grupo Query', () => {
  it('publica run_query y get_sample_data con los parámetros del Java', async () => {
    await withHarness({}, async (harness) => {
      const { tools } = await harness.client.listTools();
      const runQuery = tools.find((tool) => tool.name === 'run_query');
      const sample = tools.find((tool) => tool.name === 'get_sample_data');

      expect(runQuery?.description).toContain('Run a single SELECT statement');
      expect(runQuery?.inputSchema).toMatchObject({
        type: 'object',
        required: ['sql'],
        properties: { sql: {}, offset: {}, limit: {} },
      });
      expect(sample?.description).toBe(
        'Return the first N rows of a table as a quick data preview.',
      );
      expect(sample?.inputSchema).toMatchObject({ required: ['table'] });
    });
  });
});

describe('run_query', () => {
  it('devuelve el QueryResult con columnas, filas, conteo y tope global', async () => {
    const dataAccess = employees([EMPLOYEE]);

    await withHarness({ dataAccess }, async (harness) => {
      expect(payload(await call(harness, 'run_query', { sql: 'SELECT * FROM employees' }))).toEqual(
        {
          columns: ['EMPLOYEE_ID', 'FIRST_NAME', 'SALARY'],
          rows: [EMPLOYEE],
          rowCount: 1,
          truncated: false,
          rowLimit: 1000,
          offset: 0,
          limit: 1000,
        },
      );
    });
  });

  it('manda el SQL verbatim al chokepoint DataAccess cuando no pagina', async () => {
    const dataAccess = employees([]);

    await withHarness({ dataAccess }, async (harness) => {
      await call(harness, 'run_query', { sql: "SELECT job_id FROM employees WHERE job_id = 'IT'" });
    });

    expect(dataAccess.calls[0]?.sql).toBe(
      "SELECT * FROM ( SELECT job_id FROM employees WHERE job_id = 'IT' ) WHERE ROWNUM <= 1000",
    );
  });

  it('envuelve en OFFSET/FETCH la página pedida (base 0)', async () => {
    const dataAccess = employees([EMPLOYEE, { ...EMPLOYEE, EMPLOYEE_ID: 101 }]);

    await withHarness({ dataAccess }, async (harness) => {
      const result = await call(harness, 'run_query', {
        sql: 'SELECT * FROM employees ORDER BY employee_id',
        offset: 20,
        limit: 2,
      });

      expect(dataAccess.calls[0]?.sql).toBe(
        'SELECT * FROM ( SELECT * FROM employees ORDER BY employee_id ) OFFSET 20 ROWS FETCH NEXT 2 ROWS ONLY',
      );
      expect(payload(result)).toMatchObject({ rowCount: 2, offset: 20, limit: 2, truncated: true });
    });
  });

  it('marca truncated cuando la página viene llena y lo quita cuando no', async () => {
    const full = payload(
      await withHarness(
        { dataAccess: employees([EMPLOYEE, { ...EMPLOYEE, EMPLOYEE_ID: 101 }]) },
        (harness) => call(harness, 'run_query', { sql: 'SELECT * FROM employees', limit: 2 }),
      ),
    );
    const short = payload(
      await withHarness({ dataAccess: employees([EMPLOYEE]) }, (harness) =>
        call(harness, 'run_query', { sql: 'SELECT * FROM employees', limit: 2 }),
      ),
    );

    expect(full.truncated).toBe(true);
    expect(short.truncated).toBe(false);
  });

  it('capa limit a max-rows y deja el offset negativo en 0', async () => {
    const dataAccess = employees([]);

    await withHarness({ dataAccess }, async (harness) => {
      const result = await call(harness, 'run_query', {
        sql: 'SELECT * FROM employees',
        offset: -3,
        limit: 5000,
      });

      expect(dataAccess.calls[0]?.sql).toBe(
        'SELECT * FROM ( SELECT * FROM employees ) WHERE ROWNUM <= 1000',
      );
      expect(payload(result)).toMatchObject({ offset: 0, limit: 1000, rowLimit: 1000 });
    });
  });

  it('devuelve isError (no excepción) ante un SQL que no es SELECT', async () => {
    await withHarness({ dataAccess: employees([]) }, async (harness) => {
      const result = await call(harness, 'run_query', { sql: 'DELETE FROM employees' });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('SELECT');
      expect(harness.dataAccess.calls).toHaveLength(0);
    });
  });

  it('acepta un SELECT con CTE', async () => {
    const dataAccess = employees([EMPLOYEE]);

    await withHarness({ dataAccess }, async (harness) => {
      const result = await call(harness, 'run_query', {
        sql: 'WITH recent AS (SELECT * FROM employees) SELECT * FROM recent',
      });

      expect(result.isError).toBeFalsy();
      expect(payload(result).rowCount).toBe(1);
    });
  });

  it('traduce un ORA-01031 de Oracle a isError con su causa probable', async () => {
    const dataAccess = new FakeDataAccess().alwaysFail(
      new DataAccessError('ORA-01031: insufficient privileges', 'ORA-01031'),
    );

    await withHarness({ dataAccess }, async (harness) => {
      const result = await call(harness, 'run_query', { sql: 'SELECT * FROM hr.salaries' });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('ORA-01031');
      expect(result.content[0]?.text).toContain('least-privilege user has no DDL/DCL privileges');
    });
  });

  it('trata una interrupción ORA-03114 como cancelación y no como fallo de la BD', async () => {
    const dataAccess = new FakeDataAccess().alwaysFail(
      new DataAccessError('ORA-03114: communication with the server is lost', 'ORA-03114'),
    );

    await withHarness({ dataAccess }, async (harness) => {
      const result = await call(harness, 'run_query', { sql: 'SELECT * FROM employees' });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('cancelled by the client');
      expect(result.content[0]?.text).not.toContain('Oracle error:');
    });
  });
});

describe('get_sample_data', () => {
  it('trae 10 filas por defecto de la tabla del schema por defecto', async () => {
    const dataAccess = employees([EMPLOYEE]);

    await withHarness({ dataAccess }, async (harness) => {
      const result = await call(harness, 'get_sample_data', { table: 'EMPLOYEES' });

      expect(dataAccess.calls[0]?.sql).toBe('SELECT * FROM "EMPLOYEES" FETCH FIRST 10 ROWS ONLY');
      expect(payload(result)).toMatchObject({
        columns: ['EMPLOYEE_ID', 'FIRST_NAME', 'SALARY'],
        rows: [EMPLOYEE],
        rowCount: 1,
        offset: 0,
        limit: 10,
        rowLimit: 1000,
      });
    });
  });

  it('qualifica con el schema pedido y respeta el número de filas', async () => {
    const dataAccess = employees([]);

    await withHarness({ dataAccess }, async (harness) => {
      await call(harness, 'get_sample_data', { schema: 'HR', table: 'EMPLOYEES', rows: 3 });
    });

    expect(dataAccess.calls[0]?.sql).toBe('SELECT * FROM "HR"."EMPLOYEES" FETCH FIRST 3 ROWS ONLY');
  });

  it('rechaza un identificador fuera de la allow-list sin tocar la base de datos', async () => {
    await withHarness({ dataAccess: employees([]) }, async (harness) => {
      const result = await call(harness, 'get_sample_data', {
        table: 'EMPLOYEES"; DROP TABLE HR --',
      });

      expect(result.isError).toBe(true);
      expect(harness.dataAccess.calls).toHaveLength(0);
    });
  });

  it('notifica el progreso 10 → 90 al cliente que lo pidió', async () => {
    const progress: number[] = [];

    await withHarness({ dataAccess: employees([EMPLOYEE]) }, async (harness) => {
      await harness.client.callTool(
        { name: 'get_sample_data', arguments: { table: 'EMPLOYEES' } },
        undefined,
        { onprogress: (update) => progress.push(update.progress) },
      );
    });

    expect(progress).toEqual([10, 90]);
  });

  it('no notifica progreso cuando el cliente no pidió token', async () => {
    const dataAccess = employees([EMPLOYEE]);

    await withHarness({ dataAccess }, async (harness) => {
      const result = await call(harness, 'get_sample_data', { table: 'EMPLOYEES' });

      expect(result.isError).toBeFalsy();
      expect(dataAccess.calls).toHaveLength(1);
    });
  });
});
