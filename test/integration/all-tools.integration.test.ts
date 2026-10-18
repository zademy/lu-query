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
 * Integration de las 75 Tools contra el contenedor Oracle real: cada Tool de
 * tools/list se llama una vez por MCP y tiene que responder sin isError. Es la
 * red que agarra un Tool que el refactor dejo sin registrar o con la forma del
 * resultado cambiada.
 *
 * La matriz se compara con tools/list, asi que una Tool nueva sin entrada aqui
 * rompe el test en vez de quedar sin cubrir.
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

/** Objetos propios del test con prefijo T91_: nunca una tabla de ejemplo. */
const TABLE = 'T91_IT_ALL';
const CHILD = 'T91_IT_ALL_CHILD';
const SEQ = 'T91_IT_ALL_SEQ';
const VIEW = 'T91_IT_ALL_V';
const MV = 'T91_IT_ALL_MV';
const SYN = 'T91_IT_ALL_SYN';
const IDX = 'T91_IT_ALL_IDX';
const PROC = 'T91_IT_ALL_PROC';
const OWNER = GOOD_ENV.ORACLE_DB_USERNAME as string;
const SELECT_SQL = 'SELECT ID, TXT FROM ' + TABLE + ' WHERE ID = 1';

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

/** Valores validos de los argumentos de los prompts. */
const ARGUMENTOS: Record<string, string> = {
  sql: SELECT_SQL,
  schema: OWNER,
  name: 'T91_IT_ALL',
  table: TABLE,
  type: 'TABLE',
  object: 'T91_IT_ALL',
  username: OWNER,
  sid: '1',
  symptom: 'demo',
  business_keys: 'ID',
  sensitive_columns: 'TXT',
  argument_values: 'demo',
  bind_context: 'demo',
  tuning_advisor: 'off',
  detail_level: 'quick',
  mode: 'quick',
  transactional_dry_run: 'off',
  max_objects: '20',
  null_threshold: '10',
};

interface Case {
  name: string;
  args?: Record<string, unknown>;
}

const MATRIX: Case[] = [
  { name: 'test_connection' },
  { name: 'run_query', args: { sql: 'SELECT COUNT(*) AS N FROM DUAL' } },
  { name: 'get_sample_data', args: { table: TABLE, rows: 2 } },

  { name: 'execute_dml', args: { sql: "INSERT INTO " + TABLE + " (ID, TXT) VALUES (901, 'dml')" } },
  { name: 'execute_dml_preview', args: { sql: "UPDATE " + TABLE + " SET TXT = 'preview' WHERE ID = 1" } },
  {
    name: 'execute_dml_rollback_first',
    args: { sql: "INSERT INTO " + TABLE + " (ID, TXT) VALUES (903, 'dml')" },
  },

  { name: 'comment_on_table', args: { table: TABLE, comment: 'T91_IT' } },
  { name: 'comment_on_column', args: { table: TABLE, column: 'TXT', comment: 'T91_IT' } },
  { name: 'create_or_replace_view', args: { view: VIEW, selectBody: SELECT_SQL } },
  { name: 'create_synonym', args: { synonym: SYN, targetSchema: OWNER, targetName: TABLE } },
  { name: 'create_sequence', args: { sequence: SEQ } },
  { name: 'create_index', args: { index: IDX, tableSchema: OWNER, table: TABLE, columns: ['TXT'] } },
  { name: 'create_mview_log', args: { table: MV, withPrimaryKey: true } },

  { name: 'list_schemas' },
  { name: 'list_tables', args: { namePattern: 'T91%' } },
  { name: 'list_views', args: { namePattern: 'T91%' } },
  { name: 'describe_table', args: { table: TABLE } },
  { name: 'table_exists', args: { table: TABLE } },
  { name: 'search_objects', args: { namePattern: 'T91' } },
  { name: 'list_objects', args: { type: 'TABLE' } },
  { name: 'get_ddl', args: { name: TABLE, type: 'TABLE' } },
  { name: 'list_indexes', args: { table: TABLE } },
  { name: 'list_constraints', args: { table: TABLE } },
  { name: 'list_sequences' },
  { name: 'get_sequence_info', args: { sequence: SEQ } },
  { name: 'list_triggers' },
  { name: 'list_procedures', args: { namePattern: 'T91%' } },
  { name: 'list_synonyms', args: { namePattern: 'T91%' } },
  { name: 'list_db_links' },
  { name: 'list_directories' },
  { name: 'list_external_tables' },
  { name: 'list_materialized_views' },
  { name: 'list_mview_logs' },
  { name: 'list_partitions', args: { table: TABLE } },
  { name: 'list_ind_partitions', args: { table: TABLE } },
  { name: 'list_subpartitions', args: { table: TABLE } },
  { name: 'list_lob_columns', args: { table: TABLE } },
  { name: 'list_types' },
  { name: 'list_invalid_objects' },
  { name: 'list_dependencies', args: { name: PROC, type: 'PROCEDURE' } },
  { name: 'list_scheduler_jobs' },
  { name: 'list_scheduler_job_runs' },

  { name: 'get_table_stats', args: { table: TABLE } },
  { name: 'get_column_stats', args: { table: TABLE, column: 'TXT' } },
  { name: 'get_histogram', args: { table: TABLE, column: 'TXT' } },

  { name: 'get_session_privs' },
  { name: 'get_session_roles' },
  { name: 'get_plsql_errors' },
  { name: 'oracle_mcp_health_report' },
  { name: 'describe_plsql', args: { name: PROC, type: 'PROCEDURE' } },
  {
    name: 'call_procedure',
    args: {
      name: PROC,
      args: JSON.stringify([
        { name: 'P_ID', direction: 'IN', dataType: 'NUMBER', value: 1 },
        { name: 'OUT_MSG', direction: 'OUT', dataType: 'VARCHAR2', size: 50 },
      ]),
    },
  },

  { name: 'explain_plan', args: { sql: SELECT_SQL } },
  { name: 'suggest_index', args: { sql: SELECT_SQL } },
  { name: 'list_unused_indexes' },
  {
    name: 'run_sql_tuning_advisor',
    args: { sql: 'SELECT ID FROM ' + TABLE + " WHERE TXT = 'uno'" },
  },

  { name: 'find_free_id', args: { table: TABLE, column: 'ID' } },
  { name: 'find_duplicates', args: { table: TABLE, columns: ['TXT'] } },
  { name: 'count_rows', args: { table: TABLE } },
  { name: 'get_next_sequence_value', args: { sequence: SEQ } },
  { name: 'validate_fk_integrity', args: { table: CHILD } },
  { name: 'get_dependency_graph', args: { name: VIEW, type: 'VIEW' } },
  { name: 'get_fk_graph', args: { table: TABLE } },

  { name: 'list_active_sessions' },
  { name: 'list_blocked_sessions' },
  { name: 'list_locks' },
  { name: 'list_top_sql', args: { limit: 3 } },
  { name: 'get_wait_events' },
  { name: 'get_session_longops' },
  { name: 'get_instance_info' },
  { name: 'get_database_info' },
  { name: 'get_system_stats' },
  { name: 'get_db_time_model' },
  { name: 'get_parameter', args: { name: 'sga_target' } },
  { name: 'list_datafile_io' },
];

describe.skipIf(!optIn)('las 75 Tools contra Oracle real', () => {
  let handle: ServerHandle;
  let client: Client;
  let db: DataAccess;
  let auditDir: string;

  beforeAll(async () => {
    auditDir = await mkdtemp(join(tmpdir(), 'lu-query-alltools-it-'));
    handle = createServer({ config: loadConfig({ ...GOOD_ENV, MCP_AUDIT_DIR: auditDir }) });
    db = handle.context.dataAccess;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'lu-query-alltools-integration', version: '0.0.0' });
    await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);

    await db.execute('CREATE TABLE ' + TABLE + ' (ID NUMBER PRIMARY KEY, TXT VARCHAR2(50))');
    await db.execute('CREATE TABLE ' + CHILD + ' (ID NUMBER PRIMARY KEY, PARENT_ID NUMBER)');
    await db.execute(
      'ALTER TABLE ' + CHILD + ' ADD CONSTRAINT FK_' + CHILD + ' FOREIGN KEY (PARENT_ID) REFERENCES ' + TABLE + '(ID)',
    );
    await db.execute(
      "INSERT INTO " + TABLE + " (ID, TXT) SELECT LEVEL, 'txt' || LEVEL FROM DUAL CONNECT BY LEVEL <= 10",
    );
    await db.execute(
      'CREATE MATERIALIZED VIEW ' + MV + ' AS SELECT ID, TXT FROM ' + TABLE,
    );
    await db.execute(
      'CREATE OR REPLACE PROCEDURE ' + PROC + ' (P_ID IN NUMBER, OUT_MSG OUT VARCHAR2) AS' +
        " BEGIN OUT_MSG := 'ok ' || P_ID; END;",
    );
    await db.execute(
      'BEGIN DBMS_STATS.GATHER_TABLE_STATS(USER, ' + "'" + TABLE + "'" + '); END;',
    );
  }, 120_000);

  afterAll(async () => {
    for (const sql of [
      'DROP MATERIALIZED VIEW ' + MV,
      'DROP VIEW ' + VIEW,
      'DROP SYNONYM ' + SYN,
      'DROP INDEX ' + IDX,
      'DROP SEQUENCE ' + SEQ,
      'DROP PROCEDURE ' + PROC,
      'DROP TABLE ' + CHILD + ' PURGE',
      'DROP TABLE ' + TABLE + ' PURGE',
    ]) {
      await db.execute(sql).catch(() => undefined);
    }
    await client.close();
    await handle.close();
    await rm(auditDir, { recursive: true, force: true });
  });

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as ToolResult;

  it('cada Tool de tools/list responde sin isError', async () => {
    // get_session_sql_text va aparte: necesita el sid de una sesion viva.
    const declaradas = (await client.listTools()).tools.map((t) => t.name).sort();
    expect([...MATRIX.map((c) => c.name), 'get_session_sql_text'].sort()).toEqual(declaradas);

    const fallos: string[] = [];
    for (const caso of MATRIX) {
      const resultado = await call(caso.name, caso.args ?? {});
      if (resultado.isError || (resultado.content[0]?.text ?? '').length === 0) {
        fallos.push(caso.name + ': ' + (resultado.content[0]?.text ?? 'respuesta vacia'));
      }
    }
    expect(fallos).toEqual([]);
  }, 180_000);

  it('get_session_sql_text responde para una sesion viva', async () => {
    const propia = await call('run_query', {
      sql: "SELECT SID, SERIAL# FROM V$SESSION WHERE SID = SYS_CONTEXT('USERENV','SID')",
    });
    const sesion = JSON.parse(propia.content[0]?.text ?? '{}') as {
      rows: { SID: number; 'SERIAL#': number }[];
    };
    const row = sesion.rows[0];
    expect(row).toBeDefined();

    const resultado = await call('get_session_sql_text', { sid: row!.SID, serialNum: row!['SERIAL#'] });
    expect(resultado.isError).toBeFalsy();
  });

  it('los recursos y los prompts se publican y se leen', async () => {
    // La auditoria se publica como plantilla, no como recurso estatico.
    const plantillas = await client.listResourceTemplates();
    expect(plantillas.resourceTemplates.map((r) => r.uriTemplate)).toContain(
      'oracle://audit/session/{id}',
    );

    const leido = (await client.readResource({ uri: 'oracle://audit/session/current' })) as {
      contents: { text?: string }[];
    };
    expect(leido.contents[0]?.text ?? '').toContain('T91_IT_ALL');

    const prompts = await client.listPrompts();
    expect(prompts.prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts.prompts) {
      const args: Record<string, string> = {};
      for (const arg of prompt.arguments ?? []) {
        // Se rellenan todos los argumentos declarados, no solo los obligatorios:
        // un schema opcional sin valor hace fallar el prompt.
        args[arg.name] = ARGUMENTOS[arg.name] ?? 'demo';
      }
      const armado = await client.getPrompt({ name: prompt.name, arguments: args });
      expect(armado.messages.length).toBeGreaterThan(0);
    }
  }, 120_000);
});
