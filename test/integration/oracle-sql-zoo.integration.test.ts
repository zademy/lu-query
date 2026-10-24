import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { loadConfig } from '../../src/config.js';
import type { DataAccess } from '../../src/db/data-access.js';
import { createServer, type ServerHandle } from '../../src/server.js';

/**
 * Integration del SQL de Oracle que la suite no tocaba: jerarquias (CONNECT BY
 * y CTE recursivo), analiticas, PIVOT/UNPIVOT, JSON, XML, fechas e intervalos,
 * vistas con CHECK OPTION y de solo lectura, vistas materializadas y los
 * caminos de error de Oracle.
 *
 * Objetos propios con prefijo T94_IT_: nunca se tocan las tablas de ejemplo.
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

const HIER = 'T94_IT_HIER';
const SALES = 'T94_IT_SALES';
const JSONT = 'T94_IT_JSON';
const XMLT = 'T94_IT_XML';
const TGT = 'T94_IT_TGT';
const V_CHK = 'T94_IT_V_CHK';
const V_RO = 'T94_IT_V_RO';
const MVB = 'T94_IT_MVB';
const MV = 'T94_IT_MV';

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

describe.skipIf(!optIn)('el SQL de Oracle por el MCP, a fondo', () => {
  let handle: ServerHandle;
  let client: Client;
  let db: DataAccess;
  let auditDir: string;

  beforeAll(async () => {
    auditDir = await mkdtemp(join(tmpdir(), 'lu-query-sqlzoo-it-'));
    handle = createServer({ config: loadConfig({ ...GOOD_ENV, MCP_AUDIT_DIR: auditDir }) });
    db = handle.context.dataAccess;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'lu-query-sqlzoo-integration', version: '0.0.0' });
    await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);

    await db.execute(
      'CREATE TABLE ' + HIER + ' (ID NUMBER PRIMARY KEY, PARENT_ID NUMBER, NAME VARCHAR2(30))',
    );
    await db.execute(
      'INSERT INTO ' +
        HIER +
        " VALUES (1, NULL, 'root'), (2, 1, 'a'), (3, 1, 'b'), (4, 2, 'a1'), (5, 4, 'a11')",
    );
    await db.execute(
      'CREATE TABLE ' +
        SALES +
        ' (ID NUMBER PRIMARY KEY, REGION VARCHAR2(10), AMT NUMBER, SOLD_AT DATE)',
    );
    await db.execute(
      'INSERT INTO ' +
        SALES +
        " VALUES (1, 'N', 10, DATE '2024-01-15'), (2, 'N', 20, DATE '2024-02-20'), " +
        "(3, 'S', 30, DATE '2024-01-05'), (4, 'S', 40, DATE '2024-03-25'), " +
        "(5, 'E', 50, DATE '2024-02-28'), (6, 'E', 60, DATE '2024-04-01')",
    );
    await db.execute('CREATE TABLE ' + JSONT + ' (ID NUMBER PRIMARY KEY, DOC JSON)');
    await db.execute(
      'INSERT INTO ' + JSONT + ' VALUES (1, \'{"nombre": "ana", "edad": 33, "tags": ["a", "b"]}\')',
    );
    await db.execute('CREATE TABLE ' + XMLT + ' (ID NUMBER PRIMARY KEY, DOC XMLTYPE)');
    await db.execute(
      'INSERT INTO ' +
        XMLT +
        ' VALUES (1, XMLTYPE(\'<root><item name="uno"/><item name="dos"/></root>\'))',
    );
    await db.execute('CREATE TABLE ' + TGT + ' (ID NUMBER PRIMARY KEY, N NUMBER)');
    await db.execute('CREATE TABLE ' + MVB + ' (ID NUMBER PRIMARY KEY, TXT VARCHAR2(20))');
    await db.execute('INSERT INTO ' + MVB + " VALUES (1, 'a'), (2, 'b')");
    await db.execute(
      'CREATE VIEW ' + V_CHK + ' AS SELECT ID, N FROM ' + TGT + ' WHERE N > 0 WITH CHECK OPTION',
    );
    await db.execute('CREATE VIEW ' + V_RO + ' AS SELECT ID FROM ' + TGT + ' WITH READ ONLY');
    await db.execute('CREATE MATERIALIZED VIEW ' + MV + ' AS SELECT ID, TXT FROM ' + MVB);
  }, 120_000);

  afterAll(async () => {
    for (const sql of [
      'DROP MATERIALIZED VIEW ' + MV,
      'DROP VIEW ' + V_CHK,
      'DROP VIEW ' + V_RO,
      'DROP TABLE ' + HIER + ' PURGE',
      'DROP TABLE ' + SALES + ' PURGE',
      'DROP TABLE ' + JSONT + ' PURGE',
      'DROP TABLE ' + XMLT + ' PURGE',
      'DROP TABLE ' + TGT + ' PURGE',
      'DROP TABLE ' + MVB + ' PURGE',
    ]) {
      await db.execute(sql).catch(() => undefined);
    }
    await client.close();
    await handle.close();
    await rm(auditDir, { recursive: true, force: true });
  });

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as ToolResult;

  const rows = async (sql: string): Promise<Record<string, unknown>[]> => {
    const resultado = await call('run_query', { sql });
    if (resultado.isError) throw new Error(resultado.content[0]?.text ?? 'error sin texto');
    return (JSON.parse(resultado.content[0]?.text ?? '{}') as { rows: Record<string, unknown>[] })
      .rows;
  };

  describe('jerarquias y recursividad', () => {
    it('CONNECT BY PRIOR devuelve el arbol con su LEVEL', async () => {
      const resultado = await rows(
        'SELECT ID, NAME, LEVEL AS LVL FROM ' +
          HIER +
          ' START WITH ID = 1 CONNECT BY PRIOR ID = PARENT_ID',
      );
      expect(resultado).toHaveLength(5);
      // CONNECT BY es en profundidad: 1, 2, 4, 5 y luego el otro hijo 3.
      expect(resultado.map((r) => Number(r.LVL))).toEqual([1, 2, 3, 4, 2]);
    });

    it('CONNECT BY con una raiz distinta acota el subarbol', async () => {
      const resultado = await rows(
        'SELECT ID, LEVEL AS LVL FROM ' +
          HIER +
          ' START WITH ID = 2 CONNECT BY PRIOR ID = PARENT_ID',
      );
      expect(resultado).toHaveLength(3);
      expect(resultado.map((r) => Number(r.LVL))).toEqual([1, 2, 3]);
    });

    it('CTE recursivo con UNION ALL', async () => {
      const resultado = await rows(
        'WITH R (ID, PARENT_ID, LVL) AS (SELECT ID, PARENT_ID, 1 AS LVL FROM ' +
          HIER +
          ' WHERE PARENT_ID IS NULL ' +
          'UNION ALL SELECT H.ID, H.PARENT_ID, R.LVL + 1 FROM ' +
          HIER +
          ' H JOIN R ON H.PARENT_ID = R.ID) ' +
          'SELECT ID, LVL FROM R ORDER BY ID',
      );
      expect(resultado).toHaveLength(5);
      expect(resultado.map((r) => Number(r.LVL))).toEqual([1, 2, 2, 3, 4]);
    });

    it('CONNECT BY PRIOR con siblings conserva el orden de Oracle', async () => {
      const resultado = await rows(
        'SELECT ID FROM ' +
          HIER +
          ' START WITH ID = 1 CONNECT BY PRIOR ID = PARENT_ID ORDER SIBLINGS BY ID',
      );
      expect(resultado.map((r) => Number(r.ID))).toEqual([1, 2, 4, 5, 3]);
    });
  });

  describe('analiticas y agregaciones', () => {
    it('LAG y LEAD sobre la serie ordenada', async () => {
      const resultado = await rows(
        'SELECT ID, AMT, LAG(AMT) OVER (ORDER BY ID) AS PREV, LEAD(AMT) OVER (ORDER BY ID) AS NEXT ' +
          'FROM ' +
          SALES +
          ' ORDER BY ID',
      );
      expect(resultado).toHaveLength(6);
      expect(resultado[0]?.PREV).toBeNull();
      expect(Number(resultado[1]?.PREV)).toBe(10);
      expect(Number(resultado[0]?.NEXT)).toBe(20);
    });

    it('RANK y NTILE reparten la serie', async () => {
      const resultado = await rows(
        'SELECT ID, RANK() OVER (ORDER BY AMT DESC) AS RNK, NTILE(2) OVER (ORDER BY ID) AS MITAD ' +
          'FROM ' +
          SALES +
          ' ORDER BY AMT DESC',
      );
      expect(resultado).toHaveLength(6);
      expect(Number(resultado[0]?.RNK)).toBe(1);
      expect(Number(resultado[5]?.RNK)).toBe(6);
      expect(new Set(resultado.map((r) => Number(r.MITAD))).size).toBe(2);
    });

    it('SUM OVER PARTITION BY totaliza por region', async () => {
      const resultado = await rows(
        'SELECT REGION, AMT, SUM(AMT) OVER (PARTITION BY REGION) AS TOTAL ' +
          'FROM ' +
          SALES +
          ' ORDER BY ID',
      );
      expect(resultado).toHaveLength(6);
      expect(Number(resultado[0]?.TOTAL)).toBe(30);
      expect(Number(resultado[2]?.TOTAL)).toBe(70);
    });

    it('LISTAGG y COUNT OVER بقيeran el agregado', async () => {
      const resultado = await rows(
        "SELECT REGION, LISTAGG(ID, ',') WITHIN GROUP (ORDER BY ID) AS IDS, " +
          'SUM(COUNT(*)) OVER (PARTITION BY REGION) AS N FROM ' +
          SALES +
          ' GROUP BY REGION ORDER BY REGION',
      );
      expect(resultado).toHaveLength(3);
      const norte = resultado.find((r) => r.REGION === 'N');
      expect(norte?.IDS).toBe('1,2');
      expect(Number(norte?.N)).toBe(2);
    });
  });

  describe('PIVOT y UNPIVOT', () => {
    it('PIVOT cruza la serie en columnas por region', async () => {
      const resultado = await rows(
        'SELECT * FROM (SELECT REGION, AMT FROM ' +
          SALES +
          ") PIVOT (SUM(AMT) FOR REGION IN ('N' AS N, 'S' AS S, 'E' AS E))",
      );
      expect(resultado).toHaveLength(1);
      expect(Number(resultado[0]?.N)).toBe(30);
      expect(Number(resultado[0]?.S)).toBe(70);
      expect(Number(resultado[0]?.E)).toBe(110);
    });

    it('UNPIVOT devuelve las filas al formato largo', async () => {
      const resultado = await rows(
        'SELECT REGION, AMT FROM (SELECT * FROM (SELECT REGION, AMT FROM ' +
          SALES +
          ') ' +
          "PIVOT (SUM(AMT) FOR REGION IN ('N' AS N, 'S' AS S))) UNPIVOT (AMT FOR REGION IN (N, S))",
      );
      expect(resultado.length).toBeGreaterThan(0);
    });
  });

  describe('JSON y XML', () => {
    it('JSON_VALUE lee un escalar del documento', async () => {
      const resultado = await rows(
        "SELECT JSON_VALUE(DOC, '$.nombre') AS NOMBRE, JSON_VALUE(DOC, '$.edad') AS EDAD FROM " +
          JSONT,
      );
      expect(resultado).toHaveLength(1);
      expect(resultado[0]?.NOMBRE).toBe('ana');
      expect(Number(resultado[0]?.EDAD)).toBe(33);
    });

    it('JSON_TABLE aplana un array', async () => {
      const resultado = await rows(
        'SELECT t.TAG FROM ' +
          JSONT +
          " j, JSON_TABLE(j.DOC, '$.tags[*]' COLUMNS(TAG VARCHAR2(10) PATH '$')) t",
      );
      expect(resultado.map((r) => r.TAG)).toEqual(['a', 'b']);
    });

    it('JSON_OBJECT arma un documento en la consulta', async () => {
      const resultado = await rows(
        "SELECT JSON_OBJECT('a' VALUE 1, 'b' VALUE 'x') AS DOC FROM DUAL",
      );
      expect(resultado).toHaveLength(1);
      expect(String(resultado[0]?.DOC)).toContain('"a"');
    });

    it('XMLTABLE recorre los nodos de un XMLTYPE', async () => {
      const resultado = await rows(
        'SELECT t.NOMBRE FROM ' +
          XMLT +
          ' x, ' +
          "XMLTABLE('/root/item' PASSING x.DOC COLUMNS NOMBRE VARCHAR2(20) PATH '@name') t",
      );
      expect(resultado.map((r) => r.NOMBRE)).toEqual(['uno', 'dos']);
    });

    it('XMLELEMENT construye XML en la consulta', async () => {
      const resultado = await rows("SELECT XMLELEMENT(saludo, 'hola') AS DOC FROM DUAL");
      expect(String(resultado[0]?.DOC)).toContain('hola');
    });
  });

  describe('fechas e intervalos', () => {
    it('EXTRACT, ADD_MONTHS y TRUNC manejan fechas', async () => {
      const resultado = await rows(
        'SELECT EXTRACT(YEAR FROM SOLD_AT) AS ANIO, EXTRACT(MONTH FROM SOLD_AT) AS MES, ' +
          "TO_CHAR(ADD_MONTHS(SOLD_AT, 1), 'YYYY-MM') AS MES_SIGUIENTE, " +
          "TO_CHAR(TRUNC(SOLD_AT, 'MM'), 'YYYY-MM-DD') AS MES_TRUNCADO " +
          'FROM ' +
          SALES +
          ' WHERE ID = 1',
      );
      expect(resultado).toHaveLength(1);
      expect(Number(resultado[0]?.ANIO)).toBe(2024);
      expect(Number(resultado[0]?.MES)).toBe(1);
      expect(resultado[0]?.MES_SIGUIENTE).toBe('2024-02');
      expect(resultado[0]?.MES_TRUNCADO).toBe('2024-01-01');
    });

    it('un INTERVAL se puede restar a una fecha', async () => {
      const resultado = await rows(
        "SELECT TO_CHAR(DATE '2024-03-15' - INTERVAL '10' DAY, 'YYYY-MM-DD') AS D FROM DUAL",
      );
      expect(resultado[0]?.D).toBe('2024-03-05');
    });

    it('el filtro por rango de fechas con binds funciona', async () => {
      const resultado = await rows(
        'SELECT ID FROM ' + SALES + " WHERE SOLD_AT >= DATE '2024-02-01' ORDER BY ID",
      );
      expect(resultado.map((r) => Number(r.ID))).toEqual([2, 4, 5, 6]);
    });
  });

  describe('expresiones', () => {
    it('CASE, DECODE, COALESCE y NULLIF', async () => {
      const resultado = await rows(
        "SELECT CASE WHEN ID = 1 THEN 'uno' ELSE 'otro' END AS CASO, " +
          "DECODE(REGION, 'N', 'norte', 'sur') AS DEC, " +
          'COALESCE(AMT, 0) AS COA, NULLIF(AMT, 10) AS NULO FROM ' +
          SALES +
          ' WHERE ID = 1',
      );
      expect(resultado[0]?.CASO).toBe('uno');
      expect(resultado[0]?.DEC).toBe('norte');
      expect(Number(resultado[0]?.COA)).toBe(10);
      expect(resultado[0]?.NULO).toBeNull();
    });

    it('REGEXP_REPLACE y REGEXP_SUBSTR limpian texto', async () => {
      const resultado = await rows(
        "SELECT REGEXP_REPLACE('a1b2', '[0-9]', '') AS LIMPIO, " +
          "REGEXP_SUBSTR('abc-123', '[0-9]+') AS NUM FROM DUAL",
      );
      expect(resultado[0]?.LIMPIO).toBe('ab');
      expect(resultado[0]?.NUM).toBe('123');
    });
  });

  describe('vistas y vistas materializadas', () => {
    it('una vista con CHECK OPTION rechaza lo que no cumple', async () => {
      const resultado = await call('execute_dml', {
        sql: 'INSERT INTO ' + V_CHK + ' (ID, N) VALUES (1, -5)',
      });
      expect(resultado.isError).toBe(true);
      expect(resultado.content[0]?.text).toMatch(/02290|CHECK|check/i);
    });

    it('una vista de solo lectura rechaza el INSERT', async () => {
      const resultado = await call('execute_dml', {
        sql: 'INSERT INTO ' + V_RO + ' (ID) VALUES (1)',
      });
      expect(resultado.isError).toBe(true);
      expect(resultado.content[0]?.text).toMatch(/02000|read-only|solo lectura/i);
    });

    it('una vista materializada se refresca y se lee', async () => {
      await db.execute('INSERT INTO ' + MVB + " VALUES (3, 'c')");
      await db.execute("BEGIN DBMS_MVIEW.REFRESH('" + MV + "'); END;");

      const resultado = await rows('SELECT ID, TXT FROM ' + MV + ' ORDER BY ID');
      expect(resultado).toHaveLength(3);
      expect(resultado[2]?.TXT).toBe('c');
    });

    it('list_views y list_materialized_views las ven a las dos', async () => {
      const vistas = await call('list_views', { namePattern: 'T94_IT%' });
      expect(vistas.isError).toBeFalsy();
      const mviews = await call('list_materialized_views', { namePattern: 'T94_IT%' });
      expect(mviews.isError).toBeFalsy();
      expect(mviews.content[0]?.text).toContain(MV);
    });
  });

  describe('caminos de error', () => {
    it('una tabla que no existe vuelve como ORA-00942', async () => {
      const resultado = await call('run_query', { sql: 'SELECT * FROM T94_IT_NO_EXISTE' });
      expect(resultado.isError).toBe(true);
      expect(resultado.content[0]?.text).toMatch(/ORA-00942|ORA-00904/);
    });

    it('una sentencia rota vuelve como error de Oracle, no como caida', async () => {
      const resultado = await call('run_query', { sql: 'SELECT FROM WHERE' });
      expect(resultado.isError).toBe(true);
      expect(resultado.content[0]?.text.length).toBeGreaterThan(0);
    });

    it('la Barrera de minimos privilegios rechaza un no SELECT', async () => {
      const resultado = await call('run_query', { sql: 'DELETE FROM ' + TGT });
      expect(resultado.isError).toBe(true);
      expect(resultado.content[0]?.text).toMatch(/solo admite un SELECT/);
    });

    it('el server sigue respondiendo despues de los errores', async () => {
      const resultado = await call('run_query', { sql: 'SELECT COUNT(*) AS N FROM ' + HIER });
      expect(resultado.isError).toBeFalsy();
      expect(String(resultado.content[0]?.text)).toContain('"N"');
    });
  });
});
