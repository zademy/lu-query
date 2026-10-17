import { describe, expect, it } from 'vitest';
import { resolveSchemaFor } from '../../src/catalog/schema.js';
import { FakeDataAccess } from '../../src/db/fake-data-access.js';
import type { ServerContext } from '../../src/server.js';

/** Contexto mínimo: el resolver solo necesita config, sessionSchema y dataAccess. */
function ctx(dataAccess: FakeDataAccess, schema?: string): ServerContext {
  return {
    server: undefined as never,
    dataAccess,
    config: { schema } as ServerContext['config'],
  };
}

describe('resolveSchemaFor', () => {
  it('gana el schema explícito sin tocar la base', async () => {
    const dataAccess = new FakeDataAccess().alwaysFail(new Error('no debe consultar'));

    await expect(resolveSchemaFor(ctx(dataAccess), ' HR ', 'list_tables')).resolves.toBe('HR');
    expect(dataAccess.calls).toHaveLength(0);
  });

  it('usa ORACLE_DB_SCHEMA sin tocar la base', async () => {
    const dataAccess = new FakeDataAccess().alwaysFail(new Error('no debe consultar'));

    await expect(resolveSchemaFor(ctx(dataAccess, 'APP'), undefined, 'list_tables')).resolves.toBe(
      'APP',
    );
    expect(dataAccess.calls).toHaveLength(0);
  });

  it('cae al schema de la sesión y lo cachea para las siguientes tools', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: [{ current_schema: 'HR' }] }));
    const context = ctx(dataAccess);

    await expect(resolveSchemaFor(context, undefined, 'describe_table')).resolves.toBe('HR');
    await expect(resolveSchemaFor(context, undefined, 'list_tables')).resolves.toBe('HR');

    expect(dataAccess.calls).toHaveLength(1);
    expect(dataAccess.calls[0]?.sql).toContain('SYS_CONTEXT');
  });

  it('propaga el mensaje de la tool si no hay schema de ninguna parte', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: [] }));

    await expect(resolveSchemaFor(ctx(dataAccess), undefined, 'list_tables')).rejects.toThrow(
      'list_tables necesita un schema',
    );
  });
});
