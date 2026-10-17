import { z } from 'zod';
import { withToolContext } from '../audit/context.js';
import { resolveSchemaFor } from '../catalog/schema.js';
import type { DataAccess } from '../db/data-access.js';
import type { OracleBind, OracleRow } from '../db/oracle-types.js';
import { guardTool } from '../errors.js';
import { assertIdentifier, qualifiedName, quoteIdentifier } from '../security/identifiers.js';
import type { ServerContext } from '../server.js';

/** Una relación dirigida del grafo (`GraphEdge` del Java). */
export interface GraphEdge {
  fromObject: string;
  fromType: string;
  toObject: string;
  toType: string;
  edgeType: string;
  label: string | null;
}

/** Grafo dirigido de relaciones del schema (`SchemaGraph` del Java). */
export interface SchemaGraph {
  schema: string;
  focus: string | null;
  graphType: string;
  edges: GraphEdge[];
  mermaid: string;
}

/** Oracle devuelve las etiquetas de columna en MAYÚSCULAS si el alias no va entrecomillado. */
function str(row: OracleRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  // Nombres del diccionario: VARCHAR2 (o NUMBER si alguien coló un id).
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

/** Cadena vacía o solo espacios = ausente (paridad con `blankToNull` del Java). */
function blankToNull(value: string | undefined): string | null {
  return value === undefined || value.trim() === '' ? null : value;
}

/** Mermaid es estricto con los ids: todo fuera de `[A-Za-z0-9_]` pasa a `_`. */
function safeId(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

/** Quita el prefijo de schema de un nombre cualificado (`SCOTT.EMP` → `EMP`). */
function shortName(qualified: string): string {
  const dot = qualified.indexOf('.');
  return dot > 0 ? qualified.slice(dot + 1) : qualified;
}

/**
 * Aristas FK child→parent desde `all_constraints`, más el diagrama Mermaid.
 * El filtro de tabla incluye la tabla como hija o como padre.
 */
export async function fkGraph(
  dataAccess: DataAccess,
  schema: string,
  table: string | undefined,
): Promise<SchemaGraph> {
  const owner = assertIdentifier(schema, 'schema');
  const scoped = Boolean(table?.trim());
  // `:table` no vale: TABLE es palabra reservada y Oracle devuelve ORA-01745.
  const tableFilter = scoped
    ? ' AND (c.table_name = :table_name OR p.table_name = :table_name)'
    : '';
  // Solo los binds que el SQL usa: node-oracledb rechaza los sobrantes (NJS-098)
  // y `:table_name` aparece dos veces (hija o padre), así que va dos veces.
  const binds: OracleBind[] = scoped ? [owner, assertIdentifier(table!, 'table'), table!] : [owner];

  const rows = await dataAccess.queryForList(
    `SELECT c.table_name AS child_table,
       c.constraint_name AS fk_name,
       p.owner AS parent_owner,
       p.table_name AS parent_table
FROM all_constraints c
JOIN all_constraints p
  ON c.r_owner = p.owner AND c.r_constraint_name = p.constraint_name
WHERE c.owner = :schema
  AND c.constraint_type = 'R'${tableFilter}
ORDER BY c.table_name, p.table_name`,
    binds,
  );

  const edges: GraphEdge[] = [];
  for (const row of rows) {
    const child = str(row, 'CHILD_TABLE');
    const parent = str(row, 'PARENT_TABLE');
    if (child === null || parent === null) continue;
    edges.push({
      fromObject: `${owner}.${child}`,
      fromType: 'TABLE',
      toObject: `${str(row, 'PARENT_OWNER')}.${parent}`,
      toType: 'TABLE',
      edgeType: 'FK',
      label: str(row, 'FK_NAME'),
    });
  }

  return {
    schema: owner,
    focus: blankToNull(table),
    graphType: 'FK',
    edges,
    mermaid: mermaidFk(edges),
  };
}

/** `graph LR` de nodos `TABLA` con arista etiquetada por el nombre de la FK. */
function mermaidFk(edges: GraphEdge[]): string {
  const lines = ['graph LR'];
  const seen = new Set<string>();
  for (const edge of edges) {
    const key = `${safeId(edge.fromObject)}->${safeId(edge.toObject)}|${edge.label ?? 'fk'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = safeId(edge.label ?? 'fk');
    lines.push(
      `  ${safeId(shortName(edge.fromObject))} -->|${label}| ${safeId(shortName(edge.toObject))}`,
    );
  }
  return lines.join('\n');
}

/**
 * Aristas dependiente→referenciado desde `all_dependencies`, más el diagrama
 * Mermaid. Los filtros de nombre y tipo solo se aplican si vienen informedos.
 */
export async function dependencyGraph(
  dataAccess: DataAccess,
  schema: string,
  name: string | undefined,
  type: string | undefined,
): Promise<SchemaGraph> {
  const owner = assertIdentifier(schema, 'schema');
  const binds: OracleBind[] = [owner];
  let filters = '';
  if (name?.trim()) {
    filters += ' AND d.name = :name';
    binds.push(assertIdentifier(name, 'name'));
  }
  if (type?.trim()) {
    filters += ' AND d.type = :type';
    binds.push(assertIdentifier(type, 'type'));
  }

  const rows = await dataAccess.queryForList(
    `SELECT d.name, d.type, d.referenced_name, d.referenced_type
FROM all_dependencies d
WHERE d.owner = :schema${filters}
ORDER BY d.name, d.referenced_name`,
    binds,
  );

  const edges: GraphEdge[] = [];
  for (const row of rows) {
    const from = str(row, 'NAME');
    const to = str(row, 'REFERENCED_NAME');
    if (from === null || to === null) continue;
    edges.push({
      fromObject: `${owner}.${from}`,
      fromType: str(row, 'TYPE') ?? 'UNKNOWN',
      toObject: `${owner}.${to}`,
      toType: str(row, 'REFERENCED_TYPE') ?? 'UNKNOWN',
      edgeType: 'DEPENDS_ON',
      label: `${from} -> ${to}`,
    });
  }

  return {
    schema: owner,
    focus: blankToNull(name),
    graphType: 'DEPENDENCY',
    edges,
    mermaid: mermaidDeps(edges),
  };
}

/** `graph LR` de aristas sin etiqueta: la forma `VISTA --> TABLA`. */
function mermaidDeps(edges: GraphEdge[]): string {
  const lines = ['graph LR'];
  const seen = new Set<string>();
  for (const edge of edges) {
    const key = `${safeId(edge.fromObject)}->${safeId(edge.toObject)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`  ${safeId(shortName(edge.fromObject))} --> ${safeId(shortName(edge.toObject))}`);
  }
  return lines.join('\n');
}

/** Registra las tools de grafos y los data helpers. */
/** CSV de columnas del diccionario: LISTAGG devuelve string, lo demas es ruido. */
function csv(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * `validate_fk_integrity`: una fila por FK de la tabla con su conteo de
 * huérfanos (`DataHelpersService.validateFkIntegrity` del Java). Lista vacía
 * = integridad intacta. `:con` aparece dos veces, así que viaja dos
 * veces en los binds posicionales.
 */
async function validateFkIntegrity(
  dataAccess: DataAccess,
  schema: string,
  table: string,
  constraint: string | null,
): Promise<OracleRow[]> {
  const fks = await dataAccess.queryForList(
    `SELECT c.constraint_name AS constraint_name,
            (SELECT LISTAGG(cc.column_name, ', ') WITHIN GROUP (ORDER BY cc.position)
               FROM all_cons_columns cc
              WHERE cc.owner = c.owner AND cc.constraint_name = c.constraint_name) AS child_columns,
            c.r_owner AS parent_owner,
            pc.table_name AS parent_table,
            (SELECT LISTAGG(rc.column_name, ', ') WITHIN GROUP (ORDER BY rc.position)
               FROM all_cons_columns rc
              WHERE rc.owner = c.r_owner AND rc.constraint_name = c.r_constraint_name) AS parent_columns
       FROM all_constraints c
       JOIN all_constraints pc ON pc.owner = c.r_owner AND pc.constraint_name = c.r_constraint_name
      WHERE c.owner = :own AND c.table_name = :tab
        AND c.constraint_type = 'R'
        AND (:con IS NULL OR c.constraint_name = :con)`,
    [schema, table, constraint, constraint],
  );

  const results: OracleRow[] = [];
  for (const fk of fks) {
    // Nombres del diccionario de Oracle: vienen validados y en MAYÚSCULAS.
    const childColumns = csv(fk.CHILD_COLUMNS)
      .split(',')
      .map((c) => c.trim());
    const parentColumns = csv(fk.PARENT_COLUMNS)
      .split(',')
      .map((c) => c.trim());
    const parentRef = qualifiedName(
      str(fk, 'PARENT_OWNER') ?? schema,
      assertIdentifier(str(fk, 'PARENT_TABLE') ?? '', 'parent_table'),
    );
    const cols = (alias: string, columns: string[]) =>
      columns.map((column) => `${alias}."${column}"`).join(', ');
    const orphanRow = await dataAccess.queryForObject(
      `SELECT COUNT(*) AS orphans FROM ${qualifiedName(schema, table)} c
        WHERE (${cols('c', childColumns)}) NOT IN
              (SELECT ${cols('p', parentColumns)} FROM ${parentRef} p)`,
    );
    results.push({
      constraint_name: fk.CONSTRAINT_NAME,
      child_columns: fk.CHILD_COLUMNS,
      parent_owner: fk.PARENT_OWNER,
      parent_table: fk.PARENT_TABLE,
      parent_columns: fk.PARENT_COLUMNS,
      orphan_count: Number(orphanRow?.ORPHANS ?? 0),
    });
  }
  return results;
}

export function registerGraph(ctx: ServerContext): void {
  ctx.server.registerTool(
    'find_free_id',
    {
      description:
        'Find a free id for a new row: scans 1..maxRange (default 1000, capped at 10000) and returns the lowest value not already used, so a key can be inserted without a sequence.',
      inputSchema: {
        schema: z
          .string()
          .describe(
            "Schema (owner) of the table. Optional — defaults to the server's current schema; omit rather than guess.",
          )
          .optional(),
        table: z.string().describe('Table name.'),
        column: z.string().describe('Numeric id column to search for a free value.'),
        maxRange: z
          .number()
          .int()
          .min(1)
          .describe(
            'Inclusive upper bound of the search window. Defaults to 1000; capped at 10000.',
          )
          .optional(),
        excludeTable: z
          .string()
          .describe(
            'Optional second table (same schema, same column) whose ids must also be avoided.',
          )
          .optional(),
      },
    },
    async (args) =>
      withToolContext('find_free_id', args, () =>
        guardTool(async () => {
          const owner = await resolveSchemaFor(ctx, args.schema, 'find_free_id');
          const table = assertIdentifier(args.table, 'table');
          const column = assertIdentifier(args.column, 'columna');
          const maxRange = Math.min(args.maxRange ?? 1000, 10_000);
          const exclude = args.excludeTable?.trim()
            ? assertIdentifier(args.excludeTable, 'excludeTable')
            : null;
          const used = exclude
            ? `SELECT "${column}" FROM ${qualifiedName(owner, table)}
UNION SELECT "${column}" FROM ${qualifiedName(owner, exclude)}`
            : `SELECT "${column}" FROM ${qualifiedName(owner, table)}`;
          const row = await ctx.dataAccess.queryForObject(
            // `SELECT i FROM dual` no lee la pseudocolumna: hay que nombrar LEVEL.
            `WITH candidate AS (SELECT LEVEL AS i FROM dual CONNECT BY LEVEL <= :max_range),
used AS (${used})
SELECT MIN(c.i) AS candidate_id
FROM candidate c
WHERE NOT EXISTS (SELECT 1 FROM used u WHERE u."${column}" = c.i)`,
            [maxRange],
          );
          const result = {
            schema: owner,
            table,
            column,
            maxRange,
            excludeTable: exclude,
            candidateId:
              row?.CANDIDATE_ID === null || row?.CANDIDATE_ID === undefined
                ? null
                : Number(row.CANDIDATE_ID),
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        }),
      ),
  );

  ctx.server.registerTool(
    'find_duplicates',
    {
      description:
        'Find duplicate value groups in one or more columns of a table (excluding NULLs). Groups at or above minCount (default 2) come back with a COUNT and a sample ROWID.',
      inputSchema: {
        schema: z
          .string()
          .describe(
            "Schema (owner) of the table. Optional — defaults to the server's current schema; omit rather than guess.",
          )
          .optional(),
        table: z.string().describe('Table name.'),
        columns: z.array(z.string()).min(1).describe('Columns to compare together.'),
        minCount: z
          .number()
          .int()
          .min(1)
          .describe('Minimum occurrences of a group. Defaults to 2.')
          .optional(),
      },
    },
    async (args) =>
      withToolContext('find_duplicates', args, () =>
        guardTool(async () => {
          const owner = await resolveSchemaFor(ctx, args.schema, 'find_duplicates');
          const table = assertIdentifier(args.table, 'table');
          const cols = args.columns.map((column) => quoteIdentifier(column, 'columna'));
          const minCount = args.minCount ?? 2;
          const notNull = cols.map((column) => `${column} IS NOT NULL`).join(' AND ');
          const rows = await ctx.dataAccess.queryForList(
            `SELECT ${cols.join(', ')},
       COUNT(*) AS cnt,
       MIN(ROWIDTOCHAR(ROWID)) AS sample_rowid
FROM ${qualifiedName(owner, table)}
WHERE ${notNull}
GROUP BY ${cols.join(', ')}
HAVING COUNT(*) >= :minCount
ORDER BY COUNT(*) DESC`,
            [minCount],
          );
          const result = { schema: owner, table, columns: args.columns, minCount, groups: rows };
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        }),
      ),
  );

  ctx.server.registerTool(
    'count_rows',
    {
      description:
        'Count rows in a table without running SQL. Useful to size a table before indexing, partitioning or sampling.',
      inputSchema: {
        schema: z
          .string()
          .describe(
            "Schema (owner) of the table. Optional — defaults to the server's current schema; omit rather than guess.",
          )
          .optional(),
        table: z.string().describe('Table name.'),
      },
    },
    async (args) =>
      withToolContext('count_rows', args, () =>
        guardTool(async () => {
          const owner = await resolveSchemaFor(ctx, args.schema, 'count_rows');
          const table = assertIdentifier(args.table, 'table');
          const row = await ctx.dataAccess.queryForObject(
            `SELECT COUNT(*) AS cnt FROM ${qualifiedName(owner, table)}`,
          );
          const result = {
            schema: owner,
            table,
            rowCount: row?.CNT === null || row?.CNT === undefined ? 0 : Number(row.CNT),
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        }),
      ),
  );

  ctx.server.registerTool(
    'get_next_sequence_value',
    {
      description:
        'Return the NEXTVAL of a sequence. WARNING: this is a side-effecting read — calling it advances the sequence counter and the consumed value cannot be reused. When the sequence has cache > 0 the returned value may already be consumed elsewhere; before using it as a key, verify it is not already present in the target table. Use sparingly.',
      inputSchema: {
        schema: z
          .string()
          .describe(
            "Schema (owner) of the sequence. Optional — defaults to the server's current schema; omit rather than guess.",
          )
          .optional(),
        sequence: z.string().describe('Sequence name.'),
      },
    },
    async (args) =>
      withToolContext('get_next_sequence_value', args, () =>
        guardTool(async () => {
          const owner = await resolveSchemaFor(ctx, args.schema, 'get_next_sequence_value');
          const sequence = assertIdentifier(args.sequence, 'sequence');
          const row = await ctx.dataAccess.queryForObject(
            `SELECT ${qualifiedName(owner, sequence)}.NEXTVAL AS nextval FROM dual`,
          );
          const result = { schema: owner, sequence, nextValue: Number(row?.NEXTVAL ?? 0) };
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        }),
      ),
  );

  ctx.server.registerTool(
    'validate_fk_integrity',
    {
      description:
        'Check one or all foreign keys of a table and report orphan rows (child rows whose parent is missing). Returns one entry per FK with constraint name, child/parent columns and the orphan count; an empty list means referential integrity is intact.',
      inputSchema: {
        schema: z
          .string()
          .describe(
            "Schema (owner) of the table. Optional — defaults to the server's current schema; omit rather than guess.",
          )
          .optional(),
        table: z.string().describe('Table name.'),
        constraint: z
          .string()
          .describe('Optional constraint-name filter; omit to check every FK on the table.')
          .optional(),
      },
    },
    async (args) =>
      withToolContext('validate_fk_integrity', args, () =>
        guardTool(async () => {
          const owner = await resolveSchemaFor(ctx, args.schema, 'validate_fk_integrity');
          const table = assertIdentifier(args.table, 'table');
          const fks = await validateFkIntegrity(
            ctx.dataAccess,
            owner,
            table,
            blankToNull(args.constraint),
          );
          return { content: [{ type: 'text' as const, text: JSON.stringify(fks) }] };
        }),
      ),
  );

  ctx.server.registerTool(
    'get_dependency_graph',
    {
      description:
        'Build an object-dependency graph for a schema using all_dependencies. Returns directed edges (dependent→referenced) filtered by optional name/type, plus a Mermaid diagram string.',
      inputSchema: {
        schema: z
          .string()
          .describe(
            "Schema (owner) to inspect. Optional — defaults to the server's current schema; omit rather than guess.",
          )
          .optional(),
        name: z.string().describe('Optional object name to scope the graph.').optional(),
        type: z
          .string()
          .describe('Optional object-type filter (TABLE, VIEW, PROCEDURE, PACKAGE, …).')
          .optional(),
      },
    },
    async (args) =>
      withToolContext('get_dependency_graph', args, () =>
        guardTool(async () => {
          const graph = await dependencyGraph(
            ctx.dataAccess,
            await resolveSchemaFor(ctx, args.schema, 'get_dependency_graph'),
            args.name,
            args.type,
          );
          return { content: [{ type: 'text' as const, text: JSON.stringify(graph) }] };
        }),
      ),
  );

  ctx.server.registerTool(
    'get_fk_graph',
    {
      description:
        'Build a foreign-key relationship graph for a schema or a single table. Returns directed edges (child→parent) and a Mermaid diagram string.',
      inputSchema: {
        schema: z
          .string()
          .describe(
            "Schema (owner) to inspect. Optional — defaults to the server's current schema; omit rather than guess.",
          )
          .optional(),
        table: z
          .string()
          .describe('Optional table name to scope the graph. Leave blank for the entire schema.')
          .optional(),
      },
    },
    async (args) =>
      withToolContext('get_fk_graph', args, () =>
        guardTool(async () => {
          const graph = await fkGraph(
            ctx.dataAccess,
            await resolveSchemaFor(ctx, args.schema, 'get_fk_graph'),
            args.table,
          );
          return { content: [{ type: 'text' as const, text: JSON.stringify(graph) }] };
        }),
      ),
  );
}
