import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import type { DataAccess } from '../../src/db/data-access.js';
import { createServer, type ServerHandle } from '../../src/server.js';

/**
 * Integration de los grafos y los data helpers contra el contenedor Oracle real.
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

const SCHEMA = GOOD_ENV.ORACLE_DB_SCHEMA!;

/** Tablas del esquema de ejemplo: solo lectura, este test no las toca. */
const EMPLOYEES = 'EMPLOYEES';
const JOIN_TABLE = 'EMPLOYEE_PROJECTS';
const VIEW = 'V_PROJECT_ASSIGNMENTS';

/**
 * Objetos propios de este test (prefijo T13_IT_). Los helpers de datos
 * necesitan huecos y duplicados garantizados, y el esquema de ejemplo no los
 * tiene: se crean y se borran aquí, sin alterar las tablas de ejemplo.
 */
const IDS = 'T13_IT_IDS';
const IDS_TAKEN = 'T13_IT_IDS_TAKEN';
const DUPES = 'T13_IT_DUPES';

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

/** Una arista FK o DEPENDS_ON tal como la devuelve la tool. */
interface Edge {
  fromObject: string;
  fromType: string;
  toObject: string;
  toType: string;
  edgeType: string;
  label: string | null;
}

interface Graph {
  schema: string;
  focus: string | null;
  graphType: string;
  edges: Edge[];
  mermaid: string;
}

/** Toda línea del diagrama menos la cabecera debe ser una arista bien formada. */
function mermaidEdges(mermaid: string): string[] {
  const [header, ...lines] = mermaid.split('\n');
  expect(header).toBe('graph LR');
  for (const line of lines) {
    expect(line).toMatch(/^ {2}[A-Za-z0-9_]+ -->(\|[A-Za-z0-9_]+\|)? [A-Za-z0-9_]+$/);
  }
  return lines;
}

describe.skipIf(!optIn)('grafos y data helpers contra Oracle real', () => {
  let handle: ServerHandle;
  let client: Client;
  let db: DataAccess;

  beforeAll(async () => {
    handle = createServer({ config: loadConfig({ ...GOOD_ENV, MCP_AUDIT_ENABLED: 'false' }) });
    db = handle.context.dataAccess;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'lu-query-graph-integration', version: '0.0.0' });
    await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);

    for (const table of [IDS, IDS_TAKEN, DUPES]) {
      await db.execute(`DROP TABLE ${table} PURGE`).catch(() => undefined);
    }
    // IDs 1,2,3 y 5: el hueco del 4 es el que debe proponer find_free_id.
    await db.execute(`CREATE TABLE ${IDS} (ID NUMBER PRIMARY KEY, LABEL VARCHAR2(20))`);
    await db.execute(`CREATE TABLE ${IDS_TAKEN} (ID NUMBER PRIMARY KEY)`);
    await db.execute(`CREATE TABLE ${DUPES} (ID NUMBER PRIMARY KEY, EMAIL VARCHAR2(50))`);
    await db.execute(`INSERT INTO ${IDS} (ID, LABEL) VALUES (1, 'a')`);
    await db.execute(`INSERT INTO ${IDS} (ID, LABEL) VALUES (2, 'b')`);
    await db.execute(`INSERT INTO ${IDS} (ID, LABEL) VALUES (3, 'c')`);
    await db.execute(`INSERT INTO ${IDS} (ID, LABEL) VALUES (5, 'd')`);
    await db.execute(`INSERT INTO ${IDS_TAKEN} (ID) VALUES (4)`);
    await db.execute(`INSERT INTO ${DUPES} (ID, EMAIL) VALUES (1, 'dup@example.com')`);
    await db.execute(`INSERT INTO ${DUPES} (ID, EMAIL) VALUES (2, 'dup@example.com')`);
    await db.execute(`INSERT INTO ${DUPES} (ID, EMAIL) VALUES (3, 'solo@example.com')`);
  });

  afterAll(async () => {
    for (const table of [IDS, IDS_TAKEN, DUPES]) {
      await db.execute(`DROP TABLE ${table} PURGE`).catch(() => undefined);
    }
    await client.close();
    await handle.close();
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const result = (await client.callTool({ name, arguments: args })) as ToolResult;
    // El mensaje de la tool va en el fallo: si falla, se lee sin re-depurar.
    expect(result.isError, result.content[0]?.text).toBeFalsy();
    return result;
  };

  const graph = async (name: string, args: Record<string, unknown>): Promise<Graph> =>
    JSON.parse((await call(name, args)).content[0]?.text ?? '') as Graph;

  describe('get_fk_graph', () => {
    it('muestra las FK de EMPLOYEE_PROJECTS como aristas child→parent', async () => {
      const result = await graph('get_fk_graph', { table: JOIN_TABLE });

      expect(result.graphType).toBe('FK');
      expect(result.schema).toBe(SCHEMA);
      expect(result.focus).toBe(JOIN_TABLE);
      const pairs = result.edges.map((edge) => [edge.fromObject, edge.label, edge.toObject]);
      expect(pairs).toEqual([
        [`${SCHEMA}.${JOIN_TABLE}`, 'FK_EP_EMP', `${SCHEMA}.${EMPLOYEES}`],
        [`${SCHEMA}.${JOIN_TABLE}`, 'FK_EP_PROJ', `${SCHEMA}.PROJECTS`],
      ]);
      expect(
        result.edges.every((edge) => edge.edgeType === 'FK' && edge.fromType === 'TABLE'),
      ).toBe(true);
    }, 60_000);

    it('acota por tabla tanto si es hija como si es padre, y dibuja el Mermaid', async () => {
      const asChild = await graph('get_fk_graph', { table: JOIN_TABLE });
      const asParent = await graph('get_fk_graph', { table: EMPLOYEES });

      expect(mermaidEdges(asChild.mermaid)).toEqual([
        `  ${JOIN_TABLE} -->|FK_EP_EMP| ${EMPLOYEES}`,
        `  ${JOIN_TABLE} -->|FK_EP_PROJ| PROJECTS`,
      ]);
      // Como padre: EMPLOYEE_PROJECTS lo referencia. Como hija: va a DEPARTMENTS.
      // Ordenado por tabla hija, y "EMPLOYEES" sorts antes que "EMPLOYEE_PROJECTS".
      expect(asParent.edges.map((edge) => [edge.fromObject, edge.toObject])).toEqual([
        [`${SCHEMA}.${EMPLOYEES}`, `${SCHEMA}.DEPARTMENTS`],
        [`${SCHEMA}.${JOIN_TABLE}`, `${SCHEMA}.${EMPLOYEES}`],
      ]);
      expect(mermaidEdges(asParent.mermaid)).toEqual([
        `  ${EMPLOYEES} -->|FK_EMP_DEPT| DEPARTMENTS`,
        `  ${JOIN_TABLE} -->|FK_EP_EMP| ${EMPLOYEES}`,
      ]);
    }, 60_000);

    it('devuelve el grafo completo del esquema cuando el cliente omite la tabla', async () => {
      const whole = await graph('get_fk_graph', {});

      expect(whole.focus).toBeNull();
      // El esquema de ejemplo tiene 3 FK: 2 de la tabla puente y 1 de EMPLOYEES.
      expect(whole.edges).toHaveLength(3);
      expect(whole.edges.map((edge) => edge.label).sort()).toEqual([
        'FK_EMP_DEPT',
        'FK_EP_EMP',
        'FK_EP_PROJ',
      ]);
    }, 60_000);
  });

  describe('get_dependency_graph', () => {
    it('muestra las dependencias de la vista como aristas dependiente→referenciado', async () => {
      const result = await graph('get_dependency_graph', { name: VIEW, type: 'VIEW' });

      expect(result.graphType).toBe('DEPENDENCY');
      expect(result.focus).toBe(VIEW);
      expect(result.edges).toEqual([
        {
          fromObject: `${SCHEMA}.${VIEW}`,
          fromType: 'VIEW',
          toObject: `${SCHEMA}.${EMPLOYEES}`,
          toType: 'TABLE',
          edgeType: 'DEPENDS_ON',
          label: `${VIEW} -> ${EMPLOYEES}`,
        },
        {
          fromObject: `${SCHEMA}.${VIEW}`,
          fromType: 'VIEW',
          toObject: `${SCHEMA}.${JOIN_TABLE}`,
          toType: 'TABLE',
          edgeType: 'DEPENDS_ON',
          label: `${VIEW} -> ${JOIN_TABLE}`,
        },
        {
          fromObject: `${SCHEMA}.${VIEW}`,
          fromType: 'VIEW',
          toObject: `${SCHEMA}.PROJECTS`,
          toType: 'TABLE',
          edgeType: 'DEPENDS_ON',
          label: `${VIEW} -> PROJECTS`,
        },
      ]);
      expect(mermaidEdges(result.mermaid)).toEqual([
        `  ${VIEW} --> ${EMPLOYEES}`,
        `  ${VIEW} --> ${JOIN_TABLE}`,
        `  ${VIEW} --> PROJECTS`,
      ]);
    }, 60_000);

    it('filtra por tipo y encuentra el procedimiento del esquema', async () => {
      const result = await graph('get_dependency_graph', { type: 'PROCEDURE' });

      expect(result.focus).toBeNull();
      expect(result.edges).toContainEqual({
        fromObject: `${SCHEMA}.ADD_EMPLOYEE`,
        fromType: 'PROCEDURE',
        toObject: `${SCHEMA}.${EMPLOYEES}`,
        toType: 'TABLE',
        edgeType: 'DEPENDS_ON',
        label: 'ADD_EMPLOYEE -> EMPLOYEES',
      });
      expect(result.edges.every((edge) => edge.fromType === 'PROCEDURE')).toBe(true);
    }, 60_000);
  });

  describe('count_rows', () => {
    it('cuenta las filas reales de la tabla del esquema', async () => {
      const counted = JSON.parse(
        (await call('count_rows', { table: EMPLOYEES })).content[0]?.text ?? '',
      ) as { schema: string; table: string; rowCount: number };
      const direct = await db.queryForObject(`SELECT COUNT(*) AS cnt FROM ${EMPLOYEES}`);

      expect(counted).toEqual({ schema: SCHEMA, table: EMPLOYEES, rowCount: Number(direct?.CNT) });
      expect(counted.rowCount).toBeGreaterThan(0);
    }, 60_000);
  });

  describe('find_duplicates', () => {
    it('devuelve los grupos repetidos con su conteo y un ROWID de muestra', async () => {
      const found = JSON.parse(
        (await call('find_duplicates', { table: DUPES, columns: ['EMAIL'] })).content[0]?.text ??
          '',
      ) as { minCount: number; groups: { EMAIL: string; CNT: number; SAMPLE_ROWID: string }[] };

      expect(found.minCount).toBe(2);
      expect(found.groups).toHaveLength(1);
      expect(found.groups[0]).toMatchObject({ EMAIL: 'dup@example.com', CNT: 2 });
      expect(found.groups[0]?.SAMPLE_ROWID).toMatch(/^\w+$/);
    }, 60_000);

    it('respeta el umbral: con minCount 3 no hay ningún grupo', async () => {
      const found = JSON.parse(
        (
          await call('find_duplicates', {
            table: DUPES,
            columns: ['EMAIL'],
            minCount: 3,
          })
        ).content[0]?.text ?? '',
      ) as { minCount: number; groups: unknown[] };

      expect(found.minCount).toBe(3);
      expect(found.groups).toEqual([]);
    }, 60_000);
  });

  describe('find_free_id', () => {
    it('propone el hueco más bajo del 1..1000 por defecto', async () => {
      const free = JSON.parse(
        (await call('find_free_id', { table: IDS, column: 'ID' })).content[0]?.text ?? '',
      ) as { maxRange: number; candidateId: number };

      expect(free.maxRange).toBe(1000);
      // Existen 1, 2, 3 y 5: el primer hueco es el 4.
      expect(free.candidateId).toBe(4);
    }, 60_000);

    it('evita también los ids de la tabla de exclusión y salta al siguiente hueco', async () => {
      const free = JSON.parse(
        (
          await call('find_free_id', {
            table: IDS,
            column: 'ID',
            excludeTable: IDS_TAKEN,
          })
        ).content[0]?.text ?? '',
      ) as { excludeTable: string; candidateId: number };

      expect(free.excludeTable).toBe(IDS_TAKEN);
      // La tabla de exclusión usa el 4, así que el hueco pasa a ser el 6.
      expect(free.candidateId).toBe(6);
    }, 60_000);

    it('topa la ventana a 10000 y avisa si la agota entera', async () => {
      const filled = 'T13_IT_FILLED';
      await db.execute(`CREATE TABLE ${filled} (ID NUMBER PRIMARY KEY)`);
      await db.execute(
        `BEGIN FOR i IN 1..10000 LOOP INSERT INTO ${filled} VALUES (i); END LOOP; END;`,
      );

      try {
        const free = JSON.parse(
          (await call('find_free_id', { table: filled, column: 'ID', maxRange: 50_000 })).content[0]
            ?.text ?? '',
        ) as { maxRange: number; candidateId: number | null };

        expect(free.maxRange).toBe(10_000);
        expect(free.candidateId).toBeNull();
      } finally {
        await db.execute(`DROP TABLE ${filled} PURGE`).catch(() => undefined);
      }
    }, 120_000);
  });

  it('los grafos no dependen de que el cliente pase el schema', async () => {
    const explicit = await graph('get_fk_graph', { schema: SCHEMA, table: EMPLOYEES });
    const implicit = await graph('get_fk_graph', { table: EMPLOYEES });

    expect(implicit.edges).toEqual(explicit.edges);
  }, 60_000);
});

describe.skipIf(!optIn)('data helpers de paridad (#1) contra Oracle real', () => {
  let handle: ServerHandle;
  let client: Client;
  let db: DataAccess;

  beforeAll(async () => {
    handle = createServer({ config: loadConfig({ ...GOOD_ENV, MCP_AUDIT_ENABLED: 'false' }) });
    db = handle.context.dataAccess;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'lu-query-datahelpers-integration', version: '0.0.0' });
    await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);

    await db.execute('DROP SEQUENCE T13_IT_SEQ').catch(() => undefined);
    await db.execute('CREATE SEQUENCE T13_IT_SEQ START WITH 42');
    await db.execute('DROP TABLE T13_IT_ORPH_CHILD PURGE').catch(() => undefined);
    await db.execute('DROP TABLE T13_IT_ORPH_PARENT PURGE').catch(() => undefined);
    await db.execute('CREATE TABLE T13_IT_ORPH_PARENT (ID NUMBER PRIMARY KEY)');
    await db.execute('CREATE TABLE T13_IT_ORPH_CHILD (ID NUMBER PRIMARY KEY, PARENT_ID NUMBER)');
    await db.execute('INSERT INTO T13_IT_ORPH_PARENT (ID) VALUES (1)');
    await db.execute('INSERT INTO T13_IT_ORPH_CHILD (ID, PARENT_ID) VALUES (10, 1)');
    // El huérfano (parent 99) existe ANTES de la FK: por eso se añade NOVALIDATE,
    // que es exactamente el escenario legacy que esta tool debe detectar.
    await db.execute('INSERT INTO T13_IT_ORPH_CHILD (ID, PARENT_ID) VALUES (11, 99)');
    await db.execute(
      'ALTER TABLE T13_IT_ORPH_CHILD ADD CONSTRAINT T13_IT_ORPH_FK FOREIGN KEY (PARENT_ID) REFERENCES T13_IT_ORPH_PARENT(ID) NOVALIDATE',
    );
  });

  afterAll(async () => {
    await db.execute('DROP SEQUENCE T13_IT_SEQ').catch(() => undefined);
    await db.execute('DROP TABLE T13_IT_ORPH_CHILD PURGE').catch(() => undefined);
    await db.execute('DROP TABLE T13_IT_ORPH_PARENT PURGE').catch(() => undefined);
    await client.close();
    await handle.close();
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const result = (await client.callTool({ name, arguments: args })) as ToolResult;
    expect(result.isError, result.content[0]?.text).toBeFalsy();
    return result;
  };

  it('get_next_sequence_value avanza la secuencia y devuelve el valor', async () => {
    const first = JSON.parse(
      (await call('get_next_sequence_value', { sequence: 'T13_IT_SEQ' })).content[0]?.text ?? '',
    );
    const second = JSON.parse(
      (await call('get_next_sequence_value', { sequence: 'T13_IT_SEQ' })).content[0]?.text ?? '',
    );

    expect(first.nextValue).toBe(42);
    expect(second.nextValue).toBe(43);
  });

  it('validate_fk_integrity cuenta los huerfanos de la FK y filtra por constraint', async () => {
    const all = JSON.parse(
      (await call('validate_fk_integrity', { table: 'T13_IT_ORPH_CHILD' })).content[0]?.text ?? '',
    ) as Array<{ constraint_name: string; orphan_count: number; parent_table: string }>;

    expect(all).toHaveLength(1);
    expect(all[0]?.parent_table).toBe('T13_IT_ORPH_PARENT');
    expect(all[0]?.orphan_count).toBe(1);

    const filtered = JSON.parse(
      (
        await call('validate_fk_integrity', {
          table: 'T13_IT_ORPH_CHILD',
          constraint: all[0]?.constraint_name,
        })
      ).content[0]?.text ?? '',
    ) as Array<{ orphan_count: number }>;
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.orphan_count).toBe(1);

    const empty = JSON.parse(
      (
        await call('validate_fk_integrity', {
          table: 'T13_IT_ORPH_CHILD',
          constraint: 'NO_EXISTE',
        })
      ).content[0]?.text ?? '',
    ) as unknown[];
    expect(empty).toEqual([]);
  });

  it('validate_fk_integrity no encuentra huerfanos en el join de ejemplo', async () => {
    const fks = JSON.parse(
      (await call('validate_fk_integrity', { table: JOIN_TABLE })).content[0]?.text ?? '',
    ) as Array<{ constraint_name: string; orphan_count: number }>;

    expect(fks.map((fk) => fk.constraint_name).sort()).toEqual(['FK_EP_EMP', 'FK_EP_PROJ']);
    for (const fk of fks) expect(fk.orphan_count).toBe(0);
  });
});
