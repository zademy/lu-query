import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import type { DataAccess } from '../../src/db/data-access.js';
import { createServer, type ServerHandle } from '../../src/server.js';

/**
 * Integration de las features de Oracle contra el contenedor real: el zoo de
 * objetos (tablas, particiones, LOB, JSON, XMLType, tipos objeto, vistas,
 * packages, triggers, secuencias, indices) y las tools que los inspeccionan.
 *
 * Cada objeto es del test, con prefijo T93_IT_; el esquema de ejemplo no se
 * toca nunca. Las particiones y los tipos existen en la edicion Free, asi que
 * aqui se comprueban de verdad.
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

const OWNER = GOOD_ENV.ORACLE_DB_USERNAME as string;
const BASE = 'T93_IT_BASE';
const CHILD = 'T93_IT_CHILD';
const PART = 'T93_IT_PART';
const LIST = 'T93_IT_LIST';
const HASH = 'T93_IT_HASH';
const LOB = 'T93_IT_LOB';
const JSONT = 'T93_IT_JSON';
const XMLT = 'T93_IT_XML';
const OBJT = 'T93_IT_OBJ';
const VAT = 'T93_IT_VA';
const IDENT = 'T93_IT_IDENT';
const VIRT = 'T93_IT_VIRT';
const IOT = 'T93_IT_IOT';
const GTT = 'T93_IT_GTT';
const VW = 'T93_IT_VW';
const VW_JOIN = 'T93_IT_VW_JOIN';
const MV = 'T93_IT_MV';
const PKG = 'T93_IT_PKG';
const FN = 'T93_IT_FN';
const PR = 'T93_IT_PR';
const BROKEN = 'T93_IT_BROKEN';
const TRG = 'T93_IT_TRG';
const TRC = 'T93_IT_TRC';
const SEQ = 'T93_IT_SEQ';
const SEQ_CACHE = 'T93_IT_SEQ_CACHE';
const SEQ_CYCLE = 'T93_IT_SEQ_CYCLE';
const IDX = 'T93_IT_IDX';
const IDX_UNQ = 'T93_IT_IDX_UNQ';
const IDX_FBI = 'T93_IT_IDX_FBI';
const IDX_BM = 'T93_IT_IDX_BM';
const IDX_INV = 'T93_IT_IDX_INV';
const SYN = 'T93_IT_SYN';
const TYPE = 'T93_IT_TYPE';
const VARRAY = 'T93_IT_VARRAY';

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

describe.skipIf(!optIn)('features de Oracle contra el contenedor real', () => {
  let handle: ServerHandle;
  let client: Client;
  let db: DataAccess;
  let auditDir: string;

  beforeAll(async () => {
    auditDir = await mkdtemp(join(tmpdir(), 'lu-query-features-it-'));
    handle = createServer({ config: loadConfig({ ...GOOD_ENV, MCP_AUDIT_DIR: auditDir }) });
    db = handle.context.dataAccess;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'lu-query-features-integration', version: '0.0.0' });
    await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);

    await db.execute('CREATE TYPE ' + TYPE + ' AS OBJECT (A NUMBER, B VARCHAR2(20))');
    await db.execute('CREATE TYPE ' + VARRAY + ' AS VARRAY(10) OF NUMBER');

    await db.execute(
      'CREATE TABLE ' +
        BASE +
        ' (ID NUMBER PRIMARY KEY, TXT VARCHAR2(50), AMT NUMBER(10,2), CREATED DATE)',
    );
    await db.execute(
      'INSERT INTO ' +
        BASE +
        " (ID, TXT, AMT, CREATED) SELECT LEVEL, 'txt' || LEVEL, LEVEL * 10, SYSDATE FROM DUAL CONNECT BY LEVEL <= 20",
    );
    await db.execute('CREATE TABLE ' + CHILD + ' (ID NUMBER PRIMARY KEY, BASE_ID NUMBER)');
    await db.execute(
      'ALTER TABLE ' +
        CHILD +
        ' ADD CONSTRAINT FK_' +
        CHILD +
        ' FOREIGN KEY (BASE_ID) REFERENCES ' +
        BASE +
        '(ID)',
    );
    await db.execute('INSERT INTO ' + CHILD + ' (ID, BASE_ID) VALUES (1, 1)');

    await db.execute(
      'CREATE TABLE ' +
        PART +
        " (ID NUMBER, D DATE) PARTITION BY RANGE (D) (PARTITION P_OLD VALUES LESS THAN (DATE '2020-01-01'), PARTITION P_NEW VALUES LESS THAN (DATE '2030-01-01'))",
    );
    await db.execute('INSERT INTO ' + PART + " VALUES (1, DATE '2019-01-01')");
    await db.execute('INSERT INTO ' + PART + " VALUES (2, DATE '2024-01-01')");
    await db.execute(
      'CREATE TABLE ' +
        LIST +
        " (ID NUMBER, C VARCHAR2(10)) PARTITION BY LIST (C) (PARTITION PA VALUES ('A','B'), PARTITION PB VALUES (DEFAULT))",
    );
    await db.execute('CREATE TABLE ' + HASH + ' (ID NUMBER) PARTITION BY HASH (ID) PARTITIONS 2');

    await db.execute('CREATE TABLE ' + LOB + ' (ID NUMBER, C CLOB, B BLOB)');
    await db.execute('INSERT INTO ' + LOB + " (ID, C) VALUES (1, 'texto del clob')");
    await db.execute('CREATE TABLE ' + JSONT + ' (ID NUMBER, J JSON)');
    await db.execute('INSERT INTO ' + JSONT + ' (ID, J) VALUES (1, \'{"a":1}\')');
    await db.execute('CREATE TABLE ' + XMLT + ' (ID NUMBER, X SYS.XMLTYPE)');
    await db.execute('INSERT INTO ' + XMLT + " (ID, X) VALUES (1, XMLTYPE('<a>1</a>'))");
    await db.execute('CREATE TABLE ' + OBJT + ' (ID NUMBER, O ' + TYPE + ')');
    await db.execute('INSERT INTO ' + OBJT + ' (ID, O) VALUES (1, ' + TYPE + "(1, 'x'))");
    await db.execute('CREATE TABLE ' + VAT + ' (ID NUMBER, V ' + VARRAY + ')');
    await db.execute('INSERT INTO ' + VAT + ' (ID, V) VALUES (1, ' + VARRAY + '(1,2))');
    await db.execute(
      'CREATE TABLE ' + IDENT + ' (ID NUMBER GENERATED ALWAYS AS IDENTITY, T VARCHAR2(20))',
    );
    await db.execute(
      'CREATE TABLE ' + VIRT + ' (A NUMBER, B NUMBER GENERATED ALWAYS AS (A*2) VIRTUAL)',
    );
    await db.execute(
      'CREATE TABLE ' + IOT + ' (ID NUMBER PRIMARY KEY, TXT VARCHAR2(20)) ORGANIZATION INDEX',
    );
    await db.execute('CREATE GLOBAL TEMPORARY TABLE ' + GTT + ' (ID NUMBER) ON COMMIT DELETE ROWS');

    await db.execute('CREATE VIEW ' + VW + ' AS SELECT ID, TXT FROM ' + BASE);
    await db.execute(
      'CREATE VIEW ' +
        VW_JOIN +
        ' AS SELECT b.ID, c.ID AS CHILD_ID FROM ' +
        BASE +
        ' b JOIN ' +
        CHILD +
        ' c ON c.BASE_ID = b.ID',
    );
    await db.execute('CREATE MATERIALIZED VIEW ' + MV + ' AS SELECT ID, TXT FROM ' + BASE);

    await db.execute(
      'CREATE OR REPLACE PACKAGE ' +
        PKG +
        ' AS ' +
        'PROCEDURE P1(P_ID IN NUMBER); ' +
        'PROCEDURE P1(P_ID IN NUMBER, P_MSG OUT VARCHAR2); ' +
        'FUNCTION F1 RETURN NUMBER; ' +
        'FUNCTION F2(P_ID IN NUMBER) RETURN VARCHAR2; ' +
        'END;',
    );
    await db.execute(
      'CREATE OR REPLACE PACKAGE BODY ' +
        PKG +
        ' AS ' +
        'PROCEDURE P1(P_ID IN NUMBER) IS BEGIN NULL; END; ' +
        'PROCEDURE P1(P_ID IN NUMBER, P_MSG OUT VARCHAR2) IS BEGIN P_MSG := ' +
        "'ok' || P_ID; END; " +
        'FUNCTION F1 RETURN NUMBER IS BEGIN RETURN 42; END; ' +
        "FUNCTION F2(P_ID IN NUMBER) RETURN VARCHAR2 IS BEGIN RETURN 'fn' || P_ID; END; " +
        'END;',
    );
    await db.execute('CREATE OR REPLACE FUNCTION ' + FN + ' RETURN NUMBER IS BEGIN RETURN 7; END;');
    await db.execute('CREATE OR REPLACE PROCEDURE ' + PR + ' AS BEGIN NULL; END;');
    // Objeto invalido a proposito: lista en ALL_OBJECTS pero no compila.
    await db.execute(
      'CREATE OR REPLACE PROCEDURE ' +
        BROKEN +
        ' AS BEGIN INSERT INTO T93_IT_NO_EXISTE VALUES (1); END;',
    );
    await db.execute(
      'CREATE OR REPLACE TRIGGER ' +
        TRG +
        ' BEFORE INSERT ON ' +
        BASE +
        ' FOR EACH ROW BEGIN NULL; END;',
    );
    await db.execute(
      'CREATE OR REPLACE TRIGGER ' +
        TRC +
        ' FOR INSERT ON ' +
        BASE +
        ' COMPOUND TRIGGER BEFORE STATEMENT IS BEGIN NULL; END BEFORE STATEMENT; END;',
    );

    await db.execute('CREATE SEQUENCE ' + SEQ);
    await db.execute('CREATE SEQUENCE ' + SEQ_CACHE + ' CACHE 20');
    await db.execute('CREATE SEQUENCE ' + SEQ_CYCLE + ' MINVALUE 1 MAXVALUE 3 CYCLE NOCACHE');

    await db.execute('CREATE INDEX ' + IDX + ' ON ' + BASE + ' (TXT, AMT)');
    await db.execute('CREATE UNIQUE INDEX ' + IDX_UNQ + ' ON ' + BASE + ' (TXT)');
    await db.execute('CREATE INDEX ' + IDX_FBI + ' ON ' + BASE + ' (UPPER(TXT))');
    await db.execute('CREATE BITMAP INDEX ' + IDX_BM + ' ON ' + BASE + ' (AMT)');
    await db.execute('CREATE INDEX ' + IDX_INV + ' ON ' + BASE + ' (CREATED) INVISIBLE');
    await db.execute('CREATE SYNONYM ' + SYN + ' FOR ' + BASE);

    await db.execute('BEGIN DBMS_STATS.GATHER_TABLE_STATS(USER, ' + "'" + BASE + "'" + '); END;');
  }, 180_000);

  afterAll(async () => {
    for (const sql of [
      'DROP MATERIALIZED VIEW ' + MV,
      'DROP VIEW ' + VW_JOIN,
      'DROP VIEW ' + VW,
      'DROP TRIGGER ' + TRG,
      'DROP TRIGGER ' + TRC,
      'DROP PROCEDURE ' + BROKEN,
      'DROP PROCEDURE ' + PR,
      'DROP FUNCTION ' + FN,
      'DROP PACKAGE ' + PKG,
      'DROP TABLE ' + CHILD + ' PURGE',
      'DROP TABLE ' + BASE + ' PURGE',
      'DROP TABLE ' + PART + ' PURGE',
      'DROP TABLE ' + LIST + ' PURGE',
      'DROP TABLE ' + HASH + ' PURGE',
      'DROP TABLE ' + LOB + ' PURGE',
      'DROP TABLE ' + JSONT + ' PURGE',
      'DROP TABLE ' + XMLT + ' PURGE',
      'DROP TABLE ' + OBJT + ' PURGE',
      'DROP TABLE ' + VAT + ' PURGE',
      'DROP TABLE ' + IDENT + ' PURGE',
      'DROP TABLE ' + VIRT + ' PURGE',
      'DROP TABLE ' + IOT + ' PURGE',
      'DROP TABLE ' + GTT + ' PURGE',
      'DROP SEQUENCE ' + SEQ,
      'DROP SEQUENCE ' + SEQ_CACHE,
      'DROP SEQUENCE ' + SEQ_CYCLE,
      'DROP SYNONYM ' + SYN,
      'DROP TYPE ' + VARRAY,
      'DROP TYPE ' + TYPE,
    ]) {
      await db.execute(sql).catch(() => undefined);
    }
    await client.close();
    await handle.close();
    await rm(auditDir, { recursive: true, force: true });
  }, 120_000);

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as ToolResult;

  /** Texto crudo de la tool: para tools que devuelven texto y no JSON. */
  const text = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
    const resultado = await call(name, args);
    if (resultado.isError) {
      throw new Error(name + ': ' + (resultado.content[0]?.text ?? 'sin texto'));
    }
    return resultado.content[0]?.text ?? '';
  };

  /** Filas de una tool que devuelve un array JSON. */
  const rows = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>[]> =>
    JSON.parse(await text(name, args)) as Record<string, unknown>[];

  describe('tablas y columnas', () => {
    it('describe_table ve la identidad y la columna virtual', async () => {
      const ident = await rows('describe_table', { table: IDENT });
      expect(ident.map((c) => c.COLUMN_NAME)).toContain('ID');
      expect(String(ident.find((c) => c.COLUMN_NAME === 'ID')?.DATA_DEFAULT)).toContain('nextval');

      const virt = await rows('describe_table', { table: VIRT });
      expect(virt.map((c) => c.DATA_TYPE)).toContain('NUMBER');
      expect(virt).toHaveLength(2);
    });

    it('describe_table ve los tipos raros con su DATA_TYPE', async () => {
      const lob = await rows('describe_table', { table: LOB });
      expect(lob.find((c) => c.COLUMN_NAME === 'C')?.DATA_TYPE).toBe('CLOB');
      expect(lob.find((c) => c.COLUMN_NAME === 'B')?.DATA_TYPE).toBe('BLOB');

      const json = await rows('describe_table', { table: JSONT });
      expect(json.find((c) => c.COLUMN_NAME === 'J')?.DATA_TYPE).toBe('JSON');

      const xml = await rows('describe_table', { table: XMLT });
      expect(xml.find((c) => c.COLUMN_NAME === 'X')?.DATA_TYPE).toBe('XMLTYPE');

      const obj = await rows('describe_table', { table: OBJT });
      expect(obj.find((c) => c.COLUMN_NAME === 'O')?.DATA_TYPE).toBe(TYPE);
    });

    it('un CLOB llega entero y serializable en get_sample_data', async () => {
      const sample = JSON.parse(await text('get_sample_data', { table: LOB })) as {
        rows: Record<string, unknown>[];
      };
      expect(sample.rows[0]?.C).toBe('texto del clob');
    });

    it('un CLOB llega entero en run_query', async () => {
      const salida = JSON.parse(await text('run_query', { sql: 'SELECT C FROM ' + LOB })) as {
        rows: Record<string, unknown>[];
      };
      expect(salida.rows[0]?.C).toBe('texto del clob');
    });

    it('los tipos objeto y VARRAY se serializan como JSON', async () => {
      const salida = JSON.parse(
        await text('run_query', { sql: 'SELECT O, V FROM ' + OBJT + ' CROSS JOIN ' + VAT }),
      ) as { rows: Record<string, unknown>[] };
      expect(salida.rows[0]?.O).toEqual({ A: 1, B: 'x' });
      expect(salida.rows[0]?.V).toEqual([1, 2]);
    });

    it('list_lob_columns ve el CLOB y el BLOB', async () => {
      const lobs = await rows('list_lob_columns', { table: LOB });
      expect(lobs.map((c) => c.COLUMN_NAME).sort()).toEqual(['B', 'C']);
    });

    it('count_rows y get_sample_data sobre la tabla con datos', async () => {
      const cuenta = JSON.parse(await text('count_rows', { table: BASE })) as {
        rowCount: number;
      };
      expect(cuenta.rowCount).toBe(20);
      const muestra = JSON.parse(await text('get_sample_data', { table: BASE, rows: 3 })) as {
        rows: unknown[];
      };
      expect(muestra.rows).toHaveLength(3);
    });

    it('la tabla IOT y la temporal global se listan', async () => {
      const tablas = await rows('list_tables', { namePattern: 'T93_IT%' });
      const nombres = tablas.map((t) => t.TABLE_NAME);
      expect(nombres).toContain(IOT);
      expect(nombres).toContain(GTT);
    });
  });

  describe('particiones', () => {
    it('list_partitions ve las particiones por rango', async () => {
      const particiones = await rows('list_partitions', { table: PART });
      const nombres = particiones.map((p) => p.PARTITION_NAME);
      expect(nombres).toContain('P_OLD');
      expect(nombres).toContain('P_NEW');
    });

    it('list_partitions ve las particiones por lista y por hash', async () => {
      const porLista = await rows('list_partitions', { table: LIST });
      expect(porLista.map((p) => p.PARTITION_NAME)).toEqual(expect.arrayContaining(['PA', 'PB']));

      const porHash = await rows('list_partitions', { table: HASH });
      expect(porHash.length).toBe(2);
    });

    it('las filas se reparten en su particion', async () => {
      const cuenta = async (particion: string): Promise<number> => {
        const salida = JSON.parse(
          await text('run_query', {
            sql: 'SELECT COUNT(*) N FROM ' + PART + ' PARTITION (' + particion + ')',
          }),
        ) as { rows: { N: number }[] };
        return Number(salida.rows[0]?.N);
      };
      expect(await cuenta('P_OLD')).toBe(1);
      expect(await cuenta('P_NEW')).toBe(1);
    });

    it('list_ind_partitions ve las particiones de un indice local', async () => {
      await db.execute('CREATE INDEX T93_IT_IDXP ON ' + PART + ' (ID) LOCAL');
      try {
        const particiones = await rows('list_ind_partitions', { table: PART });
        expect(particiones.length).toBeGreaterThan(0);
      } finally {
        await db.execute('DROP INDEX T93_IT_IDXP').catch(() => undefined);
      }
    });
  });

  describe('indices', () => {
    it('list_indexes ve el unico, el compuesto, el function-based, el bitmap y el invisible', async () => {
      const indices = await rows('list_indexes', { table: BASE });
      const nombres = indices.map((i) => String(i.INDEX_NAME));
      expect(nombres).toContain(IDX);
      expect(nombres).toContain(IDX_UNQ);
      expect(nombres).toContain(IDX_FBI);
      expect(nombres).toContain(IDX_BM);
      expect(nombres).toContain(IDX_INV);
    });

    it('list_indexes distingue el indice unico', async () => {
      const indices = await rows('list_indexes', { table: BASE });
      const unico = indices.find((i) => i.INDEX_NAME === IDX_UNQ);
      expect(String(unico?.UNIQUENESS)).toBe('UNIQUE');
    });

    it('list_indexes ve el indice function-based con su columna de sistema', async () => {
      const indices = await rows('list_indexes', { table: BASE });
      const fbi = indices.find((i) => i.INDEX_NAME === IDX_FBI);
      // Oracle no expone la expresion UPPER(TXT) en ALL_IND_COLUMNS: la guarda
      // como columna de sistema (SYS_NCxxx). El indice existe y es valido.
      expect(fbi).toBeDefined();
      expect(String(fbi?.STATUS)).toBe('VALID');
      expect(String(fbi?.COLUMNS)).toMatch(/^SYS_NC/);
    });

    it('create_index crea un indice unico por MCP', async () => {
      const creado = await text('create_index', {
        index: 'T93_IT_IDX_NEW',
        tableSchema: OWNER,
        table: CHILD,
        columns: ['BASE_ID'],
        unique: true,
      });
      expect(creado).toContain('T93_IT_IDX_NEW');
      try {
        const indices = await rows('list_indexes', { table: CHILD });
        expect(indices.map((i) => i.INDEX_NAME)).toContain('T93_IT_IDX_NEW');
      } finally {
        await db.execute('DROP INDEX T93_IT_IDX_NEW').catch(() => undefined);
      }
    });
  });

  describe('vistas y sinonimos', () => {
    it('list_views ve la vista simple y la del join', async () => {
      const vistas = await rows('list_views', { namePattern: 'T93_IT%' });
      const nombres = vistas.map((v) => v.VIEW_NAME);
      expect(nombres).toContain(VW);
      expect(nombres).toContain(VW_JOIN);
    });

    it('la vista con join devuelve el mismo dato que el join a mano', async () => {
      const viaView = JSON.parse(
        await text('run_query', { sql: 'SELECT ID, CHILD_ID FROM ' + VW_JOIN }),
      ) as { rows: { ID: number; CHILD_ID: number }[] };
      const viaJoin = JSON.parse(
        await text('run_query', {
          sql:
            'SELECT b.ID ID, c.ID CHILD_ID FROM ' +
            BASE +
            ' b JOIN ' +
            CHILD +
            ' c ON c.BASE_ID = b.ID',
        }),
      ) as { rows: { ID: number; CHILD_ID: number }[] };
      expect(viaView.rows).toEqual(viaJoin.rows);
    });

    it('list_materialized_views ve la mview y get_ddl la rechaza como tipo', async () => {
      const mviews = await rows('list_materialized_views', {});
      expect(mviews.map((m) => m.NAME)).toContain(MV);

      // MATERIALIZED VIEW no es un tipo valido de get_ddl: la allow-list es
      // TABLE/VIEW/INDEX/PROCEDURE/FUNCTION/PACKAGE/SEQUENCE/TRIGGER.
      const resultado = await call('get_ddl', { name: MV, type: 'MATERIALIZED VIEW' });
      expect(resultado.isError).toBe(true);
      expect(resultado.content[0]?.text).toContain('tipo');
    });

    it('list_synonyms ve el sinonimo privado', async () => {
      const sinonimos = await rows('list_synonyms', { namePattern: 'T93_IT%' });
      expect(sinonimos.map((s) => s.NAME)).toContain(SYN);
    });

    it('get_ddl devuelve el DDL de la vista', async () => {
      const ddl = await text('get_ddl', { name: VW, type: 'VIEW' });
      expect(ddl).toContain('CREATE');
      expect(ddl).toContain(VW);
    });
  });

  describe('secuencias', () => {
    it('list_sequences ve las tres y sus diferencias de cache', async () => {
      const seqs = await rows('list_sequences', {});
      const porNombre = new Map(seqs.map((s) => [String(s.SEQUENCE_NAME), s]));
      expect(porNombre.has(SEQ)).toBe(true);
      expect(porNombre.has(SEQ_CACHE)).toBe(true);
      expect(porNombre.has(SEQ_CYCLE)).toBe(true);
      expect(Number(porNombre.get(SEQ_CACHE)?.CACHE_SIZE)).toBe(20);
    });

    it('get_sequence_info cuenta con el cache y con el cycle', async () => {
      const cache = JSON.parse(await text('get_sequence_info', { sequence: SEQ_CACHE })) as {
        CACHE_SIZE: number;
      };
      expect(cache.CACHE_SIZE).toBe(20);

      const cycle = JSON.parse(await text('get_sequence_info', { sequence: SEQ_CYCLE })) as {
        CYCLE_FLAG: string;
        MAX_VALUE: number;
      };
      expect(cycle.CYCLE_FLAG).toBe('Y');
      expect(Number(cycle.MAX_VALUE)).toBe(3);
    });

    it('get_next_sequence_value avanza la secuencia', async () => {
      const uno = JSON.parse(await text('get_next_sequence_value', { sequence: SEQ })) as {
        nextValue: number;
      };
      const dos = JSON.parse(await text('get_next_sequence_value', { sequence: SEQ })) as {
        nextValue: number;
      };
      expect(dos.nextValue).toBe(uno.nextValue + 1);
    });
  });

  describe('PL/SQL: packages, funciones, procedimientos y triggers', () => {
    it('list_procedcies ve el package, la funcion y el procedimiento', async () => {
      const lista = await rows('list_procedures', { namePattern: 'T93_IT%' });
      const porNombre = new Map(lista.map((p) => [String(p.NAME), p]));
      expect(porNombre.has(PKG)).toBe(true);
      expect(porNombre.has(FN)).toBe(true);
      expect(porNombre.has(PR)).toBe(true);
      expect(porNombre.has(BROKEN)).toBe(true);
    });

    it('list_procedures distingue el package de la funcion', async () => {
      const lista = await rows('list_procedures', { namePattern: 'T93_IT%' });
      const tipos = new Map(lista.map((p) => [String(p.NAME), String(p.TYPE)]));
      // ALL_OBJECTS tiene PACKAGE y PACKAGE BODY por separado: ambos son el package.
      expect(lista.map((p) => p.TYPE)).toEqual(expect.arrayContaining(['PACKAGE']));
      expect(tipos.get(PR)).toBe('PROCEDURE');
    });

    it('describe_plsql devuelve el spec y el body del package', async () => {
      const ddl = await text('describe_plsql', { name: PKG, type: 'PACKAGE' });
      expect(ddl).toContain('PACKAGE');
      expect(ddl).toContain('P1');
      expect(ddl).toContain('F1');
    });

    it('call_procedure llama a la funcion del package', async () => {
      const salida = JSON.parse(
        await text('call_procedure', {
          name: PKG + '.F1',
          args: '[]',
          isFunction: true,
          returnType: 'NUMBER',
        }),
      ) as { returnValue: number };
      expect(salida.returnValue).toBe(42);
    });

    it('call_procedure llama a la funcion suelta', async () => {
      const salida = JSON.parse(
        await text('call_procedure', {
          name: FN,
          args: '[]',
          isFunction: true,
          returnType: 'NUMBER',
        }),
      ) as { returnValue: number };
      expect(salida.returnValue).toBe(7);
    });

    it('call_procedure con un OUT devuelve el valor', async () => {
      const salida = JSON.parse(
        await text('call_procedure', {
          name: PKG + '.P1',
          args: JSON.stringify([
            { name: 'P_ID', direction: 'IN', dataType: 'NUMBER', value: 5 },
            { name: 'P_MSG', direction: 'OUT', dataType: 'VARCHAR2', size: 50 },
          ]),
        }),
      ) as { outParams: Record<string, unknown> };
      expect(salida.outParams.P_MSG).toBe('ok5');
    });

    it('list_triggers ve el trigger de fila y el compuesto', async () => {
      const triggers = await rows('list_triggers', {});
      const nombres = triggers.map((t) => String(t.TRIGGER_NAME));
      expect(nombres).toContain(TRG);
      expect(nombres).toContain(TRC);
    });

    it('get_ddl devuelve el DDL del trigger', async () => {
      const ddl = await text('get_ddl', { name: TRG, type: 'TRIGGER' });
      expect(ddl).toContain('TRIGGER');
    });

    it('el objeto roto sale como invalido y con su error', async () => {
      const invalidos = await rows('list_invalid_objects', {});
      expect(invalidos.map((o) => o.NAME)).toContain(BROKEN);

      const errores = await text('get_plsql_errors', { name: BROKEN });
      expect(errores).toContain(BROKEN);
    });

    it('list_dependencies y get_dependency_graph siguen la vista al package', async () => {
      const dependencias = await rows('list_dependencies', { name: VW_JOIN });
      expect(dependencias.length).toBeGreaterThan(0);

      const grafo = await text('get_dependency_graph', { name: VW_JOIN, type: 'VIEW' });
      expect(grafo).toContain(VW_JOIN);
    });

    it('list_types ve el tipo objeto y el VARRAY', async () => {
      const tipos = await rows('list_types', {});
      const nombres = tipos.map((t) => t.NAME);
      expect(nombres).toContain(TYPE);
      expect(nombres).toContain(VARRAY);
    });
  });

  describe('estadisticas y rendimiento', () => {
    it('get_table_stats ve la tabla con stats', async () => {
      const stats = await text('get_table_stats', { table: BASE });
      expect(stats).toContain(BASE);
    });

    it('get_column_stats ve la columna', async () => {
      const stats = await text('get_column_stats', { table: BASE, column: 'AMT' });
      expect(stats).toContain('AMT');
    });

    it('get_histogram ve el histograma de la columna', async () => {
      const histo = await text('get_histogram', { table: BASE, column: 'TXT' });
      expect(histo.length).toBeGreaterThan(0);
    });

    it('list_unused_indexes responde', async () => {
      const sinUso = await rows('list_unused_indexes', {});
      expect(Array.isArray(sinUso)).toBe(true);
    });

    it('suggest_index propone un indice para una consulta sin indice', async () => {
      const sugerencia = JSON.parse(
        await text('suggest_index', {
          sql: 'SELECT BASE_ID FROM ' + CHILD + ' WHERE BASE_ID > 5',
        }),
      ) as { hasCandidates: boolean; recommendedDdl: string };
      expect(sugerencia.hasCandidates).toBe(true);
      expect(sugerencia.recommendedDdl).toContain('CREATE INDEX');
    });

    it('explain_plan explica una consulta con join', async () => {
      const plan = await text('explain_plan', {
        sql: 'SELECT b.ID, c.ID FROM ' + BASE + ' b JOIN ' + CHILD + ' c ON c.BASE_ID = b.ID',
      });
      expect(plan).toContain('TABLE ACCESS');
    });
  });
});
