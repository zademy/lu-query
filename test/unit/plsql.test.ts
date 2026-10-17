import { describe, expect, it } from 'vitest';
import type { OracleRow } from '../../src/db/oracle-types.js';
import type { FakeDataAccess } from '../../src/db/fake-data-access.js';
import { DataAccessError } from '../../src/errors.js';
import { createHarness, type Harness, type HarnessOptions } from '../helpers/harness.js';

/** El SDK tipa el content como unión de bloques; estas tools devuelven texto. */
interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
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
function payload<T>(result: ToolResult): T {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]?.text ?? '') as T;
}

/** describe_plsql tal como lo serializa la tool. */
interface Described {
  schema: string;
  name: string;
  type: string | null;
  arguments: {
    ARGUMENT_NAME: string | null;
    DATA_TYPE: string | null;
    IN_OUT: string | null;
    POSITION: number;
    DEFAULTED: unknown;
  }[];
  source: string;
}

/** call_procedure tal como lo serializa la tool (PlsqlCallResult del Java). */
interface CallResult {
  outParams: Record<string, unknown>;
  returnValue: unknown;
  cursorResult: unknown;
}

/** Texto del bloque de texto de una tool o de un recurso MCP. */
function text(result: unknown): string {
  const blocks = result as { content?: { text?: string }[]; contents?: { text?: string }[] };
  return blocks.content?.[0]?.text ?? blocks.contents?.[0]?.text ?? '';
}

const DEVUSER = 'DEVUSER';

/** describe_plsql responde con dos queries de diccionario. */
function onDescribe(fake: FakeDataAccess, arguments_: OracleRow[] = [], source = ''): void {
  fake
    .on(
      (c) => c.method === 'queryForList' && c.sql.includes('FROM all_arguments'),
      () => ({
        rows: arguments_,
      }),
    )
    .on(
      (c) => c.method === 'queryForList' && c.sql.includes('FROM all_source'),
      () => ({
        rows: source.split('\n').map((line, i) => ({ LINE: i + 1, TEXT: `${line}\n` })),
      }),
    );
}

describe('tools/list · grupo Plsql', () => {
  it('publica describe_plsql y call_procedure con las descripciones del Java', async () => {
    await withHarness({}, async (harness) => {
      const { tools } = await harness.client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool]));

      const describe = byName.get('describe_plsql');
      expect(describe?.description).toBe(
        'Describe a PL/SQL object: returns its arguments (name, data type, in/out, position) and full source code. Read-only.',
      );

      const callProc = byName.get('call_procedure');
      expect(callProc?.description).toContain(
        'Execute a PL/SQL procedure, function or package subprogram',
      );
      expect(callProc?.description).toContain('SYS_REFCURSOR OUT/return argument');
    });
  });
});

describe('describe_plsql', () => {
  it('devuelve argumentos y source de ALL_ARGUMENTS/ALL_SOURCE', async () => {
    await withHarness({}, async (harness) => {
      const arguments_ = [
        {
          ARGUMENT_NAME: 'P_FIRST_NAME',
          DATA_TYPE: 'VARCHAR2',
          IN_OUT: 'IN',
          POSITION: 1,
          DEFAULTED: null,
        },
      ];
      onDescribe(harness.dataAccess, arguments_, 'PROCEDURE add_employee (');

      const result = payload<Described>(
        await call(harness, 'describe_plsql', { schema: DEVUSER, name: 'ADD_EMPLOYEE' }),
      );

      expect(result).toEqual({
        schema: DEVUSER,
        name: 'ADD_EMPLOYEE',
        type: null,
        arguments: arguments_,
        source: 'PROCEDURE add_employee (\n',
      });

      const argsQuery = harness.dataAccess.calls.find((c) => c.sql.includes('all_arguments'));
      expect(argsQuery?.sql).toContain('WHERE owner = :1 AND object_name = :2');
      expect(argsQuery?.binds).toEqual([DEVUSER, 'ADD_EMPLOYEE']);

      const sourceQuery = harness.dataAccess.calls.find((c) => c.sql.includes('all_source'));
      expect(sourceQuery?.sql).toContain('(:3 IS NULL OR type = :3)');
      expect(sourceQuery?.binds).toEqual([DEVUSER, 'ADD_EMPLOYEE', null, null]);
    });
  });

  it('filtra all_source por type cuando se pide (p.ej. PACKAGE BODY)', async () => {
    await withHarness({}, async (harness) => {
      onDescribe(harness.dataAccess);
      await call(harness, 'describe_plsql', {
        schema: DEVUSER,
        name: 'EMP_PKG',
        type: 'PACKAGE BODY',
      });
      expect(harness.dataAccess.calls.find((c) => c.sql.includes('all_source'))?.binds).toEqual([
        DEVUSER,
        'EMP_PKG',
        'PACKAGE BODY',
        'PACKAGE BODY',
      ]);
    });
  });

  it('sin schema explícito resuelve el de la sesión (SYS_CONTEXT)', async () => {
    await withHarness({}, async (harness) => {
      harness.dataAccess
        .on(
          (c) => c.sql.includes('SYS_CONTEXT'),
          () => ({ rows: [{ current_schema: DEVUSER }] }),
        )
        .on(
          (c) => c.method === 'queryForList' && c.sql.includes('all_arguments'),
          () => ({ rows: [] }),
        )
        .on(
          (c) => c.method === 'queryForList' && c.sql.includes('all_source'),
          () => ({ rows: [] }),
        );

      const result = payload<{ schema: string }>(
        await call(harness, 'describe_plsql', { name: 'ADD_EMPLOYEE' }),
      );
      expect(result.schema).toBe(DEVUSER);
    });
  });

  it('un error de Oracle llega como isError', async () => {
    await withHarness({}, async (harness) => {
      harness.dataAccess.alwaysFail(
        new DataAccessError('ORA-00942: table or view does not exist', 'ORA-00942'),
      );
      const result = await call(harness, 'describe_plsql', { schema: DEVUSER, name: 'NOPE' });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('ORA-00942');
    });
  });
});

describe('call_procedure', () => {
  const IN_ARGS = JSON.stringify([
    { name: 'P_FIRST_NAME', direction: 'IN', dataType: 'VARCHAR2', value: 'Ana' },
    { name: 'P_LAST_NAME', direction: 'IN', dataType: 'VARCHAR2', value: 'Pérez' },
    { name: 'P_EMAIL', direction: 'IN', dataType: 'VARCHAR2', value: 'ana@x.io' },
    { name: 'P_DEPT_ID', direction: 'IN', dataType: 'NUMBER', value: 1 },
    { name: 'P_SALARY', direction: 'IN', dataType: 'NUMBER', value: 100 },
  ]);

  it('procedimiento solo-IN: bloque BEGIN…END con binds posicionales y commit del chokepoint', async () => {
    await withHarness({}, async (harness) => {
      harness.dataAccess.on(
        (c) => c.method === 'execute',
        () => ({ rowCount: 0 }),
      );

      const result = payload<CallResult>(
        await call(harness, 'call_procedure', {
          schema: DEVUSER,
          name: 'ADD_EMPLOYEE',
          args: IN_ARGS,
        }),
      );

      expect(result).toEqual({ outParams: {}, returnValue: null, cursorResult: null });
      expect(harness.dataAccess.calls).toContainEqual({
        method: 'execute',
        sql: 'BEGIN "DEVUSER"."ADD_EMPLOYEE"(:1, :2, :3, :4, :5); END;',
        binds: ['Ana', 'Pérez', 'ana@x.io', 1, 100],
      });
    });
  });

  it('función sin argumentos: SELECT … FROM DUAL y returnValue', async () => {
    await withHarness({}, async (harness) => {
      harness.dataAccess.on(
        (c) => c.method === 'queryForList',
        () => ({ rows: [{ returnValue: 4 }] }),
      );

      const result = payload<CallResult>(
        await call(harness, 'call_procedure', {
          schema: DEVUSER,
          name: 'GET_EMPLOYEE_COUNT',
          args: '[]',
          isFunction: true,
          returnType: 'NUMBER',
        }),
      );

      expect(result).toEqual({ outParams: {}, returnValue: 4, cursorResult: null });
      expect(harness.dataAccess.calls).toContainEqual({
        method: 'queryForList',
        sql: 'SELECT "DEVUSER"."GET_EMPLOYEE_COUNT"() AS "returnValue" FROM DUAL',
        binds: [],
        options: { maxRows: 1 },
      });
    });
  });

  it('función con argumentos IN: binds posicionales en el SELECT', async () => {
    await withHarness({}, async (harness) => {
      harness.dataAccess.on(
        (c) => c.method === 'queryForList',
        () => ({ rows: [{ returnValue: 7 }] }),
      );

      await call(harness, 'call_procedure', {
        schema: DEVUSER,
        name: 'GET_EMPLOYEE_COUNT',
        args: '[{"name":"P_DEPT","direction":"IN","dataType":"NUMBER","value":2}]',
        isFunction: true,
        returnType: 'NUMBER',
      });

      expect(harness.dataAccess.calls).toContainEqual({
        method: 'queryForList',
        sql: 'SELECT "DEVUSER"."GET_EMPLOYEE_COUNT"(:1) AS "returnValue" FROM DUAL',
        binds: [2],
        options: { maxRows: 1 },
      });
    });
  });

  it('OUT/INOUT escalares: wrapper WITH FUNCTION que devuelve JSON de los OUT', async () => {
    await withHarness({}, async (harness) => {
      harness.dataAccess.on(
        (c) => c.method === 'queryForList' && c.sql.startsWith('WITH FUNCTION'),
        () => ({ rows: [{ resultado: '{"P_OUT":"out:7","P_IO":30}' }] }),
      );

      const result = payload<CallResult>(
        await call(harness, 'call_procedure', {
          schema: DEVUSER,
          name: 'T11_PROBE_RO',
          args: JSON.stringify([
            { name: 'P_ID', direction: 'IN', dataType: 'NUMBER', value: 7 },
            { name: 'P_OUT', direction: 'OUT', dataType: 'VARCHAR2' },
            { name: 'P_IO', direction: 'INOUT', dataType: 'NUMBER', value: 3 },
          ]),
        }),
      );

      expect(result).toEqual({
        outParams: { P_OUT: 'out:7', P_IO: 30 },
        returnValue: null,
        cursorResult: null,
      });

      const wrapper = harness.dataAccess.calls.find((c) => c.sql.startsWith('WITH FUNCTION'));
      expect(wrapper?.sql).toContain('"DEVUSER"."T11_PROBE_RO"');
      expect(wrapper?.sql).toContain('JSON_OBJECT');
      expect(wrapper?.binds).toEqual([7, 3]);
    });
  });

  it('función con OUT: el wrapper incluye returnValue en el JSON', async () => {
    await withHarness({}, async (harness) => {
      harness.dataAccess.on(
        (c) => c.method === 'queryForList' && c.sql.startsWith('WITH FUNCTION'),
        () => ({ rows: [{ resultado: '{"returnValue":42,"P_OUT":"ok"}' }] }),
      );

      const result = payload<CallResult>(
        await call(harness, 'call_procedure', {
          schema: DEVUSER,
          name: 'FN_OUT',
          args: '[{"name":"P_OUT","direction":"OUT","dataType":"VARCHAR2"}]',
          isFunction: true,
          returnType: 'NUMBER',
        }),
      );

      expect(result).toEqual({ outParams: { P_OUT: 'ok' }, returnValue: 42, cursorResult: null });
    });
  });

  it('subprograma de package: nombre calificado PKG.PROC', async () => {
    await withHarness({}, async (harness) => {
      harness.dataAccess.on(
        (c) => c.method === 'execute',
        () => ({ rowCount: 0 }),
      );
      await call(harness, 'call_procedure', {
        schema: DEVUSER,
        name: 'EMP_PKG.DO_HIRE',
        args: '[{"name":"P_ID","direction":"IN","dataType":"NUMBER","value":9}]',
      });
      expect(harness.dataAccess.calls).toContainEqual({
        method: 'execute',
        sql: 'BEGIN "DEVUSER"."EMP_PKG"."DO_HIRE"(:1); END;',
        binds: [9],
      });
    });
  });

  it('args JSON inválido llega como isError', async () => {
    await withHarness({}, async (harness) => {
      const result = await call(harness, 'call_procedure', {
        schema: DEVUSER,
        name: 'P',
        args: '{"name":"P"',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('Invalid args JSON');
    });
  });

  it('tipo compuesto (BOOLEAN) se rechaza con la guía del Java', async () => {
    await withHarness({}, async (harness) => {
      const result = await call(harness, 'call_procedure', {
        schema: DEVUSER,
        name: 'P',
        args: '[{"name":"P_FLAG","direction":"IN","dataType":"BOOLEAN","value":1}]',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain(
        "argument 'P_FLAG' of type 'BOOLEAN' is not bindable",
      );
      expect(result.content[0]?.text).toContain('wrapper subprogram');
    });
  });

  it('returnType compuesto de función se rechaza igual (label return type)', async () => {
    await withHarness({}, async (harness) => {
      const result = await call(harness, 'call_procedure', {
        schema: DEVUSER,
        name: 'FN',
        args: '[]',
        isFunction: true,
        returnType: 'PL/SQL BOOLEAN',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain(
        "return type of type 'PL/SQL BOOLEAN' is not bindable",
      );
    });
  });

  it('REF CURSOR queda como pendiente del chokepoint: isError explícito', async () => {
    await withHarness({}, async (harness) => {
      const result = await call(harness, 'call_procedure', {
        schema: DEVUSER,
        name: 'P',
        args: '[{"name":"P_C","direction":"OUT","dataType":"REF CURSOR"}]',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('REF CURSOR');
    });
  });

  it('returnType REF CURSOR de función: isError explícito', async () => {
    await withHarness({}, async (harness) => {
      const result = await call(harness, 'call_procedure', {
        schema: DEVUSER,
        name: 'FN',
        args: '[]',
        isFunction: true,
        returnType: 'REF CURSOR',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('REF CURSOR');
    });
  });

  it('identificador inválido en name se rechaza por la allow-list', async () => {
    await withHarness({}, async (harness) => {
      const result = await call(harness, 'call_procedure', {
        schema: DEVUSER,
        name: 'P; DROP TABLE EMPLOYEES',
        args: '[]',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('inválido');
    });
  });

  it('error de ejecución PL/SQL llega como isError (ORA del bloque)', async () => {
    await withHarness({}, async (harness) => {
      harness.dataAccess.alwaysFail(
        new DataAccessError('ORA-06550: line 1, column 7', 'ORA-06550'),
      );
      const result = await call(harness, 'call_procedure', {
        schema: DEVUSER,
        name: 'ADD_EMPLOYEE',
        args: IN_ARGS,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('ORA-06550');
    });
  });
});

describe('recurso oracle://schema/{schema}/plsql/{object}', () => {
  it('sirve la fuente con la cabecera -- schema.object', async () => {
    await withHarness({}, async (harness) => {
      onDescribe(harness.dataAccess, [], 'PROCEDURE add_employee (');
      const resource = await harness.client.readResource({
        uri: `oracle://schema/${DEVUSER}/plsql/ADD_EMPLOYEE`,
      });
      expect(text(resource)).toBe(`-- ${DEVUSER}.ADD_EMPLOYEE\n\nPROCEDURE add_employee (\n`);
    });
  });

  it('sin fuente: mensaje del Java de objeto inexistente', async () => {
    await withHarness({}, async (harness) => {
      onDescribe(harness.dataAccess, [], '');
      const resource = await harness.client.readResource({
        uri: `oracle://schema/${DEVUSER}/plsql/NOPE`,
      });
      expect(text(resource)).toBe(
        `(No PL/SQL source found for ${DEVUSER}.NOPE — the object may not exist or is not a PL/SQL object.)`,
      );
    });
  });

  it('error de BD: mensaje del Java con el texto del error', async () => {
    await withHarness({}, async (harness) => {
      harness.dataAccess.alwaysFail(new DataAccessError('ORA-00942', 'ORA-00942'));
      const resource = await harness.client.readResource({
        uri: `oracle://schema/${DEVUSER}/plsql/X`,
      });
      expect(text(resource)).toContain(`(Database error reading PL/SQL source for ${DEVUSER}.X:`);
    });
  });
});
