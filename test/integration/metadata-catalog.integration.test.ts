import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { loadConfig } from '../../src/config.js';
import { createServer, type ServerHandle } from '../../src/server.js';

/**
 * Smoke de CADA tool del catálogo de #9 contra el contenedor Oracle real.
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

const SCHEMA = GOOD_ENV.ORACLE_DB_USERNAME!;
const TABLE = 'EMPLOYEES';
const VIEW = 'V_EMPLOYEE_DETAILS';

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

describe.skipIf(!optIn)('catálogo de metadata contra Oracle real', () => {
  let handle: ServerHandle;
  let client: Client;

  beforeAll(async () => {
    handle = createServer({ config: loadConfig({ ...GOOD_ENV, MCP_AUDIT_ENABLED: 'false' }) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'lu-query-metadata-catalog-integration', version: '0.0.0' });
    await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await handle.close();
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const result = (await client.callTool({ name, arguments: args })) as ToolResult;
    expect(result.isError, `${name} falló: ${result.content[0]?.text}`).toBeFalsy();
    return result;
  };

  const rows = async (name: string, args: Record<string, unknown>) =>
    JSON.parse((await call(name, args)).content[0]?.text ?? '') as Record<string, unknown>[];

  it('list_indexes trae los índices de EMPLOYEES con sus columnas', async () => {
    const indexes = await rows('list_indexes', { table: TABLE });

    expect(indexes.map((index) => index.INDEX_NAME)).toContain('IDX_EMP_DEPT');
    expect(indexes.find((index) => index.INDEX_NAME === 'IDX_EMP_DEPT')).toMatchObject({
      UNIQUENESS: 'NONUNIQUE',
      STATUS: 'VALID',
    });
    expect(indexes.every((index) => typeof index.COLUMNS === 'string')).toBe(true);
  }, 60_000);

  it('list_constraints trae la PK y la FK de EMPLOYEE_PROJECTS', async () => {
    const own = await rows('list_constraints', { table: TABLE });
    const child = await rows('list_constraints', { table: 'EMPLOYEE_PROJECTS' });

    expect(own.map((row) => row.CONSTRAINT_TYPE)).toContain('PRIMARY KEY');
    expect(own.map((row) => row.CONSTRAINT_TYPE)).toContain('FOREIGN KEY');
    expect(child.map((row) => row.CONSTRAINT_TYPE)).toContain('FOREIGN KEY');
    expect(child.find((row) => row.CONSTRAINT_NAME === 'FK_EP_EMP')).toMatchObject({
      REFERENCED_OWNER: SCHEMA,
      REFERENCED_CONSTRAINT: 'SYS_C008595',
    });
    expect(own.find((row) => row.CONSTRAINT_TYPE === 'PRIMARY KEY')?.COLUMNS).toBe('EMP_ID');
  }, 60_000);

  it('list_sequences lista las secuencias del esquema', async () => {
    const sequences = await rows('list_sequences', { schema: SCHEMA });

    expect(sequences.length).toBeGreaterThan(0);
    expect(sequences.every((row) => row.SCHEMA_NAME === SCHEMA)).toBe(true);
    expect(sequences[0]).toHaveProperty('INCREMENT_BY');
  }, 60_000);

  it('get_sequence_info devuelve la fila de una secuencia del esquema', async () => {
    const [first] = await rows('list_sequences', { schema: SCHEMA });
    const result = await call('get_sequence_info', { sequence: String(first!.SEQUENCE_NAME) });
    const info = JSON.parse(result.content[0]?.text ?? '') as Record<string, unknown>;

    expect(info.SCHEMA_NAME).toBe(SCHEMA);
    expect(info.SEQUENCE_NAME).toBe(first!.SEQUENCE_NAME);
    expect(Number(info.INCREMENT_BY)).toBe(1);
    expect(info).toHaveProperty('ORDER_FLAG');
  }, 60_000);

  it('get_sequence_info avisa en texto plano si la secuencia no existe', async () => {
    const result = await call('get_sequence_info', { sequence: 'NO_EXISTE' });

    expect(result.content[0]?.text).toBe(`Sequence not found: ${SCHEMA}.NO_EXISTE`);
  }, 60_000);

  it('list_triggers ve los triggers del esquema', async () => {
    const triggers = await rows('list_triggers', { schema: SCHEMA });

    expect(triggers.map((row) => row.TRIGGER_NAME)).toContain('TRG_EMPLOYEES_UPDATE');
    expect(triggers.find((row) => row.TRIGGER_NAME === 'TRG_EMPLOYEES_UPDATE')).toMatchObject({
      TRIGGERING_EVENT: 'UPDATE',
      TABLE_NAME: TABLE,
      STATUS: 'ENABLED',
    });
  }, 60_000);

  it('list_procedures encuentra ADD_EMPLOYEE y GET_EMPLOYEE_COUNT', async () => {
    const procedures = await rows('list_procedures', { schema: SCHEMA });
    const names = procedures.map((row) => row.NAME);

    expect(names).toContain('ADD_EMPLOYEE');
    expect(names).toContain('GET_EMPLOYEE_COUNT');
    expect(procedures.find((row) => row.NAME === 'ADD_EMPLOYEE')).toMatchObject({
      TYPE: 'PROCEDURE',
      STATUS: 'VALID',
    });
  }, 60_000);

  it('list_procedures filtra por patrón LIKE y por tipo', async () => {
    const byPattern = await rows('list_procedures', { schema: SCHEMA, namePattern: 'add_%' });
    const byType = await rows('list_procedures', { schema: SCHEMA, type: 'FUNCTION' });

    expect(byPattern.map((row) => row.NAME)).toEqual(['ADD_EMPLOYEE']);
    expect(byType.map((row) => row.NAME)).toContain('GET_EMPLOYEE_COUNT');
  }, 60_000);

  it('list_synonyms filtra por patrón y resuelve el destino', async () => {
    const none = await rows('list_synonyms', { schema: SCHEMA, namePattern: 'NO_EXISTE%' });
    const publicSynonyms = await rows('list_synonyms', { namePattern: 'ALL_TABLES' });

    expect(none).toEqual([]);
    expect(publicSynonyms.length).toBeGreaterThan(0);
    expect(publicSynonyms.find((row) => row.NAME === 'ALL_TABLES')).toMatchObject({
      TARGET_OWNER: 'SYS',
      TARGET_NAME: 'ALL_TABLES',
    });
  }, 60_000);

  it('list_db_links responde sin argumentos (puede venir vacío)', async () => {
    const links = await rows('list_db_links', {});

    expect(Array.isArray(links)).toBe(true);
  }, 60_000);

  it('list_directories responde sin argumentos (puede venir vacío)', async () => {
    const directories = await rows('list_directories', {});

    expect(Array.isArray(directories)).toBe(true);
  }, 60_000);

  it('list_external_tables responde con el filtro de owner', async () => {
    const external = await rows('list_external_tables', { schema: SCHEMA });

    expect(Array.isArray(external)).toBe(true);
    expect(external.every((row) => row.SCHEMA_NAME === SCHEMA)).toBe(true);
  }, 60_000);

  it('list_materialized_views acepta el patrón por defecto', async () => {
    const mviews = await rows('list_materialized_views', { schema: SCHEMA });

    expect(Array.isArray(mviews)).toBe(true);
  }, 60_000);

  it('list_mview_logs responde con el filtro de owner', async () => {
    const logs = await rows('list_mview_logs', { schema: SCHEMA });

    expect(Array.isArray(logs)).toBe(true);
  }, 60_000);

  it('list_partitions devuelve vacío para una tabla no particionada', async () => {
    const partitions = await rows('list_partitions', { table: TABLE });

    expect(partitions).toEqual([]);
  }, 60_000);

  it('list_ind_partitions devuelve vacío para los índices no particionados', async () => {
    const partitions = await rows('list_ind_partitions', { table: TABLE });

    expect(partitions).toEqual([]);
  }, 60_000);

  it('list_subpartitions devuelve vacío para una tabla no compuesta', async () => {
    const subpartitions = await rows('list_subpartitions', { table: TABLE });

    expect(subpartitions).toEqual([]);
  }, 60_000);

  it('list_lob_columns devuelve vacío si la tabla no tiene LOBs', async () => {
    const lobs = await rows('list_lob_columns', { table: TABLE });

    expect(lobs).toEqual([]);
  }, 60_000);

  it('list_types responde con el filtro de owner', async () => {
    const types = await rows('list_types', { schema: SCHEMA });

    expect(Array.isArray(types)).toBe(true);
    expect(types.every((row) => row.SCHEMA_NAME === SCHEMA)).toBe(true);
  }, 60_000);

  it('list_invalid_objects no reporta objetos inválidos en el sample', async () => {
    const invalid = await rows('list_invalid_objects', { schema: SCHEMA });

    expect(Array.isArray(invalid)).toBe(true);
    expect(invalid.every((row) => row.STATUS === 'INVALID')).toBe(true);
  }, 60_000);

  it('list_invalid_objects acepta el filtro de tipo', async () => {
    const invalid = await rows('list_invalid_objects', { schema: SCHEMA, type: 'PROCEDURE' });

    expect(Array.isArray(invalid)).toBe(true);
  }, 60_000);

  it('list_dependencies devuelve las dependencias de la vista del sample', async () => {
    const dependencies = await rows('list_dependencies', { name: VIEW });

    expect(dependencies.length).toBeGreaterThan(0);
    expect(dependencies.map((row) => row.REFERENCED_NAME)).toContain(TABLE);
    expect(dependencies.map((row) => row.REFERENCED_NAME)).toContain('DEPARTMENTS');
    expect(dependencies.every((row) => row.REFERENCED_OWNER === SCHEMA)).toBe(true);
  }, 60_000);

  it('list_dependencies filtra por tipo del objeto dependiente', async () => {
    const dependencies = await rows('list_dependencies', {
      name: VIEW,
      type: 'VIEW',
    });
    const none = await rows('list_dependencies', { name: VIEW, type: 'TRIGGER' });

    expect(dependencies.length).toBeGreaterThan(0);
    expect(dependencies.every((row) => row.TYPE === 'VIEW')).toBe(true);
    expect(dependencies.every((row) => row.REFERENCED_TYPE === 'TABLE')).toBe(true);
    expect(none).toEqual([]);
  }, 60_000);

  it('list_scheduler_jobs responde con el filtro de owner', async () => {
    const jobs = await rows('list_scheduler_jobs', { schema: SCHEMA });

    expect(Array.isArray(jobs)).toBe(true);
    expect(jobs.every((row) => row.SCHEMA_NAME === SCHEMA)).toBe(true);
  }, 60_000);

  it('list_scheduler_job_runs corta en 20 filas por defecto y acepta jobName', async () => {
    const all = await rows('list_scheduler_job_runs', {});
    const byJob = await rows('list_scheduler_job_runs', { jobName: 'NO_EXISTE' });

    expect(all.length).toBeLessThanOrEqual(20);
    expect(byJob).toEqual([]);
  }, 60_000);
});
