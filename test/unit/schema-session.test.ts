import { describe, expect, it } from 'vitest';
import { FakeDataAccess } from '../../src/db/fake-data-access.js';
import { createHarness } from '../helpers/harness.js';

/** La sesión responde HR cuando la tool no trae schema ni ORACLE_DB_SCHEMA. */
function conSesionHR(): FakeDataAccess {
  return new FakeDataAccess()
    .on(
      (call) => call.sql.includes('SYS_CONTEXT'),
      () => ({ rows: [{ CURRENT_SCHEMA: 'HR' }] }),
    )
    .always(() => ({ rows: [] }));
}

/**
 * La resolución del schema se prueba por el mismo seam que el cliente: la tool
 * entra por MCP y se afirma sobre el SQL que salió. Antes esto se probaba contra
 * un contexto de mentira y el fork de list_indexes quedaba invisible.
 */
describe('schema de sesión', () => {
  it('list_indexes opera contra el schema de la sesión si la tool no pide ninguno', async () => {
    const harness = await createHarness({ dataAccess: conSesionHR() });

    try {
      const result = (await harness.client.callTool({
        name: 'list_indexes',
        arguments: { table: 'EMP' },
      })) as { isError?: boolean; content: { text: string }[] };

      expect(result.isError).toBeFalsy();
      const catalogo = harness.dataAccess.calls.find((call) => call.sql.includes('all_indexes'));
      expect(catalogo?.binds?.[0]).toBe('HR');
    } finally {
      await harness.close();
    }
  });

  it('el schema explícito gana y no se consulta la sesión', async () => {
    const harness = await createHarness({ dataAccess: conSesionHR() });

    try {
      await harness.client.callTool({
        name: 'list_indexes',
        arguments: { table: 'EMP', schema: 'SCOTT' },
      });

      expect(harness.dataAccess.calls.some((call) => call.sql.includes('SYS_CONTEXT'))).toBe(false);
      const catalogo = harness.dataAccess.calls.find((call) => call.sql.includes('all_indexes'));
      expect(catalogo?.binds?.[0]).toBe('SCOTT');
    } finally {
      await harness.close();
    }
  });

  it('ORACLE_DB_SCHEMA gana a la sesión sin tocar la base', async () => {
    const harness = await createHarness({
      dataAccess: new FakeDataAccess().alwaysFail(new Error('no debe consultar')),
      config: { schema: 'APP' },
    });

    try {
      await harness.client.callTool({ name: 'list_indexes', arguments: { table: 'EMP' } });

      expect(harness.dataAccess.calls.some((call) => call.sql.includes('SYS_CONTEXT'))).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('sin schema en ninguna parte, la tool lo dice en su mensaje', async () => {
    const harness = await createHarness({
      dataAccess: new FakeDataAccess().always(() => ({ rows: [] })),
    });

    try {
      const result = (await harness.client.callTool({
        name: 'list_indexes',
        arguments: { table: 'EMP' },
      })) as { isError?: boolean; content: { text: string }[] };

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('list_indexes necesita un schema');
    } finally {
      await harness.close();
    }
  });
});
