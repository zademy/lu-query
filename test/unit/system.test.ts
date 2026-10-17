import { describe, expect, it } from 'vitest';
import { FakeDataAccess } from '../../src/db/fake-data-access.js';
import { createHarness } from '../helpers/harness.js';

/** El SDK tipa el content como unión de bloques; estas tools devuelven texto. */
interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

/** Fila que devuelve la query de identidad de la sesión (Oracle devuelve alias en mayúsculas). */
const IDENTITY_ROW = {
  VERSION: 'Oracle AI Database 26ai Free Release 23.26.3.0.0 - Develop',
  DB_NAME: 'FREEPDB1',
  CURRENT_USER: 'DEVUSER',
  CURRENT_SCHEMA: 'APP_USER',
  INSTANCE_NAME: 'FREE',
};

function identityBackend(reply: { rows?: Record<string, unknown>[] } | Error): FakeDataAccess {
  const data = new FakeDataAccess();
  if (reply instanceof Error) return data.alwaysFail(reply);
  return data.on(
    ({ sql }) => sql.includes('v$version'),
    () => reply,
  );
}

async function callTestConnection(dataAccess: FakeDataAccess): Promise<ToolResult> {
  const harness = await createHarness({ dataAccess });
  try {
    return (await harness.client.callTool({
      name: 'test_connection',
      arguments: {},
    })) as ToolResult;
  } finally {
    await harness.close();
  }
}

describe('tools/list', () => {
  it('publica test_connection con la descripción del Java', async () => {
    const harness = await createHarness();

    try {
      const { tools } = await harness.client.listTools();
      const tool = tools.find((candidate) => candidate.name === 'test_connection');

      expect(tool?.description).toContain('Verify connectivity to Oracle');
      expect(tool?.description).toContain('WHEN TO CALL:');
      expect(tool?.inputSchema).toMatchObject({ type: 'object' });
    } finally {
      await harness.close();
    }
  });
});

describe('test_connection', () => {
  it('devuelve version, db name, usuario, schema e instancia', async () => {
    const result = await callTestConnection(identityBackend({ rows: [IDENTITY_ROW] }));

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual({
      databaseVersion: 'Oracle AI Database 26ai Free Release 23.26.3.0.0 - Develop',
      databaseName: 'FREEPDB1',
      currentUser: 'DEVUSER',
      currentSchema: 'APP_USER',
      instanceName: 'FREE',
    });
  });

  it('lee la identidad de la sesión con una sola query y sin binds de usuario', async () => {
    const dataAccess = identityBackend({ rows: [IDENTITY_ROW] });

    await callTestConnection(dataAccess);

    expect(dataAccess.calls).toHaveLength(1);
    expect(dataAccess.calls[0]?.method).toBe('queryForObject');
    expect(dataAccess.calls[0]?.sql).toContain("SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')");
    expect(dataAccess.calls[0]?.binds).toBeUndefined();
  });

  it('degrada a texto vacío cuando un valor viene null', async () => {
    const result = await callTestConnection(
      identityBackend({ rows: [{ ...IDENTITY_ROW, INSTANCE_NAME: null }] }),
    );

    expect(JSON.parse(result.content[0]?.text ?? '').instanceName).toBe('');
  });

  it('responde isError con el mensaje de Oracle cuando la BD no responde', async () => {
    const result = await callTestConnection(
      identityBackend(
        Object.assign(new Error('ORA-01017: invalid username/password; logon denied'), {
          code: 'ORA-01017',
        }),
      ),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('ORA-01017');
  });

  it('degrada a campos vacíos, sin error, si la sesión no devuelve fila', async () => {
    const result = await callTestConnection(
      new FakeDataAccess().on(
        ({ sql }) => sql.includes('v$version'),
        () => ({ rows: [] }),
      ),
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual({
      databaseVersion: '',
      databaseName: '',
      currentUser: '',
      currentSchema: '',
      instanceName: '',
    });
  });
});
