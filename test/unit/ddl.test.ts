import { describe, expect, it } from 'vite-plus/test';
import { FakeDataAccess } from '../../src/db/fake-data-access.js';
import { createHarness, type Harness, type HarnessOptions } from '../helpers/harness.js';

/** El SDK tipa el content como unión de bloques; estas tools devuelven texto. */
interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
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

async function call(harness: Harness, name: string, args: Record<string, unknown>) {
  return (await harness.client.callTool({ name, arguments: args })) as ToolResult;
}

/** Harness con ORACLE_DB_SCHEMA=DEVUSER, el schema por defecto de las tools. */
async function ddl(
  args: Record<string, unknown>,
  dataAccess = new FakeDataAccess(),
  config: HarnessOptions['config'] = { schema: 'DEVUSER' },
): Promise<{ result: ToolResult; sql: string | undefined }> {
  return withHarness({ dataAccess, config }, async (harness) => {
    const result = await call(harness, args.tool as string, args);
    const executed = dataAccess.calls.find((c) => c.method === 'execute');
    return { result, sql: executed?.sql };
  });
}

describe('comment_on_table', () => {
  it('arma COMMENT ON TABLE con los identificadores entrecomillados', async () => {
    const { result, sql } = await ddl({
      tool: 'comment_on_table',
      table: 'T_T7',
      comment: 'Tabla de pruebas',
    });

    expect(sql).toBe(`COMMENT ON TABLE "DEVUSER"."T_T7" IS 'Tabla de pruebas'`);
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe('Comment applied to table DEVUSER.T_T7');
  });

  it('escapa la comilla simple del comentario duplicándola', async () => {
    const { sql } = await ddl({
      tool: 'comment_on_table',
      table: 'T_T7',
      comment: "O'Brien",
    });

    expect(sql).toBe(`COMMENT ON TABLE "DEVUSER"."T_T7" IS 'O''Brien'`);
  });

  it('acepta el schema explícito por encima del configurado', async () => {
    const { sql } = await ddl({
      tool: 'comment_on_table',
      schema: 'APP',
      table: 'T_T7',
      comment: 'x',
    });

    expect(sql).toBe(`COMMENT ON TABLE "APP"."T_T7" IS 'x'`);
  });
});

describe('comment_on_column', () => {
  it('arma COMMENT ON COLUMN con las tres partes entrecomilladas', async () => {
    const { result, sql } = await ddl({
      tool: 'comment_on_column',
      table: 'T_T7',
      column: 'C1',
      comment: 'Columna de pruebas',
    });

    expect(sql).toBe(`COMMENT ON COLUMN "DEVUSER"."T_T7"."C1" IS 'Columna de pruebas'`);
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe('Comment applied to column DEVUSER.T_T7.C1');
  });
});

describe('create_or_replace_view', () => {
  it('arma CREATE OR REPLACE VIEW con el cuerpo SELECT tal cual', async () => {
    const { result, sql } = await ddl({
      tool: 'create_or_replace_view',
      view: 'V_T7',
      selectBody: 'SELECT 1 FROM dual',
    });

    expect(sql).toBe('CREATE OR REPLACE VIEW "DEVUSER"."V_T7" AS SELECT 1 FROM dual');
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe('View DEVUSER.V_T7 created (or replaced).');
  });

  it('rechaza un cuerpo que no es un SELECT', async () => {
    const { result, sql } = await ddl({
      tool: 'create_or_replace_view',
      view: 'V_T7',
      selectBody: 'DELETE FROM T_T7',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('selectBody must be a SELECT statement.');
    expect(sql).toBeUndefined();
  });
});

describe('create_synonym', () => {
  it('arma CREATE SYNONYM privado', async () => {
    const { result, sql } = await ddl({
      tool: 'create_synonym',
      synonym: 'S_T7',
      targetSchema: 'APP',
      targetName: 'T',
    });

    expect(sql).toBe('CREATE SYNONYM "DEVUSER"."S_T7" FOR "APP"."T"');
    expect(result.content[0]?.text).toBe('Synonym DEVUSER.S_T7 created.');
  });

  it('arma CREATE PUBLIC SYNONYM con isPublic', async () => {
    const { result, sql } = await ddl({
      tool: 'create_synonym',
      synonym: 'S_T7',
      targetSchema: 'APP',
      targetName: 'T',
      isPublic: true,
    });

    expect(sql).toBe('CREATE PUBLIC SYNONYM "DEVUSER"."S_T7" FOR "APP"."T"');
    expect(result.content[0]?.text).toBe('Synonym PUBLIC DEVUSER.S_T7 created.');
  });
});

describe('create_sequence', () => {
  it('arma la secuencia con todas las cláusulas opcionales', async () => {
    const { result, sql } = await ddl({
      tool: 'create_sequence',
      sequence: 'SEQ_T7',
      startWith: 10,
      incrementBy: 5,
      cache: 20,
      cycle: true,
      order: true,
    });

    expect(sql).toBe(
      'CREATE SEQUENCE "DEVUSER"."SEQ_T7" START WITH 10 INCREMENT BY 5 CACHE 20 CYCLE ORDER',
    );
    expect(result.content[0]?.text).toBe('Sequence DEVUSER.SEQ_T7 created.');
  });

  it('omite START WITH / INCREMENT BY si no vienen y cae a NOCACHE sin cache', async () => {
    const { sql } = await ddl({ tool: 'create_sequence', sequence: 'SEQ_T7' });

    expect(sql).toBe('CREATE SEQUENCE "DEVUSER"."SEQ_T7" NOCACHE NOCYCLE NOORDER');
  });

  it('rechaza INCREMENT BY 0 antes de tocar la base de datos', async () => {
    const { result, sql } = await ddl({
      tool: 'create_sequence',
      sequence: 'SEQ_T7',
      incrementBy: 0,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('incrementBy must be non-zero');
    expect(sql).toBeUndefined();
  });
});

describe('create_index', () => {
  it('arma CREATE INDEX con las columnas entrecomilladas en CSV', async () => {
    const { result, sql } = await ddl({
      tool: 'create_index',
      index: 'I_T7',
      tableSchema: 'APP',
      table: 'T',
      columns: ['A', 'B'],
    });

    expect(sql).toBe('CREATE INDEX "DEVUSER"."I_T7" ON "APP"."T" ("A", "B")');
    expect(result.content[0]?.text).toBe('Index DEVUSER.I_T7 created on APP.T.');
  });

  it('arma CREATE UNIQUE INDEX con unique', async () => {
    const { sql } = await ddl({
      tool: 'create_index',
      index: 'I_T7',
      tableSchema: 'APP',
      table: 'T',
      columns: ['A'],
      unique: true,
    });

    expect(sql).toBe('CREATE UNIQUE INDEX "DEVUSER"."I_T7" ON "APP"."T" ("A")');
  });

  it('rechaza una lista de columnas vacía', async () => {
    const { result, sql } = await ddl({
      tool: 'create_index',
      index: 'I_T7',
      tableSchema: 'APP',
      table: 'T',
      columns: [],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('At least one column is required.');
    expect(sql).toBeUndefined();
  });
});

describe('create_mview_log', () => {
  it('arma el log con WITH PRIMARY KEY, ROWID e INCLUDING NEW VALUES', async () => {
    const { result, sql } = await ddl({
      tool: 'create_mview_log',
      table: 'T_T7',
      withRowid: true,
      withPrimaryKey: true,
      includingNewValues: true,
    });

    expect(sql).toBe(
      'CREATE MATERIALIZED VIEW LOG ON "DEVUSER"."T_T7" WITH PRIMARY KEY, ROWID INCLUDING NEW VALUES',
    );
    expect(result.content[0]?.text).toBe('Materialized view log created on DEVUSER.T_T7.');
  });

  it('omite la cláusula WITH cuando solo se pide ROWID', async () => {
    const { sql } = await ddl({ tool: 'create_mview_log', table: 'T_T7', withRowid: true });

    expect(sql).toBe('CREATE MATERIALIZED VIEW LOG ON "DEVUSER"."T_T7" WITH ROWID');
  });

  it('rechaza pedir el log sin ni ROWID ni PRIMARY KEY', async () => {
    const { result, sql } = await ddl({ tool: 'create_mview_log', table: 'T_T7' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      'At least one of withRowid or withPrimaryKey is required',
    );
    expect(sql).toBeUndefined();
  });
});

describe('validación de identificadores', () => {
  it('no ejecuta nada cuando el nombre de tabla no pasa la allow-list', async () => {
    const { result, sql } = await ddl({
      tool: 'comment_on_table',
      table: 'T_T7"; DROP TABLE X --',
      comment: 'x',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('identificador inválido');
    expect(result.content[0]?.text).toContain('DROP TABLE X --');
    expect(sql).toBeUndefined();
  });

  it('devuelve isError cuando no hay schema explícito ni configurado', async () => {
    const { result, sql } = await ddl(
      { tool: 'comment_on_table', table: 'T_T7', comment: 'x' },
      new FakeDataAccess(),
      { schema: undefined },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('necesita un schema');
    expect(sql).toBeUndefined();
  });
});

describe('sin privilegios', () => {
  it('ORA-01031 llega como isError con el hint, sin romper el canal', async () => {
    const denied = new FakeDataAccess().alwaysFail(
      Object.assign(new Error('ORA-01031: insufficient privileges'), { code: 'ORA-01031' }),
    );

    const { result } = await ddl({ tool: 'create_sequence', sequence: 'SEQ_T7' }, denied);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('ORA-01031');
    expect(result.content[0]?.text).toContain('least-privilege user has no DDL/DCL privileges');
  });

  it('ORA-01950 llega como isError con el texto de Oracle', async () => {
    const noQuota = new FakeDataAccess().alwaysFail(
      Object.assign(new Error('ORA-01950: no quota on tablespace USERS'), {
        code: 'ORA-01950',
      }),
    );

    const { result } = await ddl(
      { tool: 'create_mview_log', table: 'T_T7', withPrimaryKey: true },
      noQuota,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('ORA-01950');
    expect(result.content[0]?.text).toContain('no quota on tablespace');
  });
});
