import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import type { DataAccess } from '../../src/db/data-access.js';
import { createServer, type ServerHandle } from '../../src/server.js';

/**
 * Integration del SQL avanzado contra el contenedor Oracle real: joins de dos y
 * de tres tablas, outer joins, window functions, CTE, conjuntos, hints de
 * paralelismo y la paginacion encima de un join.
 *
 * Esto importa porque el Kind de una sentencia lo decide node-sql-parser con
 * dialecto PostgreSQL (ADR-0003): si un join o un hint no se clasifican como
 * SELECT, la Barrera de minimos privilegios puede rechazar una consulta
 * legitima, y la paginacion tiene que reescribir el join sin romperlo.
 *   LU_TEST_INTEGRATION=1 \
 *   ORACLE_DB_URL='jdbc:oracle:thin:@//localhost:1521/FREEPDB1' \
 *   ORACLE_DB_USERNAME=DEVUSER ORACLE_DB_PASSWORD=DevPassword123 npm run test:integration
 */
const optIn = process.env.LU_TEST_INTEGRATION === '1';

const GOOD_ENV: NodeJS.ProcessEnv = {
  ORACLE_DB_URL: process.env.ORACLE_DB_URL ?? 'jdbc:oracle:thin:@//localhost:1521/FREEPDB1',
  ORACLE_DB_USERNAME: process.env.ORACLE_DB_USERNAME ?? 'DEVUSER',
  ORACLE_DB_PASSWORD: process.env.ORACLE_DB_PASSWORD ?? 'DevPassword123',
};

/** Tablas propias del test con prefijo T92_: nunca una tabla de ejemplo. */
const DEPT = 'T92_IT_DEPT';
const EMP = 'T92_IT_EMP';
const PROJ = 'T92_IT_PROJ';

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  rowLimit: number;
  offset: number;
  limit: number;
}

describe.skipIf(!optIn)('SQL avanzado contra Oracle real', () => {
  let handle: ServerHandle;
  let client: Client;
  let db: DataAccess;
  let auditDir: string;

  beforeAll(async () => {
    auditDir = await mkdtemp(join(tmpdir(), 'lu-query-advanced-it-'));
    handle = createServer({ config: loadConfig({ ...GOOD_ENV, MCP_AUDIT_DIR: auditDir }) });
    db = handle.context.dataAccess;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'lu-query-advanced-integration', version: '0.0.0' });
    await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);

    await db.execute('CREATE TABLE ' + DEPT + ' (DEPT_ID NUMBER PRIMARY KEY, DEPT_NAME VARCHAR2(30))');
    await db.execute(
      'CREATE TABLE ' + EMP + ' (EMP_ID NUMBER PRIMARY KEY, EMP_NAME VARCHAR2(30), DEPT_ID NUMBER, SALARY NUMBER)',
    );
    await db.execute(
      'CREATE TABLE ' + PROJ + ' (PROJ_ID NUMBER PRIMARY KEY, EMP_ID NUMBER, PROJ_NAME VARCHAR2(30))',
    );
    // 3 departamentos, 4 con empleados, 1 sin ninguno.
    await db.execute(
      "INSERT INTO " + DEPT + " SELECT LEVEL, 'dept' || LEVEL FROM DUAL CONNECT BY LEVEL <= 3",
    );
    // 5 empleados: 4 con departamento (uno sin proyectos) y 1 sin departamento.
    // 5 empleados: 2 en dept1, 2 en dept2 y 1 sin departamento.
    await db.execute(
      "INSERT INTO " + EMP + " (EMP_ID, EMP_NAME, DEPT_ID, SALARY) SELECT LEVEL, 'emp' || LEVEL," +
        " CASE WHEN LEVEL <= 2 THEN 1 WHEN LEVEL <= 4 THEN 2 ELSE NULL END," +
        " CASE WHEN LEVEL = 3 THEN NULL ELSE LEVEL * 100 END" +
        " FROM DUAL CONNECT BY LEVEL <= 5",
    );
    // 3 proyectos: 2 del empleado 1 y 1 del empleado 2.
    await db.execute(
      "INSERT INTO " + PROJ + " SELECT LEVEL, CASE WHEN LEVEL <= 2 THEN 1 ELSE 2 END, 'proj' || LEVEL" +
        " FROM DUAL CONNECT BY LEVEL <= 3",
    );
  }, 120_000);

  afterAll(async () => {
    for (const sql of [
      'DROP TABLE ' + PROJ + ' PURGE',
      'DROP TABLE ' + EMP + ' PURGE',
      'DROP TABLE ' + DEPT + ' PURGE',
    ]) {
      await db.execute(sql).catch(() => undefined);
    }
    await client.close();
    await handle.close();
    await rm(auditDir, { recursive: true, force: true });
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as ToolResult;

  const query = async (sql: string, extra: Record<string, unknown> = {}): Promise<QueryResult> => {
    const resultado = await call('run_query', { sql, ...extra });
    if (resultado.isError) throw new Error(sql + ' => ' + (resultado.content[0]?.text ?? 'sin texto'));
    return JSON.parse(resultado.content[0]?.text ?? '{}') as QueryResult;
  };

  it('INNER JOIN devuelve solo las filas que emparejan', async () => {
    const resultado = await query(
      'SELECT e.EMP_ID, d.DEPT_NAME FROM ' + EMP + ' e INNER JOIN ' + DEPT + ' d ON e.DEPT_ID = d.DEPT_ID' +
        ' ORDER BY e.EMP_ID',
    );
    expect(resultado.rowCount).toBe(4);
    expect(resultado.columns).toEqual(['EMP_ID', 'DEPT_NAME']);
    // El empleado sin departamento (EMP_ID 5) no aparece.
    expect(resultado.rows.map((r) => r.EMP_ID)).not.toContain(5);
  });

  it('LEFT OUTER JOIN conserva el empleado sin departamento', async () => {
    const resultado = await query(
      'SELECT e.EMP_ID, d.DEPT_NAME FROM ' + EMP + ' e LEFT OUTER JOIN ' + DEPT +
        ' d ON e.DEPT_ID = d.DEPT_ID ORDER BY e.EMP_ID',
    );
    expect(resultado.rowCount).toBe(5);
    const huerfano = resultado.rows.find((r) => r.EMP_ID === 5);
    expect(huerfano).toBeDefined();
    expect(huerfano?.DEPT_NAME).toBeNull();
  });

  it('RIGHT OUTER JOIN conserva el lado derecho', async () => {
    // RIGHT conserva la tabla derecha: con DEPT a la izquierda, se quedan los
    // 5 empleados y el departamento sin empleados se pierde.
    const empleados = await query(
      'SELECT d.DEPT_ID, e.EMP_ID FROM ' + DEPT + ' d RIGHT OUTER JOIN ' + EMP +
        ' e ON e.DEPT_ID = d.DEPT_ID ORDER BY d.DEPT_ID',
    );
    expect(empleados.rowCount).toBe(5);

    // Invirtiendo los operandos, RIGHT conserva los departamentos: 4 empleados
    // emparejados + el departamento sin ellos. El empleado sin departamento se
    // pierde, porque RIGHT solo conserva las filas sin pareja de la derecha.
    const departamentos = await query(
      'SELECT e.EMP_ID, d.DEPT_ID FROM ' + EMP + ' e RIGHT OUTER JOIN ' + DEPT +
        ' d ON e.DEPT_ID = d.DEPT_ID ORDER BY d.DEPT_ID',
    );
    expect(departamentos.rowCount).toBe(5);
    const vacio = departamentos.rows.find((r) => r.DEPT_ID === 3 && r.EMP_ID === null);
    expect(vacio).toBeDefined();
  });

  it('FULL OUTER JOIN conserva los dos lados', async () => {
    const resultado = await query(
      'SELECT d.DEPT_ID, e.EMP_ID FROM ' + DEPT + ' d FULL OUTER JOIN ' + EMP +
        ' e ON e.DEPT_ID = d.DEPT_ID',
    );
    // 4 emparejados + 1 empleado sin depto + 1 depto sin empleados.
    expect(resultado.rowCount).toBe(6);
  });

  it('CROSS JOIN da el producto cartesiano', async () => {
    const resultado = await query(
      'SELECT d.DEPT_ID, e.EMP_ID FROM ' + DEPT + ' d CROSS JOIN ' + EMP + ' e',
    );
    expect(resultado.rowCount).toBe(3 * 5);
  });

  it('join de tres tablas con GROUP BY, HAVING y ORDER BY', async () => {
    const resultado = await query(
      'SELECT d.DEPT_NAME, COUNT(p.PROJ_ID) AS PROYECTOS FROM ' + DEPT + ' d' +
        ' JOIN ' + EMP + ' e ON e.DEPT_ID = d.DEPT_ID' +
        ' LEFT JOIN ' + PROJ + ' p ON p.EMP_ID = e.EMP_ID' +
        ' GROUP BY d.DEPT_NAME HAVING COUNT(p.PROJ_ID) > 0 ORDER BY d.DEPT_NAME',
    );
    // Solo dept1 tiene proyectos: 2 del empleado 1 y 1 del empleado 2.
    expect(resultado.rowCount).toBe(1);
    expect(resultado.columns).toContain('PROYECTOS');
    expect(Number(resultado.rows[0]?.PROYECTOS)).toBe(3);
  });

  it('INNER JOIN con subquery correlacionado', async () => {
    const resultado = await query(
      'SELECT e.EMP_ID FROM ' + EMP + ' e WHERE e.DEPT_ID IN (SELECT d.DEPT_ID FROM ' + DEPT +
        " d WHERE d.DEPT_NAME = 'dept1') ORDER BY e.EMP_ID",
    );
    expect(resultado.rowCount).toBe(2);
    expect(resultado.rows.map((r) => r.EMP_ID)).toEqual([1, 2]);
  });

  it.each([
    ['UNION ALL', 'SELECT EMP_ID FROM ' + EMP + ' UNION ALL SELECT EMP_ID FROM ' + EMP, 10],
    ['UNION', 'SELECT EMP_ID FROM ' + EMP + ' UNION SELECT EMP_ID FROM ' + EMP, 5],
    ['MINUS', 'SELECT EMP_ID FROM ' + EMP + ' MINUS SELECT EMP_ID FROM ' + EMP + ' WHERE EMP_ID > 2', 2],
    [
      'INTERSECT',
      'SELECT EMP_ID FROM ' + EMP + ' INTERSECT SELECT EMP_ID FROM ' + EMP + ' WHERE EMP_ID <= 2',
      2,
    ],
  ])('%s devuelve el numero de filas esperado', async (_nombre, sql, esperado) => {
    expect((await query(sql)).rowCount).toBe(esperado);
  });

  it('window function con PARTITION BY', async () => {
    const resultado = await query(
      'SELECT EMP_ID, DEPT_ID, ROW_NUMBER() OVER (PARTITION BY DEPT_ID ORDER BY SALARY DESC) AS RN' +
        ' FROM ' + EMP + ' ORDER BY EMP_ID',
    );
    expect(resultado.rowCount).toBe(5);
    expect(resultado.columns).toContain('RN');
  });

  it('CTE con WITH', async () => {
    const resultado = await query(
      'WITH PAGADOS AS (SELECT EMP_ID, SALARY FROM ' + EMP + ' WHERE SALARY IS NOT NULL)' +
        ' SELECT COUNT(*) AS N FROM PAGADOS',
    );
    expect(resultado.rowCount).toBe(1);
    expect(Number(resultado.rows[0]?.N)).toBe(4);
  });

  it('acepta hints de Oracle, incluido el de paralelismo', async () => {
    const resultado = await query(
      'SELECT /*+ PARALLEL(4) */ COUNT(*) AS N FROM ' + EMP,
    );
    expect(resultado.rowCount).toBe(1);
    expect(Number(resultado.rows[0]?.N)).toBe(5);
  });

  it('la paginacion reescribe el join sin romperlo', async () => {
    const sql =
      'SELECT e.EMP_ID, d.DEPT_NAME FROM ' + EMP + ' e JOIN ' + DEPT +
      ' d ON e.DEPT_ID = d.DEPT_ID ORDER BY e.EMP_ID';
    const primera = await query(sql, { offset: 0, limit: 2 });
    const segunda = await query(sql, { offset: 2, limit: 2 });

    expect(primera.rowCount).toBe(2);
    expect(segunda.rowCount).toBe(2);
    expect(primera.truncated).toBe(true);
    // La segunda pagina no repite filas de la primera.
    expect(segunda.rows.map((r) => r.EMP_ID)).not.toEqual(primera.rows.map((r) => r.EMP_ID));
  });

  it('la auditoria clasifica el join como SELECT de lectura', async () => {
    await query('SELECT e.EMP_ID FROM ' + EMP + ' e LEFT JOIN ' + DEPT + ' d ON e.DEPT_ID = d.DEPT_ID');
    const [file] = await readdir(auditDir);
    const markdown = await readFile(join(auditDir, file!), 'utf8');

    expect(markdown).toMatch(/### #\d+ · \d\d:\d\d:\d\d · run_query · SELECT · READ · ✅ OK/);
    expect(markdown).toContain('LEFT JOIN');
  });

  it('un UPDATE con subquery se aplica y queda confirmado', async () => {
    const dml = await call('execute_dml', {
      sql:
        'UPDATE ' + EMP + ' e SET e.SALARY = 777 WHERE e.DEPT_ID IN' +
        ' (SELECT d.DEPT_ID FROM ' + DEPT + " d WHERE d.DEPT_NAME = 'dept1')",
    });
    expect(dml.isError).toBeFalsy();

    const salaries = await query(
      'SELECT EMP_ID, SALARY FROM ' + EMP + ' WHERE SALARY = 777 ORDER BY EMP_ID',
    );
    expect(salaries.rows.map((r) => r.EMP_ID)).toEqual([1, 2]);
  });

  it('el preview de DML clasifica UPDATE y DELETE con subquery', async () => {
    const update = await call('execute_dml_preview', {
      sql:
        'UPDATE ' + EMP + ' e SET e.SALARY = 1 WHERE EXISTS (SELECT 1 FROM ' + DEPT +
        ' d WHERE d.DEPT_ID = e.DEPT_ID)',
    });
    expect(update.isError).toBeFalsy();
    expect(JSON.parse(update.content[0]?.text ?? '{}')).toMatchObject({ detectedKind: 'UPDATE' });

    const delete_ = await call('execute_dml_preview', {
      sql:
        'DELETE FROM ' + EMP + ' WHERE EMP_ID IN (SELECT EMP_ID FROM ' + EMP +
        ' WHERE SALARY IS NULL)',
    });
    expect(delete_.isError).toBeFalsy();
    expect(JSON.parse(delete_.content[0]?.text ?? '{}')).toMatchObject({ detectedKind: 'DELETE' });
  });

  it('MERGE y INSERT...SELECT se ejecutan y se revierten', async () => {
    const merge = await call('execute_dml_rollback_first', {
      sql:
        'MERGE INTO ' + EMP + ' t USING (SELECT 1 AS EMP_ID FROM DUAL) s' +
        ' ON (t.EMP_ID = s.EMP_ID) WHEN MATCHED THEN UPDATE SET t.SALARY = 0',
    });
    expect(merge.isError).toBeFalsy();
    expect(JSON.parse(merge.content[0]?.text ?? '{}')).toMatchObject({ rolledBack: true });

    const insert = await call('execute_dml_rollback_first', {
      sql: 'INSERT INTO ' + EMP + ' (EMP_ID) SELECT 90 + DEPT_ID FROM ' + DEPT,
    });
    expect(insert.isError).toBeFalsy();
    expect(JSON.parse(insert.content[0]?.text ?? '{}')).toMatchObject({ rolledBack: true });

    // Nada quedo: el rollback fue real.
    const despues = await query('SELECT COUNT(*) AS N FROM ' + EMP + ' WHERE EMP_ID = 91');
    expect(Number(despues.rows[0]?.N)).toBe(0);
  });
});
