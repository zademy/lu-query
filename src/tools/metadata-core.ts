import { Readable } from 'node:stream';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withToolContext } from '../audit/context.js';
import { resolveSchema } from '../catalog/schema.js';
import type { DataAccess } from '../db/data-access.js';
import type { OracleBind, OracleRow } from '../db/oracle-types.js';
import { guardTool } from '../errors.js';
import { assertIdentifier } from '../security/identifiers.js';
import type { ServerContext } from '../server.js';

/** Substring del cliente → patrón LIKE de Oracle (`LikePatterns` del Java). */
function likePattern(namePattern: string | undefined): string {
  if (namePattern === undefined || namePattern.trim() === '') return '%';
  if (namePattern.includes('%') || namePattern.includes('_')) return namePattern.toUpperCase();
  return `%${namePattern.toUpperCase()}%`;
}

/** Filtro opcional de owner: sin schema, el predicado `IS NULL` matchea todo. */
function ownerBinds(schema: string | undefined): OracleBind[] {
  return [schema ?? null, schema ?? null];
}

/** Valor del diccionario a texto (null/undefined → cadena vacía). */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return value === null || value === undefined ? '' : (JSON.stringify(value) ?? '');
}

export async function listSchemas(dataAccess: DataAccess): Promise<string[]> {
  const rows = await dataAccess.queryForList('SELECT username FROM all_users ORDER BY username');
  return rows.map((row) => asText(row.USERNAME));
}

export async function listTables(
  dataAccess: DataAccess,
  schema: string | undefined,
  namePattern: string | undefined,
): Promise<OracleRow[]> {
  return dataAccess.queryForList(
    `SELECT owner AS schema_name, table_name
FROM all_tables
WHERE (:schema IS NULL OR owner = :schema)
AND table_name LIKE :pattern ESCAPE '\\'
ORDER BY owner, table_name`,
    [...ownerBinds(schema), likePattern(namePattern)],
  );
}

export async function listViews(
  dataAccess: DataAccess,
  schema: string | undefined,
  namePattern: string | undefined,
): Promise<OracleRow[]> {
  return dataAccess.queryForList(
    `SELECT owner AS schema_name, view_name
FROM all_views
WHERE (:schema IS NULL OR owner = :schema)
AND view_name LIKE :pattern ESCAPE '\\'
ORDER BY owner, view_name`,
    [...ownerBinds(schema), likePattern(namePattern)],
  );
}

/**
 * Columnas de una tabla con tipo, nulabilidad, default y comentario, por posición.
 * El bind de la tabla es `:name` y no `:table` como en el Java: `TABLE` es
 * palabra reservada de Oracle y el driver rechaza ese nombre (ORA-01745).
 */
export async function describeTable(
  dataAccess: DataAccess,
  schema: string,
  table: string,
): Promise<OracleRow[]> {
  return dataAccess.queryForList(
    `SELECT t.column_name,
       t.data_type ||
         CASE WHEN t.data_type IN ('CHAR','VARCHAR2','NCHAR','NVARCHAR2','RAW')
              THEN '(' || t.data_length || ')'
              WHEN t.data_precision IS NOT NULL
              THEN '(' || t.data_precision || COALESCE(',' || NULLIF(t.data_scale, 0), '') || ')'
              ELSE '' END AS data_type,
       t.nullable,
       t.data_default,
       COALESCE(c.comments, '') AS comments,
       t.column_id
FROM all_tab_columns t
LEFT JOIN all_col_comments c
  ON c.owner = t.owner AND c.table_name = t.table_name AND c.column_name = t.column_name
WHERE t.owner = :schema AND t.table_name = :name
ORDER BY t.column_id`,
    [schema, table],
  );
}

/** Existencia de tabla (solo ALL_TABLES: las vistas no cuentan), como el Java. */
export async function tableExists(
  dataAccess: DataAccess,
  schema: string,
  table: string,
): Promise<boolean> {
  const row = await dataAccess.queryForObject(
    'SELECT COUNT(*) AS cnt FROM all_tables WHERE owner = :schema AND table_name = :name',
    [schema, table],
  );
  return Number(row?.CNT ?? 0) > 0;
}

export async function listObjects(
  dataAccess: DataAccess,
  schema: string | undefined,
  type: string | undefined,
): Promise<OracleRow[]> {
  return dataAccess.queryForList(
    `SELECT owner AS schema_name, object_name, object_type, status
FROM all_objects
WHERE (:schema IS NULL OR owner = :schema)
AND (:type IS NULL OR object_type = :type)
ORDER BY owner, object_type, object_name`,
    [...ownerBinds(schema), type ?? null, type ?? null],
  );
}

export async function searchObjects(
  dataAccess: DataAccess,
  namePattern: string,
  type: string | undefined,
): Promise<OracleRow[]> {
  return dataAccess.queryForList(
    `SELECT owner AS schema_name, object_name, object_type, status
FROM all_objects
WHERE object_name LIKE :pattern ESCAPE '\\'
AND (:type IS NULL OR object_type = :type)
ORDER BY owner, object_type, object_name`,
    [likePattern(namePattern), type ?? null, type ?? null],
  );
}

/** Subconjunto de ALL_OBJECTS que GET_DDL sabe reconstruir. */
const DDL_OBJECT_EXCLUSIONS =
  "('INDEX PARTITION','TABLE PARTITION','LOB','TABLE SUBPARTITION','INDEX SUBPARTITION')";

const RESOLVE_OBJECT_SQL = `SELECT owner, object_name, object_type
FROM all_objects
WHERE UPPER(owner) = UPPER(:schema)
AND UPPER(object_name) = UPPER(:name)
AND UPPER(object_type) = UPPER(:type)
AND object_type NOT IN ${DDL_OBJECT_EXCLUSIONS}
ORDER BY object_type
FETCH FIRST 1 ROWS ONLY`;

const GET_DDL_SQL = 'SELECT DBMS_METADATA.GET_DDL(:type, :name, :schema) AS ddl FROM dual';

/** El driver thin entrega el CLOB como stream: sin fetchAsString hay que leerlo. */
async function clobText(value: unknown): Promise<string> {
  if (typeof value === 'string') return value;
  if (value instanceof Readable) {
    let text = '';
    for await (const chunk of value as AsyncIterable<string | Uint8Array>) {
      text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    }
    return text;
  }
  return asText(value);
}

/**
 * DDL de un objeto vía DBMS_METADATA (solo lectura). GET_DDL es
 * case-sensitive: primero se resuelve el owner/nombre/tipo exactos en
 * ALL_OBJECTS comparando sin distinguir mayúsculas, y se le pasa a GET_DDL
 * el valor guardado; así un nombre en minúsculas nunca acaba en ORA-31603.
 */
export async function getDdl(
  dataAccess: DataAccess,
  schema: string,
  name: string,
  type: string,
): Promise<string> {
  const hit = (await dataAccess.queryForList(RESOLVE_OBJECT_SQL, [schema, name, type]))[0];
  if (hit === undefined) {
    throw new Error(
      `Object ${schema}.${name} of type ${type} was not found in ALL_OBJECTS (visible to the current user). ` +
        'Verify the schema/name/type, the per-object SELECT grant, and SELECT_CATALOG_ROLE; for DDL the user ' +
        'also needs EXECUTE on SYS.DBMS_METADATA (see db/setup_least_privilege_user.sql).',
    );
  }
  const row = await dataAccess.queryForList(GET_DDL_SQL, [
    asText(hit.OBJECT_TYPE),
    asText(hit.OBJECT_NAME),
    asText(hit.OWNER),
  ]);
  return clobText(Object.values(row[0] ?? {})[0]);
}

/** Igual que `getDdl`, pero detectando el tipo en ALL_OBJECTS (recurso MCP). */
export async function getDdlAuto(
  dataAccess: DataAccess,
  schema: string,
  name: string,
): Promise<string | null> {
  const rows = await dataAccess.queryForList(
    `SELECT object_type
FROM all_objects
WHERE owner = :schema AND object_name = :name
AND object_type NOT IN ${DDL_OBJECT_EXCLUSIONS}
ORDER BY object_type
FETCH FIRST 1 ROWS ONLY`,
    [schema, name],
  );
  const type = rows[0]?.OBJECT_TYPE;
  return type === undefined ? null : getDdl(dataAccess, schema, name, asText(type));
}

/** Texto de una celda del diccionario para el recurso tabular (null → vacío). */
function cell(row: OracleRow, key: string): string {
  return asText(row[key]);
}

/** Fila del `String.format("%-30s %-30s %-8s %-20s %s")` del recurso Java. */
function columnsRow(
  name: string,
  type: string,
  nullable: string,
  def: string,
  comments: string,
): string {
  return [
    name.padEnd(30),
    type.padEnd(30),
    nullable.padEnd(8),
    def.trim().padEnd(20),
    comments,
  ].join(' ');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function plain(
  uri: string,
  text: string,
): { contents: { uri: string; mimeType: string; text: string }[] } {
  return { contents: [{ uri, mimeType: 'text/plain', text }] };
}

const TABLE_URI = 'oracle://schema/{schema}/table/{table}';
const DDL_URI = 'oracle://schema/{schema}/object/{object}/ddl';

/**
 * Metadata núcleo — schemas, tablas, vistas, objetos y DDL (`MetadataTools` del
 * Java) más los dos recursos de schema de `OracleResources`. Todo son queries de
 * diccionario con binds; los identificadores que da el cliente pasan por la
 * allow-list y nada se modifica.
 */
export function registerMetadataCore(ctx: ServerContext): void {
  const { dataAccess } = ctx;

  ctx.server.registerTool(
    'list_schemas',
    {
      description: 'List all Oracle schemas (users) visible to the current connection.',
    },
    async () =>
      // El contexto de auditoría viaja por AsyncLocalStorage hasta el DataAccess.
      withToolContext('list_schemas', {}, () =>
        guardTool(async () => ({
          content: [{ type: 'text' as const, text: JSON.stringify(await listSchemas(dataAccess)) }],
        })),
      ),
  );

  ctx.server.registerTool(
    'list_tables',
    {
      description:
        "List tables. Supports an optional schema and a case-insensitive LIKE name pattern (use '%' and '_' wildcards; defaults to '%').",
      inputSchema: {
        schema: z.string().describe('Schema (owner) name. Omit to search all schemas.').optional(),
        namePattern: z
          .string()
          .describe("LIKE pattern for the table name, e.g. 'EMP%' or '%EMP%'. Defaults to '%'.")
          .optional(),
      },
    },
    async (args) =>
      withToolContext('list_tables', args, () =>
        guardTool(async () => ({
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(await listTables(dataAccess, args.schema, args.namePattern)),
            },
          ],
        })),
      ),
  );

  ctx.server.registerTool(
    'list_views',
    {
      description:
        "List views. Optional schema and case-insensitive LIKE name pattern (defaults to '%').",
      inputSchema: {
        schema: z.string().describe('Schema (owner) name. Omit to search all schemas.').optional(),
        namePattern: z
          .string()
          .describe("LIKE pattern for the view name. Defaults to '%'.")
          .optional(),
      },
    },
    async (args) =>
      withToolContext('list_views', args, () =>
        guardTool(async () => ({
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(await listViews(dataAccess, args.schema, args.namePattern)),
            },
          ],
        })),
      ),
  );

  ctx.server.registerTool(
    'describe_table',
    {
      description:
        'Describe the columns of a table: name, data type, nullability, default value and comment. ALWAYS call this before writing a SELECT/INSERT/UPDATE against an unverified table, so column names and types are known rather than invented.',
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
      withToolContext('describe_table', args, () =>
        guardTool(async () => ({
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                await describeTable(
                  dataAccess,
                  resolveSchema(args.schema, ctx.config.schema, 'describe_table'),
                  assertIdentifier(args.table, 'tabla'),
                ),
              ),
            },
          ],
        })),
      ),
  );

  ctx.server.registerTool(
    'table_exists',
    {
      description:
        'Return true if a table exists (checked via ALL_TABLES; views are NOT considered). Use this instead of run_query {SELECT 1 FROM ALL_TABLES WHERE ...}.',
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
      withToolContext('table_exists', args, () =>
        guardTool(async () => ({
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                await tableExists(
                  dataAccess,
                  resolveSchema(args.schema, ctx.config.schema, 'table_exists'),
                  assertIdentifier(args.table, 'tabla'),
                ),
              ),
            },
          ],
        })),
      ),
  );

  ctx.server.registerTool(
    'search_objects',
    {
      description:
        'Search database objects by a case-insensitive LIKE name pattern, optionally filtered by object type.',
      inputSchema: {
        namePattern: z
          .string()
          .describe("LIKE pattern for the object name, e.g. 'EMP%' or '%ORDER%'."),
        type: z.string().describe("Optional object type filter, e.g. 'TABLE', 'VIEW'.").optional(),
      },
    },
    async (args) =>
      withToolContext('search_objects', args, () =>
        guardTool(async () => ({
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                await searchObjects(
                  dataAccess,
                  args.namePattern,
                  args.type === undefined ? undefined : assertIdentifier(args.type, 'tipo'),
                ),
              ),
            },
          ],
        })),
      ),
  );

  ctx.server.registerTool(
    'list_objects',
    {
      description:
        'List database objects (tables, views, packages, procedures, functions, ...). Optional schema and object type filter.',
      inputSchema: {
        schema: z.string().describe('Schema (owner) name. Omit to search all schemas.').optional(),
        type: z
          .string()
          .describe("Object type filter, e.g. 'PROCEDURE', 'FUNCTION', 'PACKAGE', 'VIEW'.")
          .optional(),
      },
    },
    async (args) =>
      withToolContext('list_objects', args, () =>
        guardTool(async () => ({
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                await listObjects(
                  dataAccess,
                  args.schema,
                  args.type === undefined ? undefined : assertIdentifier(args.type, 'tipo'),
                ),
              ),
            },
          ],
        })),
      ),
  );

  ctx.server.registerTool(
    'get_ddl',
    {
      description:
        'Return the DDL definition of an object as a CLOB string, using DBMS_METADATA.GET_DDL. Read-only: never executes the DDL. All three parameters (schema, name, type) are REQUIRED. Valid type values: TABLE, VIEW, INDEX, SEQUENCE, PROCEDURE, FUNCTION, PACKAGE, PACKAGE BODY, TRIGGER, TYPE, SYNONYM, DB LINK. schema/name/type are matched case-insensitively against ALL_OBJECTS (lowercase is fine) and the exact stored object is passed to GET_DDL, so a case mismatch never surfaces as ORA-31603. Requires SELECT_CATALOG_ROLE plus EXECUTE on SYS.DBMS_METADATA (granted in db/setup_least_privilege_user.sql); privilege or not-found failures surface as error results.',
      inputSchema: {
        schema: z
          .string()
          .describe(
            "Schema (owner) of the object. Optional — defaults to the server's current schema; omit rather than guess.",
          )
          .optional(),
        name: z.string().describe('Object name.'),
        type: z
          .string()
          .describe(
            "Object type, e.g. 'TABLE', 'VIEW', 'INDEX', 'PROCEDURE', 'FUNCTION', 'PACKAGE', 'SEQUENCE', 'TRIGGER'.",
          ),
      },
    },
    async (args) =>
      withToolContext('get_ddl', args, () =>
        guardTool(async () => ({
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                await getDdl(
                  dataAccess,
                  resolveSchema(args.schema, ctx.config.schema, 'get_ddl'),
                  assertIdentifier(args.name, 'nombre'),
                  assertIdentifier(args.type, 'tipo'),
                ),
              ),
            },
          ],
        })),
      ),
  );

  ctx.server.registerResource(
    'table-description',
    // Sin `list`: como en el Java, estos recursos se resuelven por URI, no se enumeran.
    new ResourceTemplate(TABLE_URI, { list: undefined }),
    {
      title: 'Descripción de tabla',
      description:
        'Column-level description of an Oracle table or view (columns, types, nullability, defaults, comments)',
      mimeType: 'text/plain',
    },
    async (uri, variables) => {
      const schema = assertIdentifier(String(variables.schema), 'schema');
      const table = assertIdentifier(String(variables.table), 'tabla');
      try {
        const columns = await describeTable(dataAccess, schema, table);
        if (columns.length === 0) {
          return plain(
            uri.href,
            `(No columns found for ${schema}.${table} — the object may not exist or is not accessible.)`,
          );
        }
        const lines = columns.map((column) =>
          columnsRow(
            cell(column, 'COLUMN_NAME'),
            cell(column, 'DATA_TYPE'),
            cell(column, 'NULLABLE') === 'Y' ? 'NULL' : 'NOT NULL',
            cell(column, 'DATA_DEFAULT'),
            cell(column, 'COMMENTS'),
          ),
        );
        return plain(
          uri.href,
          [
            `Table: ${schema}.${table}`,
            '',
            columnsRow('Column', 'Type', 'Null?', 'Default', 'Comments'),
            '-'.repeat(110),
            ...lines,
            '',
          ].join('\n'),
        );
      } catch (error) {
        return plain(uri.href, `(Database error describing ${schema}.${table}: ${message(error)})`);
      }
    },
  );

  ctx.server.registerResource(
    'object-ddl',
    new ResourceTemplate(DDL_URI, { list: undefined }),
    {
      title: 'DDL de un objeto',
      description:
        'DDL source of any Oracle object (table, view, index, sequence, type, ...); type auto-detected',
      mimeType: 'text/plain',
    },
    async (uri, variables) => {
      const schema = assertIdentifier(String(variables.schema), 'schema');
      const object = assertIdentifier(String(variables.object), 'objeto');
      try {
        const ddl = await getDdlAuto(dataAccess, schema, object);
        return plain(
          uri.href,
          ddl === null ? `(Object not found: ${schema}.${object})` : ddl.trim(),
        );
      } catch (error) {
        return plain(
          uri.href,
          `(Database error extracting DDL for ${schema}.${object}: ${message(error)})`,
        );
      }
    },
  );
}
