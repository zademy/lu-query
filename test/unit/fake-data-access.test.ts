import { describe, expect, it } from 'vite-plus/test';
import { MAX_ROWS } from '../../src/config.js';
import { FakeDataAccess } from '../../src/db/fake-data-access.js';

describe('FakeDataAccess', () => {
  it('devuelve filas vacías si ninguna regla responde', async () => {
    const data = new FakeDataAccess();

    expect(await data.queryForList('SELECT 1 FROM dual')).toEqual([]);
    expect(await data.queryForObject('SELECT 1 FROM dual')).toBeNull();
    expect(await data.execute('DELETE FROM t')).toBe(0);
  });

  it('responde con la primera regla que matchea y deja pasar las demás', async () => {
    const data = new FakeDataAccess()
      .on(
        ({ sql }) => sql.includes('employees'),
        () => ({ rows: [{ id: 1 }], rowCount: 1 }),
      )
      .on(
        () => true,
        () => ({ rows: [{ id: 2 }] }),
      );

    expect(await data.queryForObject('SELECT id FROM employees')).toEqual({ id: 1 });
    expect(await data.queryForObject('SELECT id FROM departments')).toEqual({ id: 2 });
  });

  it('puede simular un fallo de Oracle', async () => {
    const data = new FakeDataAccess().alwaysFail(new Error('ORA-00942: table does not exist'));

    await expect(data.queryForList('SELECT * FROM nope')).rejects.toThrow(/ORA-00942/);
  });

  it('registra cada llamada para poder afirmar sobre ellas', async () => {
    const data = new FakeDataAccess().always(() => ({ rows: [{ id: 7 }], rowCount: 1 }));

    await data.queryForList('SELECT id FROM employees', [10], { maxRows: 5 });

    expect(data.calls).toEqual([
      {
        method: 'queryForList',
        sql: 'SELECT id FROM employees',
        binds: [10],
        options: { maxRows: 5 },
      },
    ]);
  });

  it('aplica el mismo tope de filas que el chokepoint', async () => {
    const rows = Array.from({ length: 1200 }, (_, id) => ({ id }));
    const data = new FakeDataAccess().always(() => ({ rows }));

    expect(await data.queryForList('SELECT id FROM t')).toHaveLength(MAX_ROWS);
    expect(await data.queryForList('SELECT id FROM t', [], { maxRows: 3 })).toHaveLength(3);
  });

  it('close() es inocuo y marca que se cerró', async () => {
    const data = new FakeDataAccess();

    await data.close();

    expect(data.closed).toBe(true);
  });
});
