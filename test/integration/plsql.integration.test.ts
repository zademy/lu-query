import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createServer, type ServerHandle } from '../../src/server.js';

/**
 * PL/SQL end-to-end contra el contenedor Oracle real: describe, llamada IN,
 * función, OUT/INOUT vía wrapper y el recurso de fuente.
 *   LU_TEST_INTEGRATION=1 \
 *   ORACLE_DB_URL='jdbc:oracle:thin:@//localhost:1521/FREEPDB1' \
 *   ORACLE_DB_USERNAME=DEVUSER ORACLE_DB_PASSWORD=DevPassword123 npm run test:integration
 */
const optIn = process.env.LU_TEST_INTEGRATION === '1';

const GOOD_ENV: NodeJS.ProcessEnv = {
  ORACLE_DB_URL: process.env.ORACLE_DB_URL ?? 'jdbc:oracle:thin:@//localhost:1521/FREEPDB1',
  ORACLE_DB_USERNAME: process.env.ORACLE_DB_USERNAME ?? 'DEVUSER',
  ORACLE_DB_PASSWORD: process.env.ORACLE_DB_PASSWORD ?? 'DevPassword123',
  ORACLE_DB_SCHEMA: process.env.ORACLE_DB_SCHEMA ?? process.env.ORACLE_DB_USERNAME ?? 'DEVUSER',
};

const SCHEMA = GOOD_ENV.ORACLE_DB_USERNAME!;
const RO_PROC = 'T11_PLSQL_IT_RO';
const PROBE_EMAIL = 't11-it@lu-query.test';
const CUR_PROC = 'T11_PLSQL_IT_CUR';
const CUR_FN = 'T11_PLSQL_IT_FNC';
const DML_TABLE = 'T11_PLSQL_IT_TAB';
const DML_PROC = 'T11_PLSQL_IT_DML';

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

describe.skipIf(!optIn)('PL/SQL contra Oracle real', () => {
  let handle: ServerHandle;
  let client: Client;
  let auditDir: string;

  beforeAll(async () => {
    // Auditoría activa (default) hacia un dir temporal: el test de errores PL/SQL
    // afirma que el fallo queda en el log de la sesión.
    auditDir = await mkdtemp(join(tmpdir(), 'lu-query-plsql-it-'));
    handle = createServer({ config: loadConfig({ ...GOOD_ENV, MCP_AUDIT_DIR: auditDir }) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'lu-query-plsql-integration', version: '0.0.0' });
    await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);

    const db = handle.context.dataAccess;
    await db.execute(`DROP PROCEDURE ${CUR_PROC}`).catch(() => undefined);
    await db.execute(
      `CREATE PROCEDURE ${CUR_PROC} (P_C OUT SYS_REFCURSOR) IS
       BEGIN
         OPEN P_C FOR SELECT EMP_ID FROM EMPLOYEES ORDER BY EMP_ID;
       END;`,
    );
    await db.execute(`DROP FUNCTION ${CUR_FN}`).catch(() => undefined);
    await db.execute(
      `CREATE FUNCTION ${CUR_FN} RETURN SYS_REFCURSOR IS
         L_C SYS_REFCURSOR;
       BEGIN
         OPEN L_C FOR SELECT EMP_ID FROM EMPLOYEES ORDER BY EMP_ID;
         RETURN L_C;
       END;`,
    );
    await db.execute(`DROP TABLE ${DML_TABLE}`).catch(() => undefined);
    await db.execute(`CREATE TABLE ${DML_TABLE} (N NUMBER)`);
    await db.execute(`DROP PROCEDURE ${DML_PROC}`).catch(() => undefined);
    await db.execute(
      `CREATE PROCEDURE ${DML_PROC} (P_ID IN NUMBER, P_N OUT NUMBER) IS
       BEGIN
         INSERT INTO ${DML_TABLE} (N) VALUES (P_ID);
         P_N := SQL%ROWCOUNT;
       END;`,
    );
    await db.execute(`DROP PROCEDURE ${RO_PROC}`).catch(() => undefined);
    await db.execute(
      `CREATE PROCEDURE ${RO_PROC} (P_ID IN NUMBER, P_OUT OUT VARCHAR2, P_IO IN OUT NUMBER) IS
       BEGIN
         P_OUT := 'out:' || P_ID;
         P_IO := P_IO * 10;
       END;`,
    );
    await db.execute(`DELETE FROM EMPLOYEES WHERE EMAIL = :1`, [PROBE_EMAIL]);
  });

  afterAll(async () => {
    const db = handle.context.dataAccess;
    await db
      .execute(`DELETE FROM EMPLOYEES WHERE EMAIL = :1`, [PROBE_EMAIL])
      .catch(() => undefined);
    await db.execute(`DROP PROCEDURE ${CUR_PROC}`).catch(() => undefined);
    await db.execute(`DROP FUNCTION ${CUR_FN}`).catch(() => undefined);
    await db.execute(`DROP TABLE ${DML_TABLE}`).catch(() => undefined);
    await db.execute(`DROP PROCEDURE ${DML_PROC}`).catch(() => undefined);
    await db.execute(`DROP PROCEDURE ${RO_PROC}`).catch(() => undefined);
    await client.close();
    await handle.close();
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const result = (await client.callTool({ name, arguments: args })) as ToolResult;
    expect(result.isError, `${name} falló: ${result.content[0]?.text}`).toBeFalsy();
    return result;
  };

  const employeeCount = async (): Promise<number> => {
    const db = handle.context.dataAccess;
    const rows = await db.queryForList('SELECT COUNT(*) AS N FROM EMPLOYEES');
    return Number(rows[0]?.N);
  };

  it('describe_plsql trae los 5 argumentos de ADD_EMPLOYEE y su fuente', async () => {
    const result = await call('describe_plsql', { schema: SCHEMA, name: 'ADD_EMPLOYEE' });
    const described = JSON.parse(result.content[0]?.text ?? '') as {
      schema: string;
      source: string;
      arguments: { ARGUMENT_NAME: string; DATA_TYPE: string; IN_OUT: string; POSITION: number }[];
    };
    expect(described.schema).toBe(SCHEMA);
    expect(described.arguments).toHaveLength(5);
    expect(described.arguments[0]).toMatchObject({
      ARGUMENT_NAME: 'P_FIRST_NAME',
      DATA_TYPE: 'VARCHAR2',
      IN_OUT: 'IN',
      POSITION: 1,
    });
    expect(described.source.trimStart().startsWith('PROCEDURE')).toBe(true);
    expect(described.source).toContain('p_salary');
  });

  it('call_procedure ejecuta ADD_EMPLOYEE (solo IN) y el INSERT persiste', async () => {
    const before = await employeeCount();
    const result = await call('call_procedure', {
      schema: SCHEMA,
      name: 'ADD_EMPLOYEE',
      args: JSON.stringify([
        { name: 'P_FIRST_NAME', direction: 'IN', dataType: 'VARCHAR2', value: 'T11' },
        { name: 'P_LAST_NAME', direction: 'IN', dataType: 'VARCHAR2', value: 'Integration' },
        { name: 'P_EMAIL', direction: 'IN', dataType: 'VARCHAR2', value: PROBE_EMAIL },
        { name: 'P_DEPT_ID', direction: 'IN', dataType: 'NUMBER', value: 1 },
        { name: 'P_SALARY', direction: 'IN', dataType: 'NUMBER', value: 100 },
      ]),
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      outParams: {},
      returnValue: null,
      cursorResult: null,
    });
    expect(await employeeCount()).toBe(before + 1);
  });

  it('call_procedure con isFunction devuelve returnValue (GET_EMPLOYEE_COUNT)', async () => {
    const result = await call('call_procedure', {
      schema: SCHEMA,
      name: 'GET_EMPLOYEE_COUNT',
      args: '[]',
      isFunction: true,
      returnType: 'NUMBER',
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      outParams: {},
      returnValue: await employeeCount(),
      cursorResult: null,
    });
  });

  it('call_procedure recupera OUT/INOUT escalares vía binds nativos de salida', async () => {
    const result = await call('call_procedure', {
      schema: SCHEMA,
      name: RO_PROC,
      args: JSON.stringify([
        { name: 'P_ID', direction: 'IN', dataType: 'NUMBER', value: 7 },
        { name: 'P_OUT', direction: 'OUT', dataType: 'VARCHAR2' },
        { name: 'P_IO', direction: 'INOUT', dataType: 'NUMBER', value: 3 },
      ]),
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      outParams: { P_OUT: 'out:7', P_IO: 30 },
      returnValue: null,
      cursorResult: null,
    });
  });

  it('REF CURSOR OUT: cursorResult trae las filas fetcheadas', async () => {
    const result = await call('call_procedure', {
      schema: SCHEMA,
      name: CUR_PROC,
      args: JSON.stringify([{ name: 'P_C', direction: 'OUT', dataType: 'REF CURSOR' }]),
    });
    const parsed = JSON.parse(result.content[0]?.text ?? '') as {
      cursorResult: { EMP_ID: number }[];
    };
    expect(Array.isArray(parsed.cursorResult)).toBe(true);
    expect(parsed.cursorResult.length).toBeGreaterThan(0);
    expect(parsed.cursorResult[0]).toHaveProperty('EMP_ID');
  });

  it('función que devuelve REF CURSOR: cursorResult con filas', async () => {
    const result = await call('call_procedure', {
      schema: SCHEMA,
      name: CUR_FN,
      args: '[]',
      isFunction: true,
      returnType: 'REF CURSOR',
    });
    const parsed = JSON.parse(result.content[0]?.text ?? '') as { cursorResult: unknown[] };
    expect(Array.isArray(parsed.cursorResult)).toBe(true);
    expect(parsed.cursorResult.length).toBeGreaterThan(0);
  });

  it('OUT con DML: el INSERT persiste y el OUT vuelve (antes ORA-14551)', async () => {
    const result = await call('call_procedure', {
      schema: SCHEMA,
      name: DML_PROC,
      args: JSON.stringify([
        { name: 'P_ID', direction: 'IN', dataType: 'NUMBER', value: 42 },
        { name: 'P_N', direction: 'OUT', dataType: 'NUMBER' },
      ]),
    });
    const parsed = JSON.parse(result.content[0]?.text ?? '') as { outParams: { P_N: number } };
    expect(parsed.outParams.P_N).toBe(1);
    const rows = await handle.context.dataAccess.queryForList(
      'SELECT COUNT(*) AS N FROM ' + DML_TABLE + ' WHERE N = :1',
      [42],
    );
    expect(Number(rows[0]?.N)).toBe(1);
  });

  it('un error PL/SQL llega como isError y queda auditado en la sesión', async () => {
    const result = (await client.callTool({
      name: 'call_procedure',
      arguments: { schema: SCHEMA, name: 'T11_PLSQL_NO_EXISTE', args: '[]' },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('ORA-');

    const current = await client.readResource({ uri: 'oracle://audit/session/current' });
    const markdown = String((current.contents[0] as { text?: string }).text);
    expect(markdown).toContain('BEGIN "DEVUSER"."T11_PLSQL_NO_EXISTE"(); END;');
  });

  it('el recurso plsql-source sirve la fuente con cabecera', async () => {
    const resource = await client.readResource({
      uri: `oracle://schema/${SCHEMA}/plsql/ADD_EMPLOYEE`,
    });
    const text = String((resource.contents[0] as { text?: string }).text);
    expect(text.startsWith(`-- ${SCHEMA}.ADD_EMPLOYEE\n\nPROCEDURE`)).toBe(true);
    expect(text).toContain('p_salary');
  });

  it('el recurso de un objeto inexistente explica que no hay fuente', async () => {
    const resource = await client.readResource({
      uri: `oracle://schema/${SCHEMA}/plsql/NO_EXISTE`,
    });
    const text = String((resource.contents[0] as { text?: string }).text);
    expect(text).toBe(
      `(No PL/SQL source found for ${SCHEMA}.NO_EXISTE — the object may not exist or is not a PL/SQL object.)`,
    );
  });
});
