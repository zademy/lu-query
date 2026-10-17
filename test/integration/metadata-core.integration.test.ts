import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createServer, type ServerHandle } from '../../src/server.js';

/**
 * Integration de la metadata núcleo contra el contenedor Oracle real.
 *   LU_TEST_INTEGRATION=1 \
 *   ORACLE_DB_URL='jdbc:oracle:thin:@//localhost:1521/FREEPDB1' \
 *   ORACLE_DB_USERNAME=DEVUSER ORACLE_DB_PASSWORD=DevPassword123 npm run test:integration
 */
const optIn = process.env.LU_TEST_INTEGRATION === '1';

const GOOD_ENV: NodeJS.ProcessEnv = {
  ORACLE_DB_URL: process.env.ORACLE_DB_URL ?? 'jdbc:oracle:thin:@//localhost:1521/FREEPDB1',
  ORACLE_DB_USERNAME: process.env.ORACLE_DB_USERNAME ?? 'DEVUSER',
  ORACLE_DB_PASSWORD: process.env.ORACLE_DB_PASSWORD ?? 'DevPassword123',
  // Como el `DefaultSchemaEnvPostProcessor` del Java: el schema por defecto es el
  // de la sesión, así se ejercita el camino "el cliente omite schema".
  ORACLE_DB_SCHEMA: process.env.ORACLE_DB_SCHEMA ?? process.env.ORACLE_DB_USERNAME ?? 'DEVUSER',
};

/** Tabla de lectura del contenedor (esquema del usuario de conexión). */
const TABLE = 'EMPLOYEES';
const SCHEMA = GOOD_ENV.ORACLE_DB_USERNAME!;

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

describe.skipIf(!optIn)('metadata núcleo contra Oracle real', () => {
  let handle: ServerHandle;
  let client: Client;

  beforeAll(async () => {
    handle = createServer({ config: loadConfig({ ...GOOD_ENV, MCP_AUDIT_ENABLED: 'false' }) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'lu-query-metadata-integration', version: '0.0.0' });
    await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await handle.close();
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const result = (await client.callTool({ name, arguments: args })) as ToolResult;
    expect(result.isError).toBeFalsy();
    return result;
  };

  const rows = async (name: string, args: Record<string, unknown>) =>
    JSON.parse((await call(name, args)).content[0]?.text ?? '') as Record<string, unknown>[];

  /** El contenido de un recurso puede ser texto o blob; estos son texto. */
  const textOf = (contents: readonly unknown[]): string =>
    String((contents[0] as { text?: string } | undefined)?.text);

  it('describe_table devuelve la estructura real de EMPLOYEES', async () => {
    const columns = await rows('describe_table', { table: TABLE });

    expect(columns.map((column) => column.COLUMN_NAME)).toEqual([
      'EMP_ID',
      'FIRST_NAME',
      'LAST_NAME',
      'EMAIL',
      'PHONE',
      'HIRE_DATE',
      'SALARY',
      'DEPT_ID',
      'CREATED_DATE',
      'UPDATED_DATE',
    ]);
    const empId = columns[0]!;
    // El SQL del Java omite el scale cuando es 0 (`NULLIF(data_scale, 0)`).
    expect(empId.DATA_TYPE).toBe('NUMBER(10,)');
    expect(empId.NULLABLE).toBe('N');
    // En Oracle la cadena vacía es NULL: `COALESCE(comments, '')` sigue siendo NULL.
    expect(empId.COMMENTS).toBeNull();
    expect(columns[1]).toMatchObject({ DATA_TYPE: 'VARCHAR2(50)', NULLABLE: 'N' });
  }, 60_000);

  it('describe_table usa el schema del servidor cuando el cliente lo omite', async () => {
    const withSchema = await rows('describe_table', { schema: SCHEMA, table: TABLE });
    const withoutSchema = await rows('describe_table', { table: TABLE });

    expect(withoutSchema.map((column) => column.COLUMN_NAME)).toEqual(
      withSchema.map((column) => column.COLUMN_NAME),
    );
  }, 60_000);

  it('list_tables filtra por patrón LIKE y list_views devuelve las vistas del esquema', async () => {
    const tables = await rows('list_tables', { schema: SCHEMA, namePattern: 'emp%' });
    const views = await rows('list_views', { schema: SCHEMA });

    expect(tables).toContainEqual({ SCHEMA_NAME: SCHEMA, TABLE_NAME: TABLE });
    expect(views.map((view) => view.VIEW_NAME)).toContain('V_EMPLOYEE_DETAILS');
  }, 60_000);

  it('list_schemas incluye al usuario de conexión y list_objects trae el tipo y estado', async () => {
    const schemas = JSON.parse((await call('list_schemas', {})).content[0]?.text ?? '') as string[];
    const objects = await rows('list_objects', { schema: SCHEMA, type: 'TABLE' });

    expect(schemas).toContain(SCHEMA);
    expect(objects).toContainEqual(
      expect.objectContaining({ OBJECT_NAME: TABLE, OBJECT_TYPE: 'TABLE', STATUS: 'VALID' }),
    );
  }, 60_000);

  it('search_objects encuentra EMPLOYEES por substring y table_exists la confirma', async () => {
    const found = await rows('search_objects', { namePattern: 'employee' });
    const exists = JSON.parse(
      (await call('table_exists', { table: TABLE })).content[0]?.text ?? '',
    ) as boolean;

    expect(found).toContainEqual(
      expect.objectContaining({ OBJECT_NAME: TABLE, OBJECT_TYPE: 'TABLE' }),
    );
    expect(exists).toBe(true);
  }, 60_000);

  it('get_ddl devuelve el CREATE TABLE real, con el nombre en minúsculas', async () => {
    const ddl = JSON.parse(
      (await call('get_ddl', { name: 'employees', type: 'table' })).content[0]?.text ?? '',
    ) as string;

    expect(ddl).toContain('CREATE TABLE');
    expect(ddl).toContain(`"${SCHEMA}"."${TABLE}"`);
  }, 60_000);

  it('get_ddl de un objeto inexistente vuelve como isError, sin excepción', async () => {
    const result = (await client.callTool({
      name: 'get_ddl',
      arguments: { name: 'NO_SUCH_TABLE', type: 'TABLE' },
    })) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('was not found in ALL_OBJECTS');
  }, 60_000);

  it('el recurso de tabla devuelve la descripción en texto plano', async () => {
    const read = await client.readResource({ uri: `oracle://schema/${SCHEMA}/table/${TABLE}` });
    const text = textOf(read.contents);

    expect(read.contents[0]?.mimeType).toBe('text/plain');
    expect(text).toContain(`Table: ${SCHEMA}.${TABLE}`);
    expect(text).toContain('EMP_ID');
    expect(text).toContain('NOT NULL');
    expect(text).toContain('FIRST_NAME');
  }, 60_000);

  it('el recurso de DDL devuelve el CREATE TABLE del objeto', async () => {
    const read = await client.readResource({
      uri: `oracle://schema/${SCHEMA}/object/${TABLE}/ddl`,
    });
    const text = textOf(read.contents);

    expect(read.contents[0]?.mimeType).toBe('text/plain');
    expect(text.startsWith('CREATE TABLE')).toBe(true);
    expect(text).toContain(`"${SCHEMA}"."${TABLE}"`);
  }, 60_000);
});
