import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { auditStatement } from '../../src/audit/audit-writer.js';
import { MAX_ROWS, TIMEOUTS } from '../../src/config.js';
import { FakeDataAccess } from '../../src/db/fake-data-access.js';
import { createHarness, type HarnessOptions } from '../helpers/harness.js';

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

/** Llama una tool del grupo y devuelve el texto plano del primer bloque. */
async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  dataAccess?: FakeDataAccess,
): Promise<ToolResult> {
  const harness = await createHarness(dataAccess ? { dataAccess } : {});
  try {
    return (await harness.client.callTool({ name, arguments: args })) as ToolResult;
  } finally {
    await harness.close();
  }
}

/** Fake que resuelve el schema de sesión (SYS_CONTEXT) cuando la tool lo omite. */
function withSessionSchema(data: FakeDataAccess, schema = 'DEVUSER'): FakeDataAccess {
  return data.on(
    ({ sql }) => sql.includes('CURRENT_SCHEMA'),
    // node-oracledb devuelve el nombre de columna en MAYÚSCULAS, no el alias.
    () => ({ rows: [{ CURRENT_SCHEMA: schema }] }),
  );
}

describe('tools/list: stats, sesión y health', () => {
  it('publica las 6 tools de estadísticas/sesión con la descripción del Java', async () => {
    const harness = await createHarness();
    try {
      const { tools } = await harness.client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool]));

      expect(byName.get('get_table_stats')?.description).toBe(
        'Return optimizer statistics for a table: row count, blocks, avg row length, sample size, last analyzed, degree, partitioned, compression.',
      );
      expect(byName.get('get_column_stats')?.description).toBe(
        'Return optimizer statistics for columns of a table: number of distinct values (NDV), density, null count, bucket count, low/high value, histogram type. Optional column filter.',
      );
      expect(byName.get('get_histogram')?.description).toBe(
        'Return the optimizer histogram endpoints for a column (frequency or height-balanced). Useful to understand data skew and cardinality estimates.',
      );
      expect(byName.get('get_session_privs')?.description).toBe(
        'List system privileges available to the current connection: directly granted system privs plus effective privs from enabled roles (deduplicated, ordered). WHEN TO CALL: only when the user explicitly asks what privileges the connection has; do NOT call as a preamble before querying tables or objects.',
      );
      expect(byName.get('get_session_roles')?.description).toBe(
        'List roles enabled for the current connection, with admin option and default-role flag. WHEN TO CALL: only when the user explicitly asks which roles the connection has; do NOT call as a preamble before querying tables or objects.',
      );
      expect(byName.get('get_plsql_errors')?.description).toBe(
        'List compilation errors of PL/SQL units (procedures, functions, packages, triggers, types). Optional schema, name and type filter. Critical for diagnosing broken code.',
      );
      expect(byName.get('oracle_mcp_health_report')?.description).toBe(
        'One-shot readiness check: connectivity, database version, catalog-role, invalid objects, and server configuration (max-rows, query-timeout, audit). Returns an aggregated health report for quick self-diagnosis. WHEN TO CALL: only when the user explicitly asks for a health/readiness check; do NOT call as a preamble before other work.',
      );
    } finally {
      await harness.close();
    }
  });

  it('marca table/column como requeridas según el Java', async () => {
    const harness = await createHarness();
    try {
      const { tools } = await harness.client.listTools();
      const required = new Map(
        tools.map((tool) => [
          tool.name,
          (tool.inputSchema as { required?: string[] }).required ?? [],
        ]),
      );

      expect(required.get('get_table_stats')).toEqual(['table']);
      expect(required.get('get_column_stats')).toEqual(['table']);
      expect(required.get('get_histogram')).toEqual(['table', 'column']);
      expect(required.get('get_plsql_errors')).toEqual([]);
      expect(required.get('get_session_privs')).toEqual([]);
      expect(required.get('get_session_roles')).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});

describe('get_table_stats', () => {
  const ROW = {
    SCHEMA_NAME: 'DEVUSER',
    NAME: 'EMPLOYEES',
    NUM_ROWS: 107,
    BLOCKS: 5,
    EMPTY_BLOCKS: 0,
    AVG_SPACE: 0,
    CHAIN_CNT: 0,
    AVG_ROW_LEN: 71,
    SAMPLE_SIZE: 107,
    LAST_ANALYZED: null,
    DEGREE: '1',
    INSTANCES: '1',
    PARTITIONED: 'NO',
    LOGGING: 'YES',
    COMPRESSION: 'DISABLED',
    CACHE: 'N',
  };

  it('devuelve las filas de all_tables con schema explícito', async () => {
    const data = new FakeDataAccess().on(
      ({ sql }) => sql.includes('FROM all_tables'),
      () => ({ rows: [ROW] }),
    );

    const result = await callTool(
      'get_table_stats',
      { schema: 'DEVUSER', table: 'EMPLOYEES' },
      data,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual([ROW]);

    const call = data.calls.find(({ sql }) => sql.includes('FROM all_tables'));
    expect(call?.binds).toEqual(['DEVUSER', 'EMPLOYEES']);
    // El bind de la tabla no puede llamarse :table (ORA-01745), pero el SQL es el del Java.
    expect(call?.sql).toContain('WHERE owner = :schema AND table_name = :name');
  });

  it('sin schema, resuelve el schema de la sesión', async () => {
    const data = withSessionSchema(
      new FakeDataAccess().on(
        ({ sql }) => sql.includes('FROM all_tables'),
        () => ({ rows: [ROW] }),
      ),
    );

    await callTool('get_table_stats', { table: 'EMPLOYEES' }, data);

    expect(data.calls.find(({ sql }) => sql.includes('FROM all_tables'))?.binds).toEqual([
      'DEVUSER',
      'EMPLOYEES',
    ]);
  });
});

describe('get_column_stats', () => {
  it('devuelve las filas de all_tab_col_statistics con el filtro de columna', async () => {
    const data = new FakeDataAccess().on(
      ({ sql }) => sql.includes('FROM all_tab_col_statistics'),
      () => ({ rows: [{ COLUMN_NAME: 'SALARY', NDV: 58 }] }),
    );

    const result = await callTool(
      'get_column_stats',
      { schema: 'DEVUSER', table: 'EMPLOYEES', column: 'SALARY' },
      data,
    );

    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual([{ COLUMN_NAME: 'SALARY', NDV: 58 }]);
    // :column aparece dos veces en el SQL del Java → dos binds posicionales.
    expect(data.calls.find(({ sql }) => sql.includes('all_tab_col_statistics'))?.binds).toEqual([
      'DEVUSER',
      'EMPLOYEES',
      'SALARY',
      'SALARY',
    ]);
  });

  it('column omitida va como NULL (todas las columnas)', async () => {
    const data = new FakeDataAccess().on(
      ({ sql }) => sql.includes('FROM all_tab_col_statistics'),
      () => ({ rows: [] }),
    );

    await callTool('get_column_stats', { schema: 'DEVUSER', table: 'EMPLOYEES' }, data);

    expect(data.calls.find(({ sql }) => sql.includes('all_tab_col_statistics'))?.binds).toEqual([
      'DEVUSER',
      'EMPLOYEES',
      null,
      null,
    ]);
  });
});

describe('get_histogram', () => {
  it('devuelve los endpoints de all_histograms', async () => {
    const buckets = [
      { ENDPOINT_NUMBER: 1, ENDPOINT_VALUE: 1000, ENDPOINT_VALUE_TEXT: '1000' },
      { ENDPOINT_NUMBER: 2, ENDPOINT_VALUE: 2000, ENDPOINT_VALUE_TEXT: '2000' },
    ];
    const data = new FakeDataAccess().on(
      ({ sql }) => sql.includes('FROM all_histograms'),
      () => ({ rows: buckets }),
    );

    const result = await callTool(
      'get_histogram',
      { schema: 'DEVUSER', table: 'EMPLOYEES', column: 'SALARY' },
      data,
    );

    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(buckets);
    expect(data.calls.find(({ sql }) => sql.includes('all_histograms'))?.binds).toEqual([
      'DEVUSER',
      'EMPLOYEES',
      'SALARY',
    ]);
    expect(data.calls.find(({ sql }) => sql.includes('all_histograms'))?.sql).toContain(
      'SUBSTR(endpoint_actual_value, 1, 200) AS endpoint_value_text',
    );
  });
});

describe('get_session_privs / get_session_roles', () => {
  it('get_session_privs consulta user_sys_privs + session_privs sin binds', async () => {
    const data = new FakeDataAccess().on(
      ({ sql }) => sql.includes('FROM session_privs'),
      () => ({ rows: [{ USERNAME: 'DEVUSER', PRIVILEGE: 'CREATE SESSION', ADMIN_OPTION: 'NO' }] }),
    );

    const result = await callTool('get_session_privs', {}, data);

    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual([
      { USERNAME: 'DEVUSER', PRIVILEGE: 'CREATE SESSION', ADMIN_OPTION: 'NO' },
    ]);
    const call = data.calls.find(({ sql }) => sql.includes('FROM session_privs'));
    expect(call?.sql).toContain('FROM user_sys_privs');
    expect(call?.binds).toBeUndefined();
  });

  it('get_session_roles une session_roles con user_role_privs', async () => {
    // El SQL del Java lleva varios espacios: el matcher no puede asumir 'FROM session_roles'.
    const data = new FakeDataAccess().on(
      ({ sql }) => sql.includes('session_roles'),
      () => ({ rows: [{ ROLE: 'CONNECT', ADMIN_OPTION: 'NO', DEFAULT_ROLE: 'YES' }] }),
    );

    const result = await callTool('get_session_roles', {}, data);

    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual([
      { ROLE: 'CONNECT', ADMIN_OPTION: 'NO', DEFAULT_ROLE: 'YES' },
    ]);
    expect(data.calls.find(({ sql }) => sql.includes('session_roles'))?.sql).toContain(
      'LEFT JOIN user_role_privs r ON r.granted_role = s.role',
    );
  });
});

describe('get_plsql_errors', () => {
  it('filtra por schema, name y type con los binds del Java', async () => {
    const data = new FakeDataAccess().on(
      ({ sql }) => sql.includes('FROM all_errors'),
      () => ({ rows: [{ NAME: 'BROKEN', TYPE: 'PROCEDURE', LINE: 3, TEXT: 'PLS-00103' }] }),
    );

    const result = await callTool(
      'get_plsql_errors',
      { schema: 'DEVUSER', name: 'BROKEN', type: 'PROCEDURE' },
      data,
    );

    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual([
      { NAME: 'BROKEN', TYPE: 'PROCEDURE', LINE: 3, TEXT: 'PLS-00103' },
    ]);
    // Cada filtro aparece dos veces (:x IS NULL OR ... = :x) → binds duplicados.
    expect(data.calls.find(({ sql }) => sql.includes('FROM all_errors'))?.binds).toEqual([
      'DEVUSER',
      'DEVUSER',
      'BROKEN',
      'BROKEN',
      'PROCEDURE',
      'PROCEDURE',
    ]);
  });

  it('sin filtros, todos los binds van NULL (todos los schemas)', async () => {
    const data = new FakeDataAccess().on(
      ({ sql }) => sql.includes('FROM all_errors'),
      () => ({
        rows: [],
      }),
    );

    await callTool('get_plsql_errors', {}, data);

    expect(data.calls.find(({ sql }) => sql.includes('FROM all_errors'))?.binds).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });
});

describe('errores del grupo', () => {
  it('un fallo de Oracle sale como isError, no como excepción', async () => {
    const result = await callTool(
      'get_session_privs',
      {},
      new FakeDataAccess().alwaysFail(new Error('ORA-01017: invalid credentials')),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? '').toContain('ORA-01017');
  });
});

interface HealthReport {
  overallStatus: string;
  databaseName: string | null;
  checks: { name: string; status: string; detail: string }[];
}

/** Fake que responde las 4 sondas del health report; override por sonda. */
function healthyBackend(
  overrides: { version?: Error; roleCount?: number; invalidCount?: number } = {},
): FakeDataAccess {
  return new FakeDataAccess()
    .on(
      ({ sql }) => sql.includes("'DB_NAME'"),
      () => ({ rows: [{ DB_NAME: 'FREEPDB1' }] }),
    )
    .on(
      ({ sql }) => sql.includes('v$version'),
      // Ternario directo: el narrowing de `overrides.version` sobrevive aquí.
      () =>
        overrides.version
          ? overrides.version
          : { rows: [{ BANNER: 'Oracle AI Database 26ai Free Release 23.26.3.0.0 - Develop' }] },
    )
    .on(
      ({ sql }) => sql.includes('SELECT_CATALOG_ROLE'),
      () => ({ rows: [{ ROLE_COUNT: overrides.roleCount ?? 1 }] }),
    )
    .on(
      ({ sql }) => sql.includes("status = 'INVALID'"),
      () => ({ rows: [{ INVALID_COUNT: overrides.invalidCount ?? 0 }] }),
    );
}

async function callHealthReport(
  dataAccess?: FakeDataAccess,
  config?: HarnessOptions['config'],
): Promise<HealthReport> {
  const harness = await createHarness({
    ...(dataAccess ? { dataAccess } : {}),
    ...(config ? { config } : {}),
  });
  try {
    const result = (await harness.client.callTool({
      name: 'oracle_mcp_health_report',
      arguments: {},
    })) as ToolResult;
    expect(result.isError).toBeUndefined();
    return JSON.parse(result.content[0]?.text ?? '') as HealthReport;
  } finally {
    await harness.close();
  }
}

describe('oracle_mcp_health_report', () => {
  it('UP con las 5 sondas del Java y el nombre de la BD', async () => {
    const report = await callHealthReport(healthyBackend());

    expect(report.overallStatus).toBe('UP');
    expect(report.databaseName).toBe('FREEPDB1');
    expect(report.checks.map((check) => check.name)).toEqual([
      'database-connectivity',
      'database-version',
      'catalog-role',
      'invalid-objects',
      'server-config',
    ]);
    expect(report.checks[0]).toEqual({
      name: 'database-connectivity',
      status: 'PASS',
      detail: 'Connection established',
    });
    expect(report.checks[1]?.detail).toBe(
      'Oracle AI Database 26ai Free Release 23.26.3.0.0 - Develop',
    );
    expect(report.checks[2]).toEqual({
      name: 'catalog-role',
      status: 'PASS',
      detail: 'SELECT_CATALOG_ROLE granted (1 role(s))',
    });
    expect(report.checks[3]).toEqual({
      name: 'invalid-objects',
      status: 'PASS',
      detail: 'No invalid objects in current schema',
    });
    expect(report.checks[4]?.status).toBe('PASS');
    expect(report.checks[4]?.detail).toBe(
      `max-rows=${MAX_ROWS}, query-timeout=${TIMEOUTS.statementMs / 1000}s, audit=disabled`,
    );
  });

  it('DOWN: sin BD no hay databaseName y solo quedan conectividad y config', async () => {
    const report = await callHealthReport(
      new FakeDataAccess().alwaysFail(new Error('NJS-500: connection lost')),
    );

    expect(report.overallStatus).toBe('DOWN');
    expect(report.databaseName).toBeNull();
    expect(report.checks.map((check) => check.name)).toEqual([
      'database-connectivity',
      'server-config',
    ]);
    expect(report.checks[0]?.status).toBe('FAIL');
    expect(report.checks[0]?.detail).toContain('Cannot reach database:');
    expect(report.checks[0]?.detail).toContain('connection lost');
  });

  it('DEGRADED cuando la versión no se puede leer (WARN, no FAIL)', async () => {
    const report = await callHealthReport(
      healthyBackend({ version: new Error('ORA-00942: table or view does not exist') }),
    );

    expect(report.overallStatus).toBe('DEGRADED');
    expect(report.checks[1]).toMatchObject({
      name: 'database-version',
      status: 'WARN',
    });
    expect(report.checks[1]?.detail).toContain('Could not read version:');
  });

  it('WARN si falta SELECT_CATALOG_ROLE o hay objetos inválidos', async () => {
    const report = await callHealthReport(healthyBackend({ roleCount: 0, invalidCount: 2 }));

    expect(report.overallStatus).toBe('DEGRADED');
    expect(report.checks[2]).toEqual({
      name: 'catalog-role',
      status: 'WARN',
      detail: 'SELECT_CATALOG_ROLE not found; dictionary views may be restricted',
    });
    expect(report.checks[3]).toEqual({
      name: 'invalid-objects',
      status: 'WARN',
      detail: '2 invalid object(s) in current schema',
    });
  });

  describe('estado real de la auditoría', () => {
    const tempDirs: string[] = [];

    it('enabled cuando la sesión viva escribe de verdad', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'lu-query-audit-'));
      tempDirs.push(dir);

      const harness = await createHarness({
        dataAccess: healthyBackend(),
        config: { audit: { enabled: true, dir } },
      });
      try {
        // Una sentencia real por la API del writer: deja la sesión en disco.
        await auditStatement(
          harness.audit,
          'SELECT 1 FROM dual',
          () => Promise.resolve({}),
          () => 0,
        );

        const result = (await harness.client.callTool({
          name: 'oracle_mcp_health_report',
          arguments: {},
        })) as ToolResult;
        const report = JSON.parse(result.content[0]?.text ?? '') as HealthReport;

        expect(report.checks[4]?.detail).toContain('audit=enabled');
      } finally {
        await harness.close();
      }
    });

    it('disabled (I/O) cuando el writer dejó de escribir por un error de I/O', async () => {
      // Un archivo donde iría el directorio: mkdir falla y el writer se apaga.
      const blocker = join(tmpdir(), `lu-query-block-${Date.now()}`);
      await writeFile(blocker, 'x', 'utf8');

      const harness = await createHarness({
        dataAccess: healthyBackend(),
        config: { audit: { enabled: true, dir: join(blocker, 'audit') } },
      });
      try {
        // La sentencia se apaga sola por I/O: auditStatement nunca lanza.
        await auditStatement(
          harness.audit,
          'SELECT 1 FROM dual',
          () => Promise.resolve({}),
          () => 0,
        );

        const result = (await harness.client.callTool({
          name: 'oracle_mcp_health_report',
          arguments: {},
        })) as ToolResult;
        const report = JSON.parse(result.content[0]?.text ?? '') as HealthReport;

        expect(report.checks[4]?.detail).toContain('audit=disabled (I/O');
      } finally {
        await harness.close();
      }
    });
  });
});
