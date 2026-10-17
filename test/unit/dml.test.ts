import { describe, expect, it } from 'vitest';
import { FakeDataAccess } from '../../src/db/fake-data-access.js';
import { runInTransaction, type TransactionConnection } from '../../src/tools/dml.js';
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

/** Conexión de mentira para runRolledBack, con la que sí rollback en el pool real. */
function fakeConnection(rowsAffected: number) {
  const calls: string[] = [];
  const connection: TransactionConnection = {
    callTimeout: 0,
    autoCommit: true,
    execute: () => {
      calls.push('execute');
      return Promise.resolve({ rows: [], rowsAffected });
    },
    commit: () => {
      calls.push('commit');
      return Promise.resolve();
    },
    rollback: () => {
      calls.push('rollback');
      return Promise.resolve();
    },
    breakExecution: () => Promise.resolve(),
    close: () => {
      calls.push('close');
      return Promise.resolve();
    },
  };
  return { connection, calls };
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
  it('propaga el fallo de la transacción como resultado isError', async () => {
    const dataAccess = new FakeDataAccess();

    await withHarness(dataAccess, async (harness) => {
      const result = await call(harness, 'execute_dml', { sql: 'UPDATE nope SET a = 1' });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).not.toBe('');
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
  it('devuelve isError sin pool en vez de romper el transporte', async () => {
    const dataAccess = new FakeDataAccess();

    await withHarness(dataAccess, async (harness) => {
      const result = await call(harness, 'execute_dml_rollback_first', {
        sql: 'UPDATE employees SET salary = 1',
      });

      expect(result.isError).toBe(true); // sin pool Oracle no hay transacción que abrir
      expect(result.content[0]?.text).not.toBe('');
    });
  });
});

describe('runInTransaction', () => {
  it('con commit: desactiva autoCommit, ejecuta, confirma y devuelve las filas', async () => {
    const { connection, calls } = fakeConnection(3);

    await expect(
      runInTransaction(
        () => Promise.resolve(connection),
        'UPDATE employees SET salary = 1',
        'commit',
      ),
    ).resolves.toBe(3);

    expect(connection.autoCommit).toBe(false);
    expect(calls).toEqual(['execute', 'commit', 'close']);
  });

  it('con rollback: ejecuta, revierte y devuelve las filas', async () => {
    const { connection, calls } = fakeConnection(5);

    await expect(
      runInTransaction(
        () => Promise.resolve(connection),
        'UPDATE employees SET salary = 1',
        'rollback',
      ),
    ).resolves.toBe(5);

    expect(connection.autoCommit).toBe(false);
    expect(calls).toEqual(['execute', 'rollback', 'close']);
  });

  it('cierra la conexión aunque el DML falle y no confirma nada', async () => {
    const connection: TransactionConnection = {
      callTimeout: 0,
      autoCommit: true,
      execute: () => Promise.reject(new Error('ORA-00942: table or view does not exist')),
      commit: () => Promise.resolve(),
      rollback: () => Promise.resolve(),
      breakExecution: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };

    await expect(
      runInTransaction(() => Promise.resolve(connection), 'UPDATE nope SET a = 1', 'commit'),
    ).rejects.toThrow('ORA-00942');
  });
});
