import { describe, expect, it } from 'vitest';
import { FakeDataAccess } from '../../src/db/fake-data-access.js';
import { createHarness, type Harness } from '../helpers/harness.js';

/** El SDK tipa el content como unión de bloques; estas tools devuelven texto. */
interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

/** Fake que responde al COUNT del preview con `total` y al SELECT con `rows`. */
function previewFake(total: number, rows: Record<string, unknown>[]): FakeDataAccess {
  return new FakeDataAccess()
    .on(
      (call) => call.sql.includes('COUNT(*)'),
      () => ({ rows: [{ 'COUNT(*)': total }] }),
    )
    .on(
      (call) => call.sql.startsWith('SELECT * FROM ( SELECT * FROM'),
      () => ({ rows }),
    );
}

async function call(harness: Harness, name: string, args: Record<string, unknown>) {
  return (await harness.client.callTool({ name, arguments: args })) as ToolResult;
}

async function withHarness<T>(
  dataAccess: FakeDataAccess,
  run: (harness: Harness) => Promise<T>,
): Promise<T> {
  const harness = await createHarness({ dataAccess });
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

describe('tools/list · grupo Dml', () => {
  it('publica las tres tools DML con las descripciones del Java', async () => {
    const harness = await createHarness({ dataAccess: new FakeDataAccess() });
    try {
      const { tools } = await harness.client.listTools();
      const names = ['execute_dml', 'execute_dml_preview', 'execute_dml_rollback_first'].map(
        (name) => tools.find((tool) => tool.name === name),
      );

      expect(names[0]?.description).toBe(
        'Execute a single INSERT, UPDATE, DELETE or MERGE statement on existing tables and auto-commit it (no explicit COMMIT needed; there is no cross-call transaction boundary). One statement per call. Returns the number of rows affected; if the Oracle user lacks the required privileges the failure surfaces as an error result (isError=true).',
      );
      expect(names[1]?.description).toBe(
        'Dry-run an UPDATE or DELETE without executing it. Returns the total number of rows that would be affected plus a sample of those rows. INSERT and MERGE are not supported; use execute_dml_rollback_first for those.',
      );
      expect(names[2]?.description).toBe(
        'Execute an INSERT, UPDATE, DELETE or MERGE inside a transaction that is immediately rolled back. Nothing is persisted; the tool only proves the statement is valid and reports the number of rows affected. Call execute_dml afterwards to apply the change for real.',
      );
      for (const tool of names) {
        expect(tool?.inputSchema).toMatchObject({ type: 'object', required: ['sql'] });
      }
    } finally {
      await harness.close();
    }
  });
});

describe('execute_dml', () => {
  it('ejecuta por el chokepoint con commit y devuelve kind y filas', async () => {
    const dataAccess = new FakeDataAccess().on(
      (c) => c.method === 'executeInTransaction',
      () => ({ rowCount: 3 }),
    );

    await withHarness(dataAccess, async (harness) => {
      expect(payload(await call(harness, 'execute_dml', { sql: 'UPDATE nope SET a = 1' }))).toEqual({
        statementKind: 'UPDATE',
        rowsAffected: 3,
      });
    });

    expect(dataAccess.calls).toEqual([
      { method: 'executeInTransaction', sql: 'UPDATE nope SET a = 1', outcome: 'commit' },
    ]);
  });

  it('propaga el fallo de la transaccion como resultado isError', async () => {
    const dataAccess = new FakeDataAccess().on(
      (c) => c.method === 'executeInTransaction',
      () => new Error('ORA-00942: table or view does not exist'),
    );

    await withHarness(dataAccess, async (harness) => {
      const result = await call(harness, 'execute_dml', { sql: 'UPDATE nope SET a = 1' });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('ORA-00942');
    });
  });
});

describe('execute_dml_preview', () => {
  it('devuelve el conteo y la muestra sin ejecutar el DML', async () => {
    const dataAccess = previewFake(2, [{ EMPLOYEE_ID: 1 }, { EMPLOYEE_ID: 2 }]);
    const sql = 'UPDATE employees SET salary = 1 WHERE dept = 10';

    await withHarness(dataAccess, async (harness) => {
      expect(payload(await call(harness, 'execute_dml_preview', { sql }))).toEqual({
        detectedKind: 'UPDATE',
        table: 'employees',
        affectedRowCount: 2,
        sampleColumns: ['EMPLOYEE_ID'],
        sampleRows: [{ EMPLOYEE_ID: 1 }, { EMPLOYEE_ID: 2 }],
        sampleCount: 2,
        note: 'Dry-run preview: the statement was NOT executed. 2 row(s) would be affected. Call execute_dml to apply, or execute_dml_rollback_first to dry-run the write.',
      });
    });

    expect(dataAccess.calls.map((call) => call.method)).toEqual(['queryForObject', 'queryForList']);
    expect(dataAccess.calls[0]?.sql).toBe('SELECT COUNT(*) FROM employees WHERE dept = 10');
    expect(dataAccess.calls[1]?.sql).toBe(
      'SELECT * FROM ( SELECT * FROM employees WHERE dept = 10 ) WHERE ROWNUM <= 10',
    );
  });

  it('cuenta y muestrea toda la tabla cuando el DML no tiene WHERE', async () => {
    const dataAccess = previewFake(7, []);

    await withHarness(dataAccess, async (harness) => {
      const result = payload(
        await call(harness, 'execute_dml_preview', { sql: 'DELETE FROM employees' }),
      );
      expect(result).toMatchObject({
        detectedKind: 'DELETE',
        table: 'employees',
        affectedRowCount: 7,
        sampleColumns: [],
        sampleRows: [],
        sampleCount: 0,
      });
    });

    expect(dataAccess.calls[0]?.sql).toBe('SELECT COUNT(*) FROM employees');
  });

  it('rechaza INSERT y MERGE con isError y dice qué tool usar', async () => {
    const dataAccess = new FakeDataAccess();

    await withHarness(dataAccess, async (harness) => {
      const insert = await call(harness, 'execute_dml_preview', {
        sql: "INSERT INTO employees (name) VALUES ('x')",
      });
      const merge = await call(harness, 'execute_dml_preview', {
        sql: 'MERGE INTO tgt USING src ON (1=1) WHEN MATCHED THEN UPDATE SET a = 1',
      });

      expect(insert.isError).toBe(true);
      expect(insert.content[0]?.text).toContain('execute_dml_rollback_first');
      expect(merge.isError).toBe(true);
      expect(merge.content[0]?.text).toContain('execute_dml_rollback_first');
      expect(dataAccess.calls).toHaveLength(0);
    });
  });
});

describe('execute_dml_rollback_first', () => {
  it('ejecuta por el chokepoint con rollback y no persiste nada', async () => {
    const dataAccess = new FakeDataAccess().on(
      (c) => c.method === 'executeInTransaction',
      () => ({ rowCount: 5 }),
    );

    await withHarness(dataAccess, async (harness) => {
      expect(
        payload(
          await call(harness, 'execute_dml_rollback_first', {
            sql: 'UPDATE employees SET salary = 1',
          }),
        ),
      ).toEqual({
        detectedKind: 'UPDATE',
        rowsAffected: 5,
        rolledBack: true,
        note: 'Statement executed and rolled back; nothing was persisted. Call execute_dml to apply the change.',
      });
    });

    expect(dataAccess.calls).toEqual([
      {
        method: 'executeInTransaction',
        sql: 'UPDATE employees SET salary = 1',
        outcome: 'rollback',
      },
    ]);
  });
});

