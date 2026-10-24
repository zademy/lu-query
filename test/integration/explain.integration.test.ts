import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { loadConfig } from '../../src/config.js';
import { createServer, type ServerHandle } from '../../src/server.js';

/**
 * Integration de explain_plan / suggest_index / list_unused_indexes /
 * run_sql_tuning_advisor contra el contenedor Oracle real.
 *
 * Requiere el setup de `scripts/test-grants-explain.sql` (PLAN_TABLE propia,
 * SELECT en V_$OBJECT_USAGE, MONITORING USAGE y privilegio ADVISOR), que este
 * mismo test aplica como SYSTEM antes de empezar.
 *
 *   LU_TEST_INTEGRATION=1 \
 *   ORACLE_DB_URL='jdbc:oracle:thin:@//localhost:1521/FREEPDB1' \
 *   ORACLE_DB_USERNAME=DEVUSER ORACLE_DB_PASSWORD=DevPassword123 npm run test:integration
 */
const optIn = process.env.LU_TEST_INTEGRATION === '1';

const GOOD_ENV: NodeJS.ProcessEnv = {
  ORACLE_DB_URL: process.env.ORACLE_DB_URL ?? 'jdbc:oracle:thin:@//localhost:1521/FREEPDB1',
  ORACLE_DB_USERNAME: process.env.ORACLE_DB_USERNAME ?? 'DEVUSER',
  ORACLE_DB_PASSWORD: process.env.ORACLE_DB_PASSWORD ?? 'DevPassword123',
  // list_unused_indexes sin schema explícito usa el de la sesión.
  ORACLE_DB_SCHEMA: process.env.ORACLE_DB_SCHEMA ?? process.env.ORACLE_DB_USERNAME ?? 'DEVUSER',
};

/** Contenedor y credencial de SYSTEM: solo hacen falta para el setup de grants. */
const CONTAINER = process.env.ORACLE_TEST_CONTAINER ?? 'oracle-26ai-free';
const SYSTEM_PASSWORD = process.env.ORACLE_TEST_SYSTEM_PASSWORD ?? 'OraclePassword123';
const GRANTS_SCRIPT = fileURLToPath(
  new URL('../../scripts/test-grants-explain.sql', import.meta.url),
);

/** DEPARTMENTS solo tiene índice en su PK (DEPT_ID): filtrar por DEPT_NAME fuerza full scan. */
const UNINDEXED_TABLE = 'DEPARTMENTS';
/** SELECT con acceso por índice: no debe proponer nada. */
const INDEXED_SELECT = 'SELECT * FROM EMPLOYEES WHERE emp_id = 1';
/** SELECT sobre una columna sin índice: el plan debe salir con TABLE ACCESS FULL. */
const UNINDEXED_SELECT = `SELECT * FROM ${UNINDEXED_TABLE} WHERE dept_name = 'Engineering'`;

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

/** Aplica el script de grants con sqlplus de SYSTEM dentro del contenedor. */
function applyGrants(): string {
  return execFileSync(
    'docker',
    ['exec', '-i', CONTAINER, 'bash', '-c', `sqlplus -s system/${SYSTEM_PASSWORD}@FREEPDB1`],
    {
      input: readFileSync(GRANTS_SCRIPT, 'utf8'),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
}

describe.skipIf(!optIn)('explain plan + index advisor contra Oracle real', () => {
  let handle: ServerHandle;
  let client: Client;

  beforeAll(async () => {
    const setup = applyGrants();
    expect(setup).not.toMatch(/ORA-\d{5}/);

    handle = createServer({ config: loadConfig(GOOD_ENV) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'lu-query-explain-integration', version: '0.0.0' });
    await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await handle.close();
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as ToolResult;

  const text = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const result = await call(name, args);
    expect(result.isError, result.content[0]?.text).toBeFalsy();
    return result.content[0]?.text ?? '';
  };

  const rows = async <T>(sql: string): Promise<T[]> => {
    const raw = await text('run_query', { sql });
    return JSON.parse(raw).rows as T[];
  };

  const countEmployees = async (): Promise<number> => {
    const [row] = await rows<{ TOTAL: number }>('SELECT COUNT(*) AS total FROM EMPLOYEES');
    return Number(row?.TOTAL ?? 0);
  };

  it('explain_plan devuelve el plan real de DBMS_XPLAN sobre el esquema sample', async () => {
    const plan = await text('explain_plan', { sql: INDEXED_SELECT });

    expect(plan).toContain('Plan hash value');
    expect(plan).toContain('EMPLOYEES');
    expect(plan).toContain('INDEX UNIQUE SCAN');
    expect(plan).toContain('"EMP_ID"=1');
  });

  it('explain_plan no ejecuta el SQL: un DELETE planificado deja la tabla intacta', async () => {
    const before = await countEmployees();

    const plan = await text('explain_plan', { sql: 'DELETE FROM EMPLOYEES WHERE emp_id = -1' });

    expect(plan).toContain('DELETE STATEMENT');
    expect(await countEmployees()).toBe(before);
  });

  it('explain_plan borra su fila del PLAN_TABLE y no deja rastro', async () => {
    const planRows = async (): Promise<number> => {
      const [row] = await rows<{ LEFT: number }>(
        "SELECT COUNT(*) AS left FROM PLAN_TABLE WHERE statement_id LIKE 'mcp%'",
      );
      return Number(row?.LEFT ?? 0);
    };
    const before = await planRows();

    await text('explain_plan', { sql: INDEXED_SELECT });

    expect(await planRows()).toBe(before);
  });

  it('suggest_index detecta el full scan y propone el CREATE INDEX', async () => {
    const suggestion = JSON.parse(await text('suggest_index', { sql: UNINDEXED_SELECT })) as Record<
      string,
      unknown
    >;

    expect(suggestion).toMatchObject({
      hasCandidates: true,
      schema: 'DEVUSER',
      table: UNINDEXED_TABLE,
      accessProblem: 'TABLE ACCESS FULL',
      predicateColumns: ['DEPT_NAME'],
    });
    expect(suggestion.recommendedDdl).toBe(
      `CREATE INDEX "DEVUSER"."IX_DEPARTMENTS_DEPT_NAME" ON "DEVUSER"."DEPARTMENTS" ("DEPT_NAME")`,
    );
  });

  it('suggest_index no propone nada cuando el plan ya usa un índice', async () => {
    const suggestion = JSON.parse(await text('suggest_index', { sql: INDEXED_SELECT })) as Record<
      string,
      unknown
    >;

    expect(suggestion.hasCandidates).toBe(false);
    expect(suggestion.recommendedDdl).toBeNull();
    expect(suggestion.reasoning).toContain('already uses indexes');
  });

  it('suggest_index filtra por la tabla pedida con targetTable', async () => {
    const suggestion = JSON.parse(
      await text('suggest_index', {
        sql: `SELECT e.emp_id FROM EMPLOYEES e, ${UNINDEXED_TABLE} d WHERE d.dept_name = 'Engineering'`,
        targetTable: UNINDEXED_TABLE,
      }),
    ) as Record<string, unknown>;

    expect(suggestion.table).toBe(UNINDEXED_TABLE);
  });

  it('list_unused_indexes devuelve los índices del usuario con likely_unused', async () => {
    const indexes = JSON.parse(await text('list_unused_indexes', {})) as Array<
      Record<string, unknown>
    >;

    expect(indexes.length).toBeGreaterThan(0);
    for (const index of indexes) {
      expect(index.TABLE_OWNER).toBe('DEVUSER');
      expect(['YES', 'NO', 'UNKNOWN']).toContain(index.LIKELY_UNUSED);
    }
    // Con MONITORING USAGE encendido el flag deja de ser UNKNOWN.
    expect(indexes.some((index) => index.LIKELY_UNUSED !== 'UNKNOWN')).toBe(true);
  });

  it('list_unused_indexes filtra por el schema explícito', async () => {
    const indexes = JSON.parse(await text('list_unused_indexes', { schema: 'SYS' })) as Array<
      Record<string, unknown>
    >;

    expect(indexes.every((index) => index.TABLE_OWNER === 'SYS')).toBe(true);
  });

  it('run_sql_tuning_advisor devuelve el reporte TEXT y borra la task', async () => {
    const report = await text('run_sql_tuning_advisor', { sql: UNINDEXED_SELECT });

    expect(report.length).toBeGreaterThan(0);
    expect(report).toContain('GENERAL INFORMATION SECTION');

    const [row] = await rows<{ TASKS: number }>(
      "SELECT COUNT(*) AS tasks FROM USER_ADVISOR_TASKS WHERE task_name LIKE 'mcp_sta%'",
    );

    expect(Number(row?.TASKS ?? 1)).toBe(0);
  }, 120_000);
});
