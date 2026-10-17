import { describe, expect, it } from 'vitest';
import { FakeDataAccess } from '../../src/db/fake-data-access.js';
import { DataAccessError } from '../../src/errors.js';
import { createHarness, type Harness, type HarnessOptions } from '../helpers/harness.js';

/** El SDK tipa el content como unión de bloques; estas tools devuelven texto. */
interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

/** Plan renderizado por DBMS_XPLAN.DISPLAY (una sola fila, como en TYPICAL). */
const PLAN_TEXT = 'Plan Table\nOperation\n--------\nTABLE ACCESS FULL';

/** Fila de plan_table con full scan sobre EMPLOYEES filtrada por DEPT_ID y JOB_ID. */
const FULL_SCAN_ROW = {
  OBJECT_OWNER: 'DEVUSER',
  OBJECT_NAME: 'EMPLOYEES',
  OPERATION: 'TABLE ACCESS',
  OPTIONS: 'FULL',
  COST: 42,
  ACCESS_PREDICATES: null,
  FILTER_PREDICATES: '("DEPT_ID"=10 AND "JOB_ID"=20)',
};

/** Índices con los tres estados de likely_unused del CASE del Java. */
const INDEX_ROWS = [
  {
    INDEX_OWNER: 'DEVUSER',
    INDEX_NAME: 'IX_EMPLOYEES_DEPT',
    TABLE_OWNER: 'DEVUSER',
    TABLE_NAME: 'EMPLOYEES',
    COLUMNS: 'DEPT_ID',
    UNIQUENESS: 'NONUNIQUE',
    STATUS: 'VALID',
    LIKELY_UNUSED: 'YES',
  },
  { INDEX_OWNER: 'DEVUSER', INDEX_NAME: 'IX_EMP', LIKELY_UNUSED: 'NO' },
  { INDEX_OWNER: 'DEVUSER', INDEX_NAME: 'IX_JOBS', LIKELY_UNUSED: 'UNKNOWN' },
];

interface Backend {
  planRows?: Record<string, unknown>[];
  planText?: string;
  indexRows?: Record<string, unknown>[];
  colStats?: Record<string, unknown>[];
  tuningReport?: string;
  failOn?: RegExp;
  error?: Error;
}

/** FakeDataAccess con una regla por sentencia del Java, o un fallo puntual. */
function backend({
  planRows = [],
  planText = PLAN_TEXT,
  indexRows = INDEX_ROWS,
  colStats = [],
  tuningReport = 'SQL Tuning Report\n=================\nRECOMMENDATION: create index',
  failOn,
  error = new DataAccessError('ORA-00980: plan_table does not exist'),
}: Backend): FakeDataAccess {
  const data = new FakeDataAccess();
  const reply = (call: { sql: string }) => {
    if (failOn?.test(call.sql)) throw error;
    if (call.sql.includes('EXPLAIN PLAN SET STATEMENT_ID')) return { rowCount: 1 };
    if (call.sql.includes('DBMS_XPLAN.DISPLAY')) {
      return { rows: [{ PLAN_TABLE_OUTPUT: planText }] };
    }
    if (call.sql.includes('DELETE FROM plan_table')) return { rowCount: 1 };
    if (call.sql.includes('FROM plan_table')) return { rows: planRows };
    if (call.sql.includes('all_indexes')) return { rows: indexRows };
    if (call.sql.includes('all_tab_col_statistics')) return { rows: colStats };
    if (call.sql.includes('REPORT_TUNING_TASK')) return { rows: [{ REPORT: tuningReport }] };
    return {};
  };
  return data.always(reply);
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

function text(result: ToolResult): string {
  return result.content[0]?.text ?? '';
}

/** JSON del bloque de texto de un resultado correcto. */
function payload(result: ToolResult): Record<string, unknown> {
  expect(result.isError).toBeFalsy();
  return JSON.parse(text(result)) as Record<string, unknown>;
}

describe('tools/list · grupo Explain', () => {
  it('publica las cuatro tools con los parámetros del Java', async () => {
    await withHarness({}, async (harness) => {
      const { tools } = await harness.client.listTools();
      const names = tools.map((tool) => tool.name);

      expect(names).toEqual(
        expect.arrayContaining([
          'explain_plan',
          'suggest_index',
          'list_unused_indexes',
          'run_sql_tuning_advisor',
        ]),
      );

      const explain = tools.find((tool) => tool.name === 'explain_plan');
      expect(explain?.inputSchema.required).toEqual(['sql']);
      expect(explain?.description).toContain('without executing the statement');

      const suggest = tools.find((tool) => tool.name === 'suggest_index');
      expect(suggest?.inputSchema.required).toEqual(['sql']);

      const unused = tools.find((tool) => tool.name === 'list_unused_indexes');
      expect(unused?.inputSchema.required).toBeUndefined();
      expect(unused?.description).toContain('likely_unused');

      const tuning = tools.find((tool) => tool.name === 'run_sql_tuning_advisor');
      expect(tuning?.inputSchema.required).toEqual(['sql']);
    });
  });
});

describe('explain_plan', () => {
  it('describe el SQL sin ejecutarlo y lo manda como bind, no concatenado', async () => {
    const dataAccess = backend({});

    await withHarness({ dataAccess }, async (harness) => {
      const result = await call(harness, 'explain_plan', { sql: 'SELECT * FROM EMPLOYEES' });

      expect(result.isError).toBeFalsy();
      expect(text(result)).toBe(PLAN_TEXT);

      const explainCall = dataAccess.calls.find((c) =>
        c.sql.includes('EXPLAIN PLAN SET STATEMENT_ID'),
      );
      expect(explainCall?.method).toBe('execute');
      expect(explainCall?.sql).not.toContain('SELECT * FROM EMPLOYEES');
      expect(explainCall?.binds?.[1]).toBe('SELECT * FROM EMPLOYEES');

      const display = dataAccess.calls.find((c) => c.sql.includes('DBMS_XPLAN.DISPLAY'));
      expect(display?.binds?.[0]).toMatch(/^mcp_/);

      const cleanup = dataAccess.calls.find((c) => c.sql.includes('DELETE FROM plan_table'));
      expect(cleanup?.binds?.[0]).toBe(display?.binds?.[0]);
    });
  });

  it('usa un statement_id distinto por llamada para no chocar en el PLAN_TABLE', async () => {
    const dataAccess = backend({});

    await withHarness({ dataAccess }, async (harness) => {
      await call(harness, 'explain_plan', { sql: 'SELECT 1 FROM DUAL' });
      await call(harness, 'explain_plan', { sql: 'SELECT 1 FROM DUAL' });

      const ids = dataAccess.calls
        .filter((c) => c.sql.includes('DBMS_XPLAN.DISPLAY'))
        .map((c) => c.binds?.[0]);

      expect(ids).toHaveLength(2);
      expect(ids[0]).not.toBe(ids[1]);
    });
  });

  it('notifica progreso 10 y 90 cuando el cliente pasó token', async () => {
    const progress: number[] = [];

    await withHarness({ dataAccess: backend({}) }, async (harness) => {
      await harness.client.callTool(
        { name: 'explain_plan', arguments: { sql: 'SELECT 1 FROM DUAL' } },
        undefined,
        { onprogress: (update) => progress.push(update.progress) },
      );
    });

    expect(progress).toEqual([10, 90]);
  });

  it('falla con instrucción clara cuando falta el PLAN_TABLE', async () => {
    const dataAccess = backend({
      failOn: /EXPLAIN PLAN SET STATEMENT_ID/,
      error: new DataAccessError('ORA-00980: plan_table does not exist', 'ORA-00980'),
    });

    await withHarness({ dataAccess }, async (harness) => {
      const result = await call(harness, 'explain_plan', { sql: 'SELECT * FROM EMPLOYEES' });

      expect(result.isError).toBe(true);
      expect(text(result)).toContain('PLAN_TABLE');
      expect(text(result)).toContain('GRANT SELECT, INSERT, DELETE ON SYS.PLAN_TABLE$');
    });
  });

  it('falla igual si el usuario no tiene privilegio sobre el PLAN_TABLE', async () => {
    const dataAccess = backend({
      failOn: /EXPLAIN PLAN SET STATEMENT_ID/,
      error: new DataAccessError('ORA-01031: insufficient privileges', 'ORA-01031'),
    });

    await withHarness({ dataAccess }, async (harness) => {
      const result = await call(harness, 'explain_plan', { sql: 'SELECT * FROM EMPLOYEES' });

      expect(result.isError).toBe(true);
      expect(text(result)).toContain('PLAN_TABLE');
    });
  });
});

describe('suggest_index', () => {
  const colStats = [
    { COLUMN_NAME: 'DEPT_ID', NUM_DISTINCT: 4 },
    { COLUMN_NAME: 'JOB_ID', NUM_DISTINCT: 50 },
    { COLUMN_NAME: 'EMP_ID', NUM_DISTINCT: 4 },
  ];

  it('propone el CREATE INDEX sobre el full scan, ordenado por num_distinct', async () => {
    const dataAccess = backend({ planRows: [FULL_SCAN_ROW], colStats });

    await withHarness({ dataAccess }, async (harness) => {
      const result = payload(
        await call(harness, 'suggest_index', { sql: 'SELECT * FROM EMPLOYEES WHERE dept_id = 10' }),
      );

      expect(result).toMatchObject({
        hasCandidates: true,
        schema: 'DEVUSER',
        table: 'EMPLOYEES',
        accessProblem: 'TABLE ACCESS FULL',
        predicateColumns: ['DEPT_ID', 'JOB_ID'],
        recommendedColumns: ['JOB_ID', 'DEPT_ID'],
        recommendedDdl:
          'CREATE INDEX "DEVUSER"."IX_EMPLOYEES_JOB_ID_DEPT_ID" ON "DEVUSER"."EMPLOYEES" ("JOB_ID", "DEPT_ID")',
      });
      expect(result.reasoning).toContain('num_distinct=50');
    });
  });

  it('acota el índice a dos columnas, aunque el plan exponga más', async () => {
    const dataAccess = backend({
      planRows: [
        {
          ...FULL_SCAN_ROW,
          FILTER_PREDICATES: '("DEPT_ID"=10 AND "JOB_ID"=20 AND "EMP_ID"=1)',
        },
      ],
      colStats,
    });

    await withHarness({ dataAccess }, async (harness) => {
      const result = payload(await call(harness, 'suggest_index', { sql: 'SELECT 1 FROM DUAL' }));

      expect(result.recommendedColumns).toEqual(['JOB_ID', 'DEPT_ID']);
      expect(result.predicateColumns).toEqual(['DEPT_ID', 'JOB_ID', 'EMP_ID']);
    });
  });

  it('avisa cuando hay full scan pero el plan no expone predicados', async () => {
    const dataAccess = backend({
      planRows: [{ ...FULL_SCAN_ROW, FILTER_PREDICATES: null }],
      colStats,
    });

    await withHarness({ dataAccess }, async (harness) => {
      const result = payload(await call(harness, 'suggest_index', { sql: 'SELECT 1 FROM DUAL' }));

      expect(result.hasCandidates).toBe(true);
      expect(result.recommendedDdl).toBeNull();
      expect(result.reasoning).toContain('no filter/join predicate columns');
    });
  });

  it('devuelve hasCandidates=false cuando el plan ya usa índices', async () => {
    const dataAccess = backend({
      planRows: [{ ...FULL_SCAN_ROW, OPTIONS: 'BY INDEX RANGE SCAN' }],
      colStats,
    });

    await withHarness({ dataAccess }, async (harness) => {
      const result = payload(await call(harness, 'suggest_index', { sql: 'SELECT 1 FROM DUAL' }));

      expect(result).toEqual({
        hasCandidates: false,
        schema: null,
        table: null,
        accessProblem: null,
        predicateColumns: [],
        recommendedColumns: [],
        recommendedDdl: null,
        reasoning: 'No TABLE ACCESS FULL operations found; the query already uses indexes.',
      });
    });
  });

  it('filtra por la tabla pedida cuando el plan escanea varias', async () => {
    const dataAccess = backend({
      planRows: [
        { ...FULL_SCAN_ROW, OBJECT_NAME: 'JOBS', COST: 900 },
        { ...FULL_SCAN_ROW, OBJECT_NAME: 'EMPLOYEES', COST: 5 },
      ],
      colStats,
    });

    await withHarness({ dataAccess }, async (harness) => {
      const result = payload(
        await call(harness, 'suggest_index', {
          sql: 'SELECT * FROM EMPLOYEES',
          targetTable: 'employees',
        }),
      );

      expect(result.table).toBe('EMPLOYEES');
    });
  });

  it('elige el full scan de mayor coste cuando no se indica tabla', async () => {
    const dataAccess = backend({
      planRows: [
        { ...FULL_SCAN_ROW, OBJECT_NAME: 'JOBS', COST: 900 },
        { ...FULL_SCAN_ROW, OBJECT_NAME: 'EMPLOYEES', COST: 5 },
      ],
      colStats,
    });

    await withHarness({ dataAccess }, async (harness) => {
      const result = payload(await call(harness, 'suggest_index', { sql: 'SELECT 1 FROM DUAL' }));

      expect(result.table).toBe('JOBS');
    });
  });

  it('trunca el nombre del índice al límite de 128 de Oracle con un sufijo hash', async () => {
    const dataAccess = backend({
      planRows: [{ ...FULL_SCAN_ROW, OBJECT_NAME: 'A'.repeat(120) }],
      colStats,
    });

    await withHarness({ dataAccess }, async (harness) => {
      const ddl = String(
        payload(await call(harness, 'suggest_index', { sql: 'SELECT 1 FROM DUAL' })).recommendedDdl,
      );
      const indexName = /CREATE INDEX "DEVUSER"\."([^"]+)"/.exec(ddl)?.[1] ?? '';

      expect(indexName).toHaveLength(128);
      expect(indexName).toMatch(/_[0-9a-f]+$/);
    });
  });

  it('rechaza un SQL que ya viene con EXPLAIN PLAN', async () => {
    await withHarness({ dataAccess: backend({}) }, async (harness) => {
      const result = await call(harness, 'suggest_index', {
        sql: 'EXPLAIN PLAN FOR SELECT 1 FROM DUAL',
      });

      expect(result.isError).toBe(true);
      expect(text(result)).toContain('runs its own EXPLAIN PLAN internally');
    });
  });
});

describe('list_unused_indexes', () => {
  it('filtra por el schema resuelto y devuelve el flag likely_unused de Oracle', async () => {
    const dataAccess = backend({});

    await withHarness({ dataAccess, config: { schema: 'DEVUSER' } }, async (harness) => {
      const result = await call(harness, 'list_unused_indexes', {});
      const rows = JSON.parse(text(result)) as Array<Record<string, unknown>>;

      expect(result.isError).toBeFalsy();
      expect(rows.map((row) => row.LIKELY_UNUSED)).toEqual(['YES', 'NO', 'UNKNOWN']);

      const query = dataAccess.calls.find((c) => c.sql.includes('all_indexes'));
      expect(query?.binds).toEqual(['DEVUSER']);
    });
  });

  it('usa el schema explícito cuando viene en los argumentos', async () => {
    const dataAccess = backend({});

    await withHarness({ dataAccess, config: { schema: 'DEVUSER' } }, async (harness) => {
      await call(harness, 'list_unused_indexes', { schema: 'HR' });

      expect(dataAccess.calls.find((c) => c.sql.includes('all_indexes'))?.binds).toEqual(['HR']);
    });
  });

  it('avisa en una nota cuando V$OBJECT_USAGE no es accesible', async () => {
    const dataAccess = backend({
      failOn: /all_indexes/,
      error: new DataAccessError('ORA-00942: table or view does not exist', 'ORA-00942'),
    });

    await withHarness({ dataAccess }, async (harness) => {
      const result = await call(harness, 'list_unused_indexes', { schema: 'DEVUSER' });

      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('SYS.V_$OBJECT_USAGE');
    });
  });
});

describe('run_sql_tuning_advisor', () => {
  it('devuelve el reporte TEXT y borra la task', async () => {
    const dataAccess = backend({});

    await withHarness({ dataAccess }, async (harness) => {
      const result = await call(harness, 'run_sql_tuning_advisor', {
        sql: 'SELECT * FROM EMPLOYEES',
      });

      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('SQL Tuning Report');

      const create = dataAccess.calls.find((c) => c.sql.includes('CREATE_TUNING_TASK'));
      expect(create?.binds).toEqual([
        'SELECT * FROM EMPLOYEES',
        expect.stringMatching(/^mcp_sta_/),
      ]);

      expect(
        dataAccess.calls.some(
          (c) => c.sql.includes('EXECUTE_TUNING_TASK') && c.method === 'execute',
        ),
      ).toBe(true);
      expect(
        dataAccess.calls.some((c) => c.sql.includes('DROP_TUNING_TASK') && c.method === 'execute'),
      ).toBe(true);
    });
  });

  it('falla con la guía de privilegio cuando el usuario no tiene ADVISOR', async () => {
    const dataAccess = backend({
      failOn: /CREATE_TUNING_TASK/,
      error: new DataAccessError('ORA-01031: insufficient privileges', 'ORA-01031'),
    });

    await withHarness({ dataAccess }, async (harness) => {
      const result = await call(harness, 'run_sql_tuning_advisor', {
        sql: 'SELECT * FROM EMPLOYEES',
      });

      expect(result.isError).toBe(true);
      expect(text(result)).toContain('GRANT ADVISOR TO <mcp_user>');
    });
  });

  it('notifica progreso 10 y 90 cuando el cliente pasó token', async () => {
    const progress: number[] = [];

    await withHarness({ dataAccess: backend({}) }, async (harness) => {
      await harness.client.callTool(
        { name: 'run_sql_tuning_advisor', arguments: { sql: 'SELECT 1 FROM DUAL' } },
        undefined,
        { onprogress: (update) => progress.push(update.progress) },
      );
    });

    expect(progress).toEqual([10, 90]);
  });
});
