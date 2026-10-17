import { afterEach, describe, expect, it } from 'vitest';
import { FakeDataAccess } from '../../src/db/fake-data-access.js';
import { createHarness, type Harness } from '../helpers/harness.js';

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

/** Filas de `all_constraints` que devuelve Oracle con las etiquetas en MAYÚSCULAS. */
const FK_ROWS = [
  {
    CHILD_TABLE: 'EMPLOYEE_PROJECTS',
    FK_NAME: 'FK_EP_EMP',
    PARENT_OWNER: 'DEVUSER',
    PARENT_TABLE: 'EMPLOYEES',
  },
  {
    CHILD_TABLE: 'EMPLOYEE_PROJECTS',
    FK_NAME: 'FK_EP_PROJ',
    PARENT_OWNER: 'DEVUSER',
    PARENT_TABLE: 'PROJECTS',
  },
  {
    CHILD_TABLE: 'EMPLOYEES',
    FK_NAME: 'FK_EMP_DEPT',
    PARENT_OWNER: 'DEVUSER',
    PARENT_TABLE: 'DEPARTMENTS',
  },
];

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** Harness con el schema configurado: sin él las tools de catálogo no pueden resolver. */
async function graphHarness(dataAccess = new FakeDataAccess()): Promise<Harness> {
  harness = await createHarness({ dataAccess, config: { schema: 'DEVUSER' } });
  return harness;
}

const call = async (h: Harness, name: string, args: Record<string, unknown>): Promise<ToolResult> =>
  (await h.client.callTool({ name, arguments: args })) as ToolResult;

const json = async (
  h: Harness,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> =>
  JSON.parse((await call(h, name, args)).content[0]?.text ?? '') as Record<string, unknown>;

describe('get_fk_graph', () => {
  it('devuelve aristas child→parent y el diagrama Mermaid del esquema', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: FK_ROWS }));
    const h = await graphHarness(dataAccess);

    const graph = await json(h, 'get_fk_graph', {});

    expect(graph).toEqual({
      schema: 'DEVUSER',
      focus: null,
      graphType: 'FK',
      edges: [
        {
          fromObject: 'DEVUSER.EMPLOYEE_PROJECTS',
          fromType: 'TABLE',
          toObject: 'DEVUSER.EMPLOYEES',
          toType: 'TABLE',
          edgeType: 'FK',
          label: 'FK_EP_EMP',
        },
        {
          fromObject: 'DEVUSER.EMPLOYEE_PROJECTS',
          fromType: 'TABLE',
          toObject: 'DEVUSER.PROJECTS',
          toType: 'TABLE',
          edgeType: 'FK',
          label: 'FK_EP_PROJ',
        },
        {
          fromObject: 'DEVUSER.EMPLOYEES',
          fromType: 'TABLE',
          toObject: 'DEVUSER.DEPARTMENTS',
          toType: 'TABLE',
          edgeType: 'FK',
          label: 'FK_EMP_DEPT',
        },
      ],
      mermaid: [
        'graph LR',
        '  EMPLOYEE_PROJECTS -->|FK_EP_EMP| EMPLOYEES',
        '  EMPLOYEE_PROJECTS -->|FK_EP_PROJ| PROJECTS',
        '  EMPLOYEES -->|FK_EMP_DEPT| DEPARTMENTS',
      ].join('\n'),
    });
  });

  it('acota el grafo a la tabla indicada como hija o como padre', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: [FK_ROWS[0]!] }));
    const h = await graphHarness(dataAccess);

    const graph = await json(h, 'get_fk_graph', { table: 'EMPLOYEE_PROJECTS' });

    expect(graph.focus).toBe('EMPLOYEE_PROJECTS');
    expect(dataAccess.calls[0]?.sql).toContain(
      'AND (c.table_name = :table_name OR p.table_name = :table_name)',
    );
    expect(dataAccess.calls[0]?.binds).toEqual([
      'DEVUSER',
      'EMPLOYEE_PROJECTS',
      'EMPLOYEE_PROJECTS',
    ]);
  });
});

describe('count_rows', () => {
  it('cuenta filas de la tabla con el schema del servidor', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: [{ CNT: 42 }] }));
    const h = await graphHarness(dataAccess);

    const result = await call(h, 'count_rows', { table: 'EMPLOYEES' });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual({
      schema: 'DEVUSER',
      table: 'EMPLOYEES',
      rowCount: 42,
    });
    // El SQL lleva el nombre cualificado, así que la tabla no necesita bind.
    expect(dataAccess.calls[0]?.binds).toBeUndefined();
  });
});

describe('get_next_sequence_value', () => {
  it('devuelve el NEXTVAL de la secuencia del schema resuelto', async () => {
    const dataAccess = new FakeDataAccess()
      .on((c) => c.sql.includes('.NEXTVAL'), () => ({ rows: [{ NEXTVAL: 42 }] }));
    const h = await graphHarness(dataAccess);

    const result = await call(h, 'get_next_sequence_value', { sequence: 'EMPLOYEE_SEQ' });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual({
      schema: 'DEVUSER',
      sequence: 'EMPLOYEE_SEQ',
      nextValue: 42,
    });
    expect(dataAccess.calls[0]?.sql).toContain('"DEVUSER"."EMPLOYEE_SEQ".NEXTVAL');
  });
});

describe('validate_fk_integrity', () => {
  it('reporta una entrada por FK con su conteo de huerfanos', async () => {
    const dataAccess = new FakeDataAccess()
      .on((c) => c.sql.includes('FROM all_constraints c'), () => ({
        rows: [
          {
            CONSTRAINT_NAME: 'FK_EP_EMP',
            CHILD_COLUMNS: 'EMPLOYEE_ID',
            PARENT_OWNER: 'DEVUSER',
            PARENT_TABLE: 'EMPLOYEES',
            PARENT_COLUMNS: 'EMPLOYEE_ID',
          },
        ],
      }))
      .on((c) => c.sql.includes('COUNT(*) AS orphans'), () => ({ rows: [{ ORPHANS: 3 }] }));
    const h = await graphHarness(dataAccess);

    const result = await call(h, 'validate_fk_integrity', { table: 'EMPLOYEE_PROJECTS' });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual([
      {
        constraint_name: 'FK_EP_EMP',
        child_columns: 'EMPLOYEE_ID',
        parent_owner: 'DEVUSER',
        parent_table: 'EMPLOYEES',
        parent_columns: 'EMPLOYEE_ID',
        orphan_count: 3,
      },
    ]);
    expect(dataAccess.calls[0]?.binds).toEqual(['DEVUSER', 'EMPLOYEE_PROJECTS', null, null]);
  });

  it('filtra por constraint y pasa el nombre dos veces como bind', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: [] }));
    const h = await graphHarness(dataAccess);

    const result = await call(h, 'validate_fk_integrity', {
      table: 'EMPLOYEE_PROJECTS',
      constraint: 'FK_EP_EMP',
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual([]);
    expect(dataAccess.calls[0]?.binds).toEqual(['DEVUSER', 'EMPLOYEE_PROJECTS', 'FK_EP_EMP', 'FK_EP_EMP']);
  });
});

describe('find_duplicates', () => {
  it('agrupa por las columnas pedidas con umbral 2 y excluye los valores NULL', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({
      rows: [{ EMAIL: 'dup@example.com', CNT: 3, SAMPLE_ROWID: 'AAA' }],
    }));
    const h = await graphHarness(dataAccess);

    const result = await call(h, 'find_duplicates', { table: 'EMPLOYEES', columns: ['EMAIL'] });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual({
      schema: 'DEVUSER',
      table: 'EMPLOYEES',
      columns: ['EMAIL'],
      minCount: 2,
      groups: [{ EMAIL: 'dup@example.com', CNT: 3, SAMPLE_ROWID: 'AAA' }],
    });
    const sql = dataAccess.calls[0]?.sql ?? '';
    expect(sql).toContain('"EMAIL" IS NOT NULL');
    expect(sql).toContain('HAVING COUNT(*) >= :minCount');
    expect(dataAccess.calls[0]?.binds).toEqual([2]);
  });

  it('rechaza una columna que no es un identificador válido', async () => {
    const h = await graphHarness();

    const result = await call(h, 'find_duplicates', {
      table: 'EMPLOYEES',
      columns: ['EMAIL; DROP TABLE X'],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('columna inválido: "EMAIL; DROP TABLE X"');
    expect(h.dataAccess.calls).toHaveLength(0);
  });
});

describe('find_free_id', () => {
  it('busca por defecto en 1..1000 y añade el MIN de los ids ocupados', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: [{ CANDIDATE_ID: 7 }] }));
    const h = await graphHarness(dataAccess);

    const result = await call(h, 'find_free_id', { table: 'EMPLOYEES', column: 'EMP_ID' });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual({
      schema: 'DEVUSER',
      table: 'EMPLOYEES',
      column: 'EMP_ID',
      maxRange: 1000,
      excludeTable: null,
      candidateId: 7,
    });
    expect(dataAccess.calls[0]?.sql).toContain('WITH candidate AS (');
    expect(dataAccess.calls[0]?.sql).not.toContain('UNION');
    expect(dataAccess.calls[0]?.binds).toEqual([1000]);
  });

  it('tope la ventana a 10000 aunque pidan más', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: [{ CANDIDATE_ID: 42 }] }));
    const h = await graphHarness(dataAccess);

    const result = await call(h, 'find_free_id', {
      table: 'EMPLOYEES',
      column: 'EMP_ID',
      maxRange: 999_999,
      excludeTable: 'EMPLOYEE_PROJECTS',
    });

    expect(JSON.parse(result.content[0]?.text ?? '')).toMatchObject({
      maxRange: 10000,
      excludeTable: 'EMPLOYEE_PROJECTS',
    });
    expect(dataAccess.calls[0]?.sql).toContain(
      'UNION SELECT "EMP_ID" FROM "DEVUSER"."EMPLOYEE_PROJECTS"',
    );
    expect(dataAccess.calls[0]?.binds).toEqual([10000]);
  });

  it('avisa cuando no queda ningún id libre en la ventana', async () => {
    const h = await graphHarness(new FakeDataAccess());

    const result = await call(h, 'find_free_id', { table: 'EMPLOYEES', column: 'EMP_ID' });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual({
      schema: 'DEVUSER',
      table: 'EMPLOYEES',
      column: 'EMP_ID',
      maxRange: 1000,
      excludeTable: null,
      candidateId: null,
    });
  });
});

/** Filas de `all_dependencies` con las etiquetas en MAYÚSCULAS. */
const DEP_ROWS = [
  {
    NAME: 'V_EMPLOYEE_DETAILS',
    TYPE: 'VIEW',
    REFERENCED_NAME: 'EMPLOYEES',
    REFERENCED_TYPE: 'TABLE',
  },
  {
    NAME: 'V_EMPLOYEE_DETAILS',
    TYPE: 'VIEW',
    REFERENCED_NAME: 'DEPARTMENTS',
    REFERENCED_TYPE: 'TABLE',
  },
  {
    NAME: 'ADD_EMPLOYEE',
    TYPE: 'PROCEDURE',
    REFERENCED_NAME: 'EMPLOYEES',
    REFERENCED_TYPE: 'TABLE',
  },
];

describe('get_dependency_graph', () => {
  it('devuelve aristas dependiente→referenciado y el diagrama Mermaid', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({ rows: DEP_ROWS }));
    const h = await graphHarness(dataAccess);

    const graph = await json(h, 'get_dependency_graph', {});

    expect(graph.edges).toEqual([
      {
        fromObject: 'DEVUSER.V_EMPLOYEE_DETAILS',
        fromType: 'VIEW',
        toObject: 'DEVUSER.EMPLOYEES',
        toType: 'TABLE',
        edgeType: 'DEPENDS_ON',
        label: 'V_EMPLOYEE_DETAILS -> EMPLOYEES',
      },
      {
        fromObject: 'DEVUSER.V_EMPLOYEE_DETAILS',
        fromType: 'VIEW',
        toObject: 'DEVUSER.DEPARTMENTS',
        toType: 'TABLE',
        edgeType: 'DEPENDS_ON',
        label: 'V_EMPLOYEE_DETAILS -> DEPARTMENTS',
      },
      {
        fromObject: 'DEVUSER.ADD_EMPLOYEE',
        fromType: 'PROCEDURE',
        toObject: 'DEVUSER.EMPLOYEES',
        toType: 'TABLE',
        edgeType: 'DEPENDS_ON',
        label: 'ADD_EMPLOYEE -> EMPLOYEES',
      },
    ]);
    expect(graph.graphType).toBe('DEPENDENCY');
    expect(graph.focus).toBeNull();
    expect(graph.mermaid).toBe(
      [
        'graph LR',
        '  V_EMPLOYEE_DETAILS --> EMPLOYEES',
        '  V_EMPLOYEE_DETAILS --> DEPARTMENTS',
        '  ADD_EMPLOYEE --> EMPLOYEES',
      ].join('\n'),
    );
  });

  it('filtra por name y por type, y deduplica aristas repetidas en el Mermaid', async () => {
    const dataAccess = new FakeDataAccess().always(() => ({
      rows: [DEP_ROWS[0]!, DEP_ROWS[0]!, DEP_ROWS[1]!],
    }));
    const h = await graphHarness(dataAccess);

    const graph = await json(h, 'get_dependency_graph', {
      name: 'V_EMPLOYEE_DETAILS',
      type: 'VIEW',
    });

    expect(graph.focus).toBe('V_EMPLOYEE_DETAILS');
    expect(dataAccess.calls[0]?.sql).toContain('AND d.name = :name');
    expect(dataAccess.calls[0]?.sql).toContain('AND d.type = :type');
    expect(dataAccess.calls[0]?.binds).toEqual(['DEVUSER', 'V_EMPLOYEE_DETAILS', 'VIEW']);
    // La arista repetida no llega a duplicarse en el diagrama.
    expect(graph.mermaid).toBe(
      [
        'graph LR',
        '  V_EMPLOYEE_DETAILS --> EMPLOYEES',
        '  V_EMPLOYEE_DETAILS --> DEPARTMENTS',
      ].join('\n'),
    );
  });
});
