import { z } from 'zod';
import { withToolContext } from '../audit/context.js';
import { resolveSchema, schemaFallback } from '../catalog/schema.js';
import type { OracleBind } from '../db/oracle-types.js';
import { guardTool, type ToolTextResult } from '../errors.js';
import { assertIdentifier } from '../security/identifiers.js';
import type { ServerContext } from '../server.js';

/**
 * Catálogo completo de objetos (`ConstraintCatalog`, `SequenceCatalog`,
 * `SchedulerCatalog`, `TableCatalog` y `ObjectCatalog` del Java). Todo son
 * queries de diccionario de solo lectura con binds; los identificadores que da
 * el cliente pasan por la allow-list y `schema` se resuelve igual que en el Java:
 * las tools que necesitan owner usan el actual (`orCurrent`), las que solo lo
 * filtran lo dejan en `NULL` para ver todos los schemas visibles.
 */

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

/**
 * Resultado MCP de una tool de texto. Un `string` es el aviso literal del Java
 * (p. ej. `Sequence not found: X.Y`); cualquier otro valor va serializado como JSON.
 */
function text(value: unknown): ToolTextResult {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  };
}

/** Owner de las tools que no pueden armar la query sin él: el actual si se omite. */
const OWNER = z
  .string()
  .describe(
    "Schema (owner) of the object. Optional — defaults to the server's current schema; omit rather than guess.",
  )
  .optional();

/** Filtro de owner de los listados: omitido se ve todo lo visible para la sesión. */
const OWNER_FILTER = z
  .string()
  .describe('Schema (owner) name. Omit to search all schemas.')
  .optional();

const TABLE = z.string().describe('Table name.');

const OBJ_TYPE = z
  .string()
  .describe("Object type, e.g. 'PROCEDURE', 'FUNCTION', 'PACKAGE', 'TABLE', 'VIEW'.")
  .optional();

/** Patrón LIKE del nombre, con la descripción específica de cada tool. */
function namePattern(what: string) {
  return z.string().describe(`LIKE pattern for the ${what} name. Defaults to '%'.`).optional();
}

export function registerMetadataCatalog(ctx: ServerContext): void {
  const { dataAccess } = ctx;
  /** Owner efectivo de las tools que no pueden operar sin él. */
  const owner = (args: { schema?: string }, tool: string): string =>
    resolveSchema(args.schema, schemaFallback(ctx), tool);
  const table = (args: { table: string }): string => assertIdentifier(args.table, 'tabla');
  const objType = (args: { type?: string }): OracleBind =>
    args.type === undefined ? null : assertIdentifier(args.type, 'tipo');

  ctx.server.registerTool(
    'list_indexes',
    {
      description: 'List indexes on a table with their columns, uniqueness and status.',
      inputSchema: { schema: OWNER, table: TABLE },
    },
    async (args) =>
      withToolContext('list_indexes', args, () =>
        guardTool(async () =>
          text(
            await dataAccess.queryForList(
              `SELECT i.index_name,
       (SELECT LISTAGG(ic.column_name, ', ') WITHIN GROUP (ORDER BY ic.column_position)
        FROM all_ind_columns ic
        WHERE ic.index_owner = i.owner AND ic.index_name = i.index_name) AS columns,
       i.uniqueness,
       i.status
FROM all_indexes i
WHERE i.table_owner = :schema AND i.table_name = :col_table
ORDER BY i.index_name`,
              [owner(args, 'list_indexes'), table(args)],
            ),
          ),
        ),
      ),
  );

  ctx.server.registerTool(
    'list_constraints',
    {
      description:
        'List constraints on a table (primary key, foreign key, unique, check) with their columns and references.',
      inputSchema: { schema: OWNER, table: TABLE },
    },
    async (args) =>
      withToolContext('list_constraints', args, () =>
        guardTool(async () =>
          text(
            await dataAccess.queryForList(
              `SELECT c.constraint_name,
       CASE c.constraint_type
         WHEN 'P' THEN 'PRIMARY KEY'
         WHEN 'R' THEN 'FOREIGN KEY'
         WHEN 'U' THEN 'UNIQUE'
         WHEN 'C' THEN 'CHECK / NOT NULL'
         WHEN 'O' THEN 'READ ONLY'
         ELSE c.constraint_type END AS constraint_type,
       (SELECT LISTAGG(cc.column_name, ', ') WITHIN GROUP (ORDER BY cc.position)
        FROM all_cons_columns cc
        WHERE cc.owner = c.owner AND cc.constraint_name = c.constraint_name) AS columns,
       c.r_owner AS referenced_owner,
       c.r_constraint_name AS referenced_constraint
FROM all_constraints c
WHERE c.owner = :schema AND c.table_name = :col_table
ORDER BY c.constraint_type, c.constraint_name`,
              [owner(args, 'list_constraints'), table(args)],
            ),
          ),
        ),
      ),
  );

  ctx.server.registerTool(
    'list_sequences',
    {
      description:
        "List sequences with their range, increment, last number, cycle flag and cache size (queried from ALL_SEQUENCES, not DBA_SEQUENCES). cache_size > 0 means values are pre-allocated, so gaps can appear after a crash or rollback. For a single sequence's full metadata (including order_flag) use get_sequence_info. Optional schema filter.",
      inputSchema: { schema: OWNER_FILTER },
    },
    async (args) =>
      withToolContext('list_sequences', args, () =>
        guardTool(async () =>
          text(
            await dataAccess.queryForList(
              `SELECT sequence_owner AS schema_name,
       sequence_name,
       min_value,
       max_value,
       increment_by,
       last_number,
       cycle_flag,
       cache_size
FROM all_sequences
WHERE (:schema IS NULL OR sequence_owner = :schema)
ORDER BY sequence_owner, sequence_name`,
              ownerBinds(args.schema),
            ),
          ),
        ),
      ),
  );

  ctx.server.registerTool(
    'get_sequence_info',
    {
      description:
        'Return metadata for a single sequence (min_value, max_value, increment_by, last_number, cache_size, cycle_flag, order_flag) from ALL_SEQUENCES. Read-only: does NOT consume NEXTVAL, so the sequence counter is untouched. Prefer this over querying ALL_SEQUENCES/DBA_SEQUENCES directly.',
      inputSchema: { schema: OWNER, sequence: z.string().describe('Sequence name.') },
    },
    async (args) =>
      withToolContext('get_sequence_info', args, () =>
        guardTool(async () => {
          const sequenceOwner = owner(args, 'get_sequence_info');
          const sequence = assertIdentifier(args.sequence, 'secuencia');
          const rows = await dataAccess.queryForList(
            `SELECT sequence_owner AS schema_name,
       sequence_name,
       min_value,
       max_value,
       increment_by,
       last_number,
       cycle_flag,
       cache_size,
       order_flag
FROM all_sequences
WHERE sequence_owner = :schema AND sequence_name = :seq_name`,
            [sequenceOwner, sequence],
          );
          return text(rows[0] ?? `Sequence not found: ${sequenceOwner}.${sequence}`);
        }),
      ),
  );

  ctx.server.registerTool(
    'list_triggers',
    {
      description:
        'List triggers with their type, triggering event, target table and status. Optional schema.',
      inputSchema: { schema: OWNER_FILTER },
    },
    async (args) =>
      withToolContext('list_triggers', args, () =>
        guardTool(async () =>
          text(
            await dataAccess.queryForList(
              `SELECT owner AS schema_name, trigger_name, trigger_type, triggering_event,
       table_owner, table_name, status
FROM all_triggers
WHERE (:schema IS NULL OR owner = :schema)
ORDER BY owner, trigger_name`,
              ownerBinds(args.schema),
            ),
          ),
        ),
      ),
  );

  ctx.server.registerTool(
    'list_procedures',
    {
      description:
        'List stored procedures, functions, packages and types. Optional schema, LIKE name pattern and object type filter.',
      inputSchema: { schema: OWNER_FILTER, namePattern: namePattern('object'), type: OBJ_TYPE },
    },
    async (args) =>
      withToolContext('list_procedures', args, () =>
        guardTool(async () =>
          text(
            await dataAccess.queryForList(
              `SELECT owner AS schema_name, object_name AS name, object_type AS type, status, created, last_ddl_time
FROM all_objects
WHERE object_type IN ('PROCEDURE','FUNCTION','PACKAGE','PACKAGE BODY','TYPE','TYPE BODY')
AND (:schema IS NULL OR owner = :schema)
AND (:obj_type IS NULL OR object_type = :obj_type)
AND object_name LIKE :pattern ESCAPE '\\'
ORDER BY owner, object_type, object_name`,
              [
                ...ownerBinds(args.schema),
                objType(args),
                objType(args),
                likePattern(args.namePattern),
              ],
            ),
          ),
        ),
      ),
  );

  ctx.server.registerTool(
    'list_synonyms',
    {
      description:
        'List private and public synonyms with their resolved target owner/name and optional DB link. Optional schema and LIKE name pattern.',
      inputSchema: { schema: OWNER_FILTER, namePattern: namePattern('synonym') },
    },
    async (args) =>
      withToolContext('list_synonyms', args, () =>
        guardTool(async () =>
          text(
            await dataAccess.queryForList(
              `SELECT owner AS schema_name, synonym_name AS name,
       table_owner AS target_owner, table_name AS target_name, db_link
FROM all_synonyms
WHERE (:schema IS NULL OR owner = :schema)
AND synonym_name LIKE :pattern ESCAPE '\\'
ORDER BY owner, synonym_name`,
              [...ownerBinds(args.schema), likePattern(args.namePattern)],
            ),
          ),
        ),
      ),
  );

  ctx.server.registerTool(
    'list_db_links',
    {
      description:
        'List database links visible to the current user with their connect username, host and creation date.',
    },
    async () =>
      withToolContext('list_db_links', {}, () =>
        guardTool(async () =>
          text(
            await dataAccess.queryForList(
              `SELECT owner AS schema_name, db_link AS name, username, host, created
FROM all_db_links
ORDER BY owner, db_link`,
            ),
          ),
        ),
      ),
  );

  ctx.server.registerTool(
    'list_directories',
    {
      description: 'List Oracle directory objects and their filesystem paths.',
    },
    async () =>
      withToolContext('list_directories', {}, () =>
        guardTool(async () =>
          text(
            await dataAccess.queryForList(
              `SELECT owner AS schema_name, directory_name AS name, directory_path
FROM all_directories
ORDER BY owner, directory_name`,
            ),
          ),
        ),
      ),
  );

  ctx.server.registerTool(
    'list_external_tables',
    {
      description:
        'List external tables with their access driver, default directory, reject limit and access parameters.',
      inputSchema: { schema: OWNER_FILTER },
    },
    async (args) =>
      withToolContext('list_external_tables', args, () =>
        guardTool(async () =>
          text(
            await dataAccess.queryForList(
              `SELECT owner AS schema_name, table_name AS name, type_owner, type_name,
       default_directory_name AS directory, reject_limit, access_type,
       access_parameters, property
FROM all_external_tables
WHERE (:schema IS NULL OR owner = :schema)
ORDER BY owner, table_name`,
              ownerBinds(args.schema),
            ),
          ),
        ),
      ),
  );

  ctx.server.registerTool(
    'list_materialized_views',
    {
      description:
        'List materialized views with their refresh mode, method, last refresh and staleness. Optional schema and LIKE name pattern.',
      inputSchema: { schema: OWNER_FILTER, namePattern: namePattern('mview') },
    },
    async (args) =>
      withToolContext('list_materialized_views', args, () =>
        guardTool(async () =>
          text(
            await dataAccess.queryForList(
              `SELECT owner AS schema_name, mview_name AS name, container_name,
       refresh_mode, refresh_method, last_refresh_type, last_refresh_date,
       compile_state, staleness, use_no_index
FROM all_mviews
WHERE (:schema IS NULL OR owner = :schema)
AND mview_name LIKE :pattern ESCAPE '\\'
ORDER BY owner, mview_name`,
              [...ownerBinds(args.schema), likePattern(args.namePattern)],
            ),
          ),
        ),
      ),
  );

  ctx.server.registerTool(
    'list_mview_logs',
    {
      description: 'List materialized view logs defined on tables. Optional schema.',
      inputSchema: { schema: OWNER_FILTER },
    },
    async (args) =>
      withToolContext('list_mview_logs', args, () =>
        guardTool(async () =>
          text(
            await dataAccess.queryForList(
              `SELECT log_owner AS schema_name, master AS table_name, log_table AS log_name,
       rowids, primary_key, sequence, include_new_values, purge_asynchronous
FROM all_mview_logs
WHERE (:schema IS NULL OR log_owner = :schema)
ORDER BY log_owner, master`,
              ownerBinds(args.schema),
            ),
          ),
        ),
      ),
  );

  ctx.server.registerTool(
    'list_partitions',
    {
      description:
        'List partitions of a partitioned table: name, position, high value, row count, compression, last analyzed.',
      inputSchema: { schema: OWNER, table: TABLE },
    },
    async (args) =>
      withToolContext('list_partitions', args, () =>
        guardTool(async () =>
          text(
            await dataAccess.queryForList(
              `SELECT table_owner AS schema_name, table_name, partition_name,
       partition_position, high_value, num_rows, blocks, compression,
       last_analyzed, composite, subpartition_count
FROM all_tab_partitions
WHERE table_owner = :schema AND table_name = :col_table
ORDER BY partition_position`,
              [owner(args, 'list_partitions'), table(args)],
            ),
          ),
        ),
      ),
  );

  ctx.server.registerTool(
    'list_ind_partitions',
    {
      description:
        'List partitions of indexes on a table: index name, partition, status, leaf blocks, distinct keys, num rows.',
      inputSchema: { schema: OWNER, table: TABLE },
    },
    async (args) =>
      withToolContext('list_ind_partitions', args, () =>
        guardTool(async () =>
          text(
            await dataAccess.queryForList(
              `SELECT ip.index_owner AS schema_name, ip.index_name, ip.partition_name,
       ip.partition_position, ip.status, ip.leaf_blocks, ip.distinct_keys,
       ip.clustering_factor, ip.num_rows, ip.last_analyzed
FROM all_ind_partitions ip
JOIN all_indexes i
  ON i.owner = ip.index_owner AND i.index_name = ip.index_name
WHERE i.table_owner = :schema AND i.table_name = :col_table
ORDER BY ip.index_name, ip.partition_position`,
              [owner(args, 'list_ind_partitions'), table(args)],
            ),
          ),
        ),
      ),
  );

  ctx.server.registerTool(
    'list_subpartitions',
    {
      description:
        'List subpartitions of a composite-partitioned table. Requires schema and table.',
      inputSchema: { schema: OWNER, table: TABLE },
    },
    async (args) =>
      withToolContext('list_subpartitions', args, () =>
        guardTool(async () =>
          text(
            await dataAccess.queryForList(
              `SELECT table_owner AS schema_name, table_name, partition_name,
       subpartition_name, subpartition_position, high_value,
       num_rows, blocks, last_analyzed
FROM all_tab_subpartitions
WHERE table_owner = :schema AND table_name = :col_table
ORDER BY partition_name, subpartition_position`,
              [owner(args, 'list_subpartitions'), table(args)],
            ),
          ),
        ),
      ),
  );

  ctx.server.registerTool(
    'list_lob_columns',
    {
      description:
        'List LOB columns of a table with their segment, index, caching, logging, SECUREFILE flag and retention.',
      inputSchema: { schema: OWNER, table: TABLE },
    },
    async (args) =>
      withToolContext('list_lob_columns', args, () =>
        guardTool(async () =>
          text(
            await dataAccess.queryForList(
              `SELECT owner AS schema_name, table_name AS name, column_name, segment_name,
       index_name, cache, logging, in_row, securefile, partitioned, retention
FROM all_lobs
WHERE owner = :schema AND table_name = :col_table
ORDER BY column_name`,
              [owner(args, 'list_lob_columns'), table(args)],
            ),
          ),
        ),
      ),
  );

  ctx.server.registerTool(
    'list_types',
    {
      description:
        'List user-defined Oracle types with their typecode, attribute count, methods and supertype.',
      inputSchema: { schema: OWNER_FILTER },
    },
    async (args) =>
      withToolContext('list_types', args, () =>
        guardTool(async () =>
          text(
            await dataAccess.queryForList(
              `SELECT owner AS schema_name, type_name AS name, typecode,
       attributes, methods, final, instantiable,
       supertype_owner, supertype_name
FROM all_types
WHERE (:schema IS NULL OR owner = :schema)
ORDER BY owner, type_name`,
              ownerBinds(args.schema),
            ),
          ),
        ),
      ),
  );

  ctx.server.registerTool(
    'list_invalid_objects',
    {
      description:
        'List objects whose status is INVALID (broken code needing recompile). Excludes index/LOB partitions. Optional schema and type filter.',
      inputSchema: { schema: OWNER_FILTER, type: OBJ_TYPE },
    },
    async (args) =>
      withToolContext('list_invalid_objects', args, () =>
        guardTool(async () =>
          text(
            await dataAccess.queryForList(
              `SELECT owner AS schema_name, object_name AS name, object_type AS type, status, last_ddl_time
FROM all_objects
WHERE status = 'INVALID'
AND object_type NOT IN ('INDEX','INDEX PARTITION','LOB','TABLE PARTITION','TABLE SUBPARTITION')
AND (:schema IS NULL OR owner = :schema)
AND (:obj_type IS NULL OR object_type = :obj_type)
ORDER BY owner, object_type, object_name`,
              [...ownerBinds(args.schema), objType(args), objType(args)],
            ),
          ),
        ),
      ),
  );

  ctx.server.registerTool(
    'list_dependencies',
    {
      description:
        'List objects that a given object depends on (referenced objects). Useful for impact analysis.',
      inputSchema: {
        schema: OWNER,
        name: z.string().describe('Object name.'),
        type: z
          .string()
          .describe("Optional object type filter (e.g. 'VIEW', 'PROCEDURE').")
          .optional(),
      },
    },
    async (args) =>
      withToolContext('list_dependencies', args, () =>
        guardTool(async () =>
          text(
            await dataAccess.queryForList(
              `SELECT owner, name, type,
       referenced_owner, referenced_name, referenced_type, referenced_link_name,
       dependency_type
FROM all_dependencies
WHERE owner = :schema AND name = :obj_name
AND (:obj_type IS NULL OR type = :obj_type)
ORDER BY referenced_owner, referenced_name, referenced_type`,
              [
                owner(args, 'list_dependencies'),
                assertIdentifier(args.name, 'nombre'),
                objType(args),
                objType(args),
              ],
            ),
          ),
        ),
      ),
  );

  ctx.server.registerTool(
    'list_scheduler_jobs',
    {
      description:
        'List DBMS_SCHEDULER jobs with state, run/failure counts, last start, next run and repeat interval.',
      inputSchema: { schema: OWNER_FILTER },
    },
    async (args) =>
      withToolContext('list_scheduler_jobs', args, () =>
        guardTool(async () =>
          text(
            await dataAccess.queryForList(
              `SELECT owner AS schema_name, job_name AS name, job_type, job_action,
       enabled, state, run_count, failure_count, last_start_date,
       next_run_date, repeat_interval, job_class
FROM all_scheduler_jobs
WHERE (:schema IS NULL OR owner = :schema)
ORDER BY owner, job_name`,
              ownerBinds(args.schema),
            ),
          ),
        ),
      ),
  );

  ctx.server.registerTool(
    'list_scheduler_job_runs',
    {
      description:
        'List recent DBMS_SCHEDULER job run details: start time, run duration, instance id, session id, error code, additional info. Ordered by start time desc. (operation/status live in ALL_SCHEDULER_JOB_LOG, not the run-details view.)',
      inputSchema: {
        schema: OWNER_FILTER,
        jobName: z.string().describe('Optional job name filter.').optional(),
        limit: z
          .number()
          .int()
          .positive()
          .describe('Maximum number of rows to return (default 20).')
          .optional(),
      },
    },
    async (args) =>
      withToolContext('list_scheduler_job_runs', args, () =>
        guardTool(async () =>
          text(
            await dataAccess.queryForList(
              `SELECT j.owner AS schema_name, j.job_name AS name, j.job_subname,
       j.log_date, j.status, j.actual_start_date, j.run_duration,
       j.instance_id, j.session_id, j."ERROR#" AS error_code, j.additional_info
FROM all_scheduler_job_run_details j
WHERE (:schema IS NULL OR j.owner = :schema)
AND (:job_name IS NULL OR j.job_name = :job_name)
ORDER BY j.log_date DESC
FETCH FIRST :limit ROWS ONLY`,
              [
                args.schema ?? null,
                args.schema ?? null,
                args.jobName ?? null,
                args.jobName ?? null,
                args.limit ?? 20,
              ],
            ),
          ),
        ),
      ),
  );
}
