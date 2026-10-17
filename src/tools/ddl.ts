import { z } from 'zod';
import { withToolContext } from '../audit/context.js';
import { resolveSchema } from '../catalog/schema.js';
import { guardTool, SecurityError } from '../errors.js';
import { qualifiedName, quoteCsv, quoteIdentifier, quoteLiteral } from '../security/identifiers.js';
import type { ServerContext } from '../server.js';

/**
 * Ddl — comentarios de metadata y helpers DDL estilo create, port 1:1 del
 * `DdlTools` del Java. Los identificadores de usuario se validan contra la
 * allow-list y se entrecomillan antes de concatenarse (no se pueden bindar);
 * los literales escapan la comilla simple.
 *
 * El usuario MCP de mínimo privilegio no tiene privilegios DDL ni cuota de
 * tablespace, así que Oracle responde ORA-01031 / ORA-01950: el servidor Oracle
 * es la barrera de seguridad y el error vuelve como `isError` con su hint.
 */

/** Sufijo común de todas las tools: el schema es opcional y cae al configurado. */
const SCHEMA_OPTIONAL =
  " Optional — defaults to the server's current schema; omit rather than guess.";

/** Param `schema` opcional con la descripción verbatim del Java. */
function optionalSchema(owner: string) {
  return z.string().describe(`${owner}${SCHEMA_OPTIONAL}`).optional();
}

/** Schema efectivo: el pedido gana; si no, el configurado (o error si no hay). */
function owner(ctx: ServerContext, requested: string | undefined, tool: string): string {
  return resolveSchema(requested, ctx.config.schema, tool);
}

function text(value: string): { type: 'text'; text: string } {
  return { type: 'text', text: value };
}

async function commentOnTable(ctx: ServerContext, args: CommentArgs): Promise<string> {
  const schema = owner(ctx, args.schema, 'comment_on_table');
  await ctx.dataAccess.execute(
    `COMMENT ON TABLE ${qualifiedName(schema, args.table)} IS ${quoteLiteral(args.comment)}`,
  );
  return `Comment applied to table ${schema}.${args.table}`;
}

async function commentOnColumn(ctx: ServerContext, args: ColumnCommentArgs): Promise<string> {
  const schema = owner(ctx, args.schema, 'comment_on_column');
  await ctx.dataAccess.execute(
    `COMMENT ON COLUMN ${qualifiedName(schema, args.table)}.${quoteIdentifier(args.column, 'columna')} IS ${quoteLiteral(args.comment)}`,
  );
  return `Comment applied to column ${schema}.${args.table}.${args.column}`;
}

async function createOrReplaceView(ctx: ServerContext, args: ViewArgs): Promise<string> {
  const schema = owner(ctx, args.schema, 'create_or_replace_view');
  // Oracle es quien parsea el cuerpo; solo se comprueba que sea un SELECT.
  if (!args.selectBody.trim().toUpperCase().startsWith('SELECT')) {
    throw new SecurityError('selectBody must be a SELECT statement.');
  }
  await ctx.dataAccess.execute(
    `CREATE OR REPLACE VIEW ${qualifiedName(schema, args.view)} AS ${args.selectBody}`,
  );
  return `View ${schema}.${args.view} created (or replaced).`;
}

async function createSynonym(ctx: ServerContext, args: SynonymArgs): Promise<string> {
  const schema = owner(ctx, args.schema, 'create_synonym');
  await ctx.dataAccess.execute(
    `CREATE ${args.isPublic ? 'PUBLIC ' : ''}SYNONYM ${qualifiedName(schema, args.synonym)} FOR ${qualifiedName(args.targetSchema, args.targetName)}`,
  );
  return `Synonym ${args.isPublic ? 'PUBLIC ' : ''}${schema}.${args.synonym} created.`;
}

async function createSequence(ctx: ServerContext, args: SequenceArgs): Promise<string> {
  const schema = owner(ctx, args.schema, 'create_sequence');
  if (args.incrementBy === 0) {
    throw new SecurityError('incrementBy must be non-zero (Oracle INCREMENT BY 0 is invalid).');
  }

  const parts = [`CREATE SEQUENCE ${qualifiedName(schema, args.sequence)}`];
  if (args.startWith !== undefined) parts.push(`START WITH ${args.startWith}`);
  if (args.incrementBy !== undefined) parts.push(`INCREMENT BY ${args.incrementBy}`);
  // Por debajo de 2 la secuencia no cachea nada útil: Oracle usa NOCACHE.
  parts.push(args.cache !== undefined && args.cache >= 2 ? `CACHE ${args.cache}` : 'NOCACHE');
  parts.push(args.cycle ? 'CYCLE' : 'NOCYCLE', args.order ? 'ORDER' : 'NOORDER');

  await ctx.dataAccess.execute(parts.join(' '));
  return `Sequence ${schema}.${args.sequence} created.`;
}

async function createIndex(ctx: ServerContext, args: IndexArgs): Promise<string> {
  const schema = owner(ctx, args.schema, 'create_index');
  if (args.columns.length === 0) {
    throw new SecurityError('At least one column is required.');
  }

  await ctx.dataAccess.execute(
    `CREATE ${args.unique ? 'UNIQUE ' : ''}INDEX ${qualifiedName(schema, args.index)} ON ${qualifiedName(args.tableSchema, args.table)} (${quoteCsv(args.columns)})`,
  );
  return `${args.unique ? 'Unique index' : 'Index'} ${schema}.${args.index} created on ${args.tableSchema}.${args.table}.`;
}

async function createMviewLog(ctx: ServerContext, args: MviewLogArgs): Promise<string> {
  const schema = owner(ctx, args.schema, 'create_mview_log');
  const withRowid = args.withRowid ?? false;
  const withPrimaryKey = args.withPrimaryKey ?? false;
  if (!withRowid && !withPrimaryKey) {
    throw new SecurityError(
      'At least one of withRowid or withPrimaryKey is required (Oracle needs PRIMARY KEY or ROWID).',
    );
  }

  const columns = [withPrimaryKey ? 'PRIMARY KEY' : undefined, withRowid ? 'ROWID' : undefined]
    .filter((column): column is string => column !== undefined)
    .join(', ');
  const includingNew = args.includingNewValues ? ' INCLUDING NEW VALUES' : '';

  await ctx.dataAccess.execute(
    `CREATE MATERIALIZED VIEW LOG ON ${qualifiedName(schema, args.table)} WITH ${columns}${includingNew}`,
  );
  return `Materialized view log created on ${schema}.${args.table}.`;
}

interface CommentArgs {
  schema?: string;
  table: string;
  comment: string;
}

interface ColumnCommentArgs extends CommentArgs {
  column: string;
}

interface ViewArgs {
  schema?: string;
  view: string;
  selectBody: string;
}

interface SynonymArgs {
  schema?: string;
  synonym: string;
  targetSchema: string;
  targetName: string;
  isPublic?: boolean;
}

interface SequenceArgs {
  schema?: string;
  sequence: string;
  startWith?: number;
  incrementBy?: number;
  cache?: number;
  cycle?: boolean;
  order?: boolean;
}

interface IndexArgs {
  schema?: string;
  index: string;
  tableSchema: string;
  table: string;
  columns: string[];
  unique?: boolean;
}

interface MviewLogArgs {
  schema?: string;
  table: string;
  withRowid?: boolean;
  withPrimaryKey?: boolean;
  includingNewValues?: boolean;
}

/** Ddl — las 7 tools DDL create-style del Java. */
export function registerDdl(ctx: ServerContext): void {
  ctx.server.registerTool(
    'comment_on_table',
    {
      description:
        "Add or replace the comment on a table. Only works for tables the MCP user owns (no system privilege exists for COMMENT on others' objects; you'll get ORA-01031 otherwise).",
      inputSchema: {
        schema: optionalSchema('Schema (owner) of the table.'),
        table: z.string().describe('Table name.'),
        comment: z.string().describe('Comment text. Single quotes are escaped automatically.'),
      },
    },
    async (args) =>
      withToolContext('comment_on_table', args, () =>
        guardTool(async () => ({ content: [text(await commentOnTable(ctx, args))] })),
      ),
  );

  ctx.server.registerTool(
    'comment_on_column',
    {
      description:
        'Add or replace the comment on a column. Only works for tables the MCP user owns.',
      inputSchema: {
        schema: optionalSchema('Schema (owner) of the table.'),
        table: z.string().describe('Table name.'),
        column: z.string().describe('Column name.'),
        comment: z.string().describe('Comment text. Single quotes are escaped automatically.'),
      },
    },
    async (args) =>
      withToolContext('comment_on_column', args, () =>
        guardTool(async () => ({ content: [text(await commentOnColumn(ctx, args))] })),
      ),
  );

  ctx.server.registerTool(
    'create_or_replace_view',
    {
      description:
        "Create or replace a view in the MCP user's own schema. Requires CREATE VIEW privilege; Oracle returns ORA-01031 otherwise.",
      inputSchema: {
        schema: optionalSchema(
          'Schema (owner) for the new view (must be one the MCP user can create in, typically their own).',
        ),
        view: z.string().describe('View name.'),
        selectBody: z
          .string()
          .describe(
            'SELECT statement body for the view (e.g. "SELECT id, name FROM owner.table WHERE active = 1").',
          ),
      },
    },
    async (args) =>
      withToolContext('create_or_replace_view', args, () =>
        guardTool(async () => ({ content: [text(await createOrReplaceView(ctx, args))] })),
      ),
  );

  ctx.server.registerTool(
    'create_synonym',
    {
      description:
        "Create a private or public synonym pointing at another schema's object. Requires CREATE SYNONYM (private) or CREATE PUBLIC SYNONYM (public); Oracle returns ORA-01031 otherwise.",
      inputSchema: {
        schema: optionalSchema('Schema where the synonym will live (ignored for PUBLIC).'),
        synonym: z.string().describe('Synonym name.'),
        targetSchema: z.string().describe('Schema of the target object.'),
        targetName: z
          .string()
          .describe('Name of the target object (table/view/sequence/procedure).'),
        isPublic: z
          .boolean()
          .describe(
            'Whether to create a PUBLIC synonym (requires CREATE PUBLIC SYNONYM privilege).',
          )
          .optional(),
      },
    },
    async (args) =>
      withToolContext('create_synonym', args, () =>
        guardTool(async () => ({ content: [text(await createSynonym(ctx, args))] })),
      ),
  );

  ctx.server.registerTool(
    'create_sequence',
    {
      description:
        "Create a sequence in the MCP user's own schema. Requires CREATE SEQUENCE privilege; Oracle returns ORA-01031 otherwise.",
      inputSchema: {
        schema: optionalSchema('Schema (owner) for the new sequence.'),
        sequence: z.string().describe('Sequence name.'),
        startWith: z.number().int().describe('Optional START WITH value.').optional(),
        incrementBy: z
          .number()
          .int()
          .describe('Optional INCREMENT BY value (can be negative for descending).')
          .optional(),
        cache: z
          .number()
          .int()
          .describe('Optional CACHE size (e.g. 20). 0 or omit means NOCACHE.')
          .optional(),
        cycle: z
          .boolean()
          .describe('Whether to CYCLE when max is reached (default false).')
          .optional(),
        order: z
          .boolean()
          .describe('Whether to guarantee ORDER (default false, useful in RAC).')
          .optional(),
      },
    },
    async (args) =>
      withToolContext('create_sequence', args, () =>
        guardTool(async () => ({ content: [text(await createSequence(ctx, args))] })),
      ),
  );

  ctx.server.registerTool(
    'create_index',
    {
      description:
        'Create an index on a table. Requires CREATE ANY INDEX (if the table is in another schema) or table ownership; Oracle returns ORA-01031 otherwise.',
      inputSchema: {
        schema: optionalSchema('Schema where the index will live.'),
        index: z.string().describe('Index name.'),
        tableSchema: z.string().describe('Schema of the target table.'),
        table: z.string().describe('Target table name.'),
        columns: z.array(z.string()).describe('Column names to index (JSON array, ordered).'),
        unique: z
          .boolean()
          .describe('Whether to create a UNIQUE index (default false).')
          .optional(),
      },
    },
    async (args) =>
      withToolContext('create_index', args, () =>
        guardTool(async () => ({ content: [text(await createIndex(ctx, args))] })),
      ),
  );

  ctx.server.registerTool(
    'create_mview_log',
    {
      description:
        'Create a materialized-view log on a table for fast refresh. Requires CREATE TABLE privilege and tablespace quota; Oracle returns ORA-01031 / ORA-01950 otherwise.',
      inputSchema: {
        schema: optionalSchema('Schema (owner) of the master table.'),
        table: z.string().describe('Master table name.'),
        withRowid: z.boolean().describe('Whether to include ROWID columns.').optional(),
        withPrimaryKey: z
          .boolean()
          .describe('Whether to include PRIMARY KEY columns (recommended).')
          .optional(),
        includingNewValues: z
          .boolean()
          .describe('Whether to add INCLUDING NEW VALUES (enables fast refresh with DML tracking).')
          .optional(),
      },
    },
    async (args) =>
      withToolContext('create_mview_log', args, () =>
        guardTool(async () => ({ content: [text(await createMviewLog(ctx, args))] })),
      ),
  );
}
