import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { loadConfig } from '../../src/config.js';
import type { DataAccess } from '../../src/db/data-access.js';
import type { OracleBind } from '../../src/db/oracle-types.js';
import { createServer, type ServerHandle } from '../../src/server.js';

/**
 * Integration de las tools DDL contra el contenedor Oracle real, como DEVUSER
 * (usuario con privilegios), para comprobar que el DDL se ejecuta de verdad:
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

/**
 * Objetos propios de este test con prefijo T7_IT_. Nunca se tocan las tablas de
 * ejemplo del esquema (EMPLOYEES y compañía): el test crea y borra lo suyo.
 */
const BASE = 'T7_IT_BASE';
const SEQ = 'T7_IT_SEQ';
const IDX = 'T7_IT_IDX';
const VIEW = 'T7_IT_V';
const SYN = 'T7_IT_SYN';
/** El log de mview lo crea Oracle con prefijo propio: MLOG$_<tabla>. */
const MVLOG = `MLOG$_${BASE}`;

const COMMENT = "It's the #7 test table";
const OWNER = GOOD_ENV.ORACLE_DB_USERNAME as string;

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

describe.skipIf(!optIn)('tools DDL create-style contra Oracle real', () => {
  let handle: ServerHandle;
  let client: Client;
  let db: DataAccess;
  let auditDir: string;

  beforeAll(async () => {
    auditDir = await mkdtemp(join(tmpdir(), 'lu-query-ddl-it-'));
    handle = createServer({ config: loadConfig({ ...GOOD_ENV, MCP_AUDIT_DIR: auditDir }) });
    db = handle.context.dataAccess;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'lu-query-ddl-integration', version: '0.0.0' });
    await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);

    // Tabla propia del test: nunca una tabla de ejemplo del esquema.
    await db.execute(`CREATE TABLE ${BASE} (C1 NUMBER PRIMARY KEY, C2 VARCHAR2(50))`);
  }, 60_000);

  afterAll(async () => {
    // Que la limpieza no tape un fallo anterior del test.
    for (const sql of [
      // El log de mview es una tabla más: se borra como tabla, no con DROP MATERIALIZED VIEW LOG.
      `DROP TABLE ${MVLOG} PURGE`,
      `DROP SYNONYM ${SYN}`,
      `DROP VIEW ${VIEW}`,
      `DROP INDEX ${IDX}`,
      `DROP SEQUENCE ${SEQ}`,
      `DROP TABLE ${BASE} PURGE`,
    ]) {
      await db.execute(sql).catch(() => undefined);
    }
    await client.close();
    await handle.close();
    await rm(auditDir, { recursive: true, force: true });
  }, 60_000);

  const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as ToolResult;

  /** Cuenta filas de una query de diccionario: 1 = el objeto existe. */
  const count = async (sql: string, binds?: OracleBind[]): Promise<number> =>
    (await db.queryForList(sql, binds)).length;

  it('comenta tabla y columna, y el comentario llega escapado al diccionario', async () => {
    const table = await call('comment_on_table', {
      schema: OWNER,
      table: BASE,
      comment: COMMENT,
    });
    const column = await call('comment_on_column', {
      schema: OWNER,
      table: BASE,
      column: 'C2',
      comment: COMMENT,
    });

    expect(table.isError).toBeFalsy();
    expect(table.content[0]?.text).toBe(`Comment applied to table ${OWNER}.${BASE}`);
    expect(column.isError).toBeFalsy();
    expect(column.content[0]?.text).toBe(`Comment applied to column ${OWNER}.${BASE}.C2`);

    const comments = await db.queryForList(
      'SELECT comments FROM user_tab_comments WHERE table_name = :name',
      [BASE],
    );
    const columnComments = await db.queryForList(
      'SELECT comments FROM user_col_comments WHERE table_name = :t AND column_name = :c',
      [BASE, 'C2'],
    );
    expect(comments[0]?.COMMENTS).toBe(COMMENT);
    expect(columnComments[0]?.COMMENTS).toBe(COMMENT);
  }, 60_000);

  it('crea la secuencia con sus cláusulas opcionales', async () => {
    const result = await call('create_sequence', {
      schema: OWNER,
      sequence: SEQ,
      startWith: 100,
      incrementBy: 10,
      cache: 20,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe(`Sequence ${OWNER}.${SEQ} created.`);
    expect(await count('SELECT 1 FROM user_sequences WHERE sequence_name = :n', [SEQ])).toBe(1);
  }, 60_000);

  it('crea el índice sobre la tabla propia', async () => {
    const result = await call('create_index', {
      schema: OWNER,
      index: IDX,
      tableSchema: OWNER,
      table: BASE,
      columns: ['C2'],
      unique: true,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe(
      `Unique index ${OWNER}.${IDX} created on ${OWNER}.${BASE}.`,
    );
    expect(await count('SELECT 1 FROM user_indexes WHERE index_name = :n', [IDX])).toBe(1);
    // La PK de C1 no se confunde con el índice que acabamos de crear.
    expect(
      await count('SELECT 1 FROM user_ind_columns WHERE index_name = :n AND column_name = :c', [
        IDX,
        'C2',
      ]),
    ).toBe(1);
  }, 60_000);

  it('crea la vista y se puede consultar', async () => {
    const result = await call('create_or_replace_view', {
      schema: OWNER,
      view: VIEW,
      selectBody: `SELECT C1, C2 FROM ${BASE}`,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe(`View ${OWNER}.${VIEW} created (or replaced).`);
    expect(await count('SELECT 1 FROM user_views WHERE view_name = :n', [VIEW])).toBe(1);
  }, 60_000);

  it('crea el synonym apuntando a la tabla propia', async () => {
    const result = await call('create_synonym', {
      schema: OWNER,
      synonym: SYN,
      targetSchema: OWNER,
      targetName: BASE,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe(`Synonym ${OWNER}.${SYN} created.`);
    expect(
      await count('SELECT 1 FROM user_synonyms WHERE synonym_name = :n AND table_owner = :o', [
        SYN,
        OWNER,
      ]),
    ).toBe(1);
  }, 60_000);

  it('crea el log de materialized view con PRIMARY KEY', async () => {
    const result = await call('create_mview_log', {
      schema: OWNER,
      table: BASE,
      withPrimaryKey: true,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe(`Materialized view log created on ${OWNER}.${BASE}.`);
    expect(await count('SELECT 1 FROM all_objects WHERE object_name = :n', [MVLOG])).toBe(1);
  }, 60_000);

  it('rechaza un identificador fuera de la allow-list sin tocar la base de datos', async () => {
    const before = await count('SELECT 1 FROM user_tables WHERE table_name = :n', [BASE]);

    const result = await call('comment_on_table', {
      schema: OWNER,
      table: `${BASE}" ; DROP TABLE ${BASE} --`,
      comment: 'x',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('identificador inválido');
    expect(await count('SELECT 1 FROM user_tables WHERE table_name = :n', [BASE])).toBe(before);
  }, 60_000);

  it('deja el DDL ejecutado auditado en el .md de la sesión', async () => {
    const [file] = await readdir(auditDir);
    const markdown = await readFile(join(auditDir, file!), 'utf8');

    expect(markdown).toContain(
      `COMMENT ON TABLE "${OWNER}"."${BASE}" IS 'It''s the #7 test table'`,
    );
    expect(markdown).toContain(`CREATE SEQUENCE "${OWNER}"."${SEQ}" START WITH 100`);
    expect(markdown).toContain(`CREATE UNIQUE INDEX "${OWNER}"."${IDX}"`);
    expect(markdown).toContain(`CREATE OR REPLACE VIEW "${OWNER}"."${VIEW}" AS`);
    expect(markdown).toContain(`CREATE MATERIALIZED VIEW LOG ON "${OWNER}"."${BASE}"`);
    expect(markdown).toMatch(/· comment_on_table · COMMENT · WRITE ·/);
  }, 60_000);
});
