import { describe, expect, it } from 'vite-plus/test';
import { FakeDataAccess } from '../../src/db/fake-data-access.js';
import { createHarness, type Harness } from '../helpers/harness.js';

/** El SDK tipa el content como unión de bloques; estas tools devuelven texto. */
interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

const PERFORMANCE_TOOLS = [
  'list_active_sessions',
  'list_blocked_sessions',
  'list_locks',
  'get_session_sql_text',
  'list_top_sql',
  'get_wait_events',
  'get_session_longops',
  'get_instance_info',
  'get_database_info',
  'get_system_stats',
  'get_db_time_model',
  'get_parameter',
  'list_datafile_io',
];

async function withHarness(
  dataAccess: FakeDataAccess,
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  const harness = await createHarness({ dataAccess });
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

async function call(harness: Harness, name: string, args: Record<string, unknown> = {}) {
  return (await harness.client.callTool({ name, arguments: args })) as ToolResult;
}

/** SQL de la llamada n-ésima (0 por defecto). */
function sql(dataAccess: FakeDataAccess, index = 0): string {
  return dataAccess.calls[index]?.sql ?? '';
}

/** Binds de la llamada n-ésima (0 por defecto). */
function binds(dataAccess: FakeDataAccess, index = 0): unknown[] | undefined {
  return dataAccess.calls[index]?.binds;
}

describe('performance — registro y paridad con el Java', () => {
  it('expone las 13 tools de PerformanceTools.java', async () => {
    await withHarness(new FakeDataAccess(), async (harness) => {
      const { tools } = await harness.client.listTools();
      const names = tools.map((tool) => tool.name);

      for (const name of PERFORMANCE_TOOLS) {
        expect(names).toContain(name);
      }
      expect(names.filter((name) => PERFORMANCE_TOOLS.includes(name))).toHaveLength(13);
    });
  });

  it('get_session_sql_text documenta sid y serial exactos del Java', async () => {
    await withHarness(new FakeDataAccess(), async (harness) => {
      const { tools } = await harness.client.listTools();
      const tool = tools.find((candidate) => candidate.name === 'get_session_sql_text');

      expect(tool?.description).toBe(
        'Return the full SQL text currently being executed by a session, given its sid and serial#.',
      );
    });
  });

  it('list_top_sql documenta el sort por defecto del Java', async () => {
    await withHarness(new FakeDataAccess(), async (harness) => {
      const { tools } = await harness.client.listTools();
      const tool = tools.find((candidate) => candidate.name === 'list_top_sql');

      expect(tool?.description).toBe(
        'Top-N SQL statements ordered by buffer_gets (default), disk_reads, elapsed_time, executions or cpu_time. Returns sql_id, executions, gets/reads/elapsed and a 200-char SQL preview.',
      );
    });
  });
});

describe('performance — SQL y binds del Java', () => {
  it('list_active_sessions filtra por username y sid con la columna last_call_et', async () => {
    const dataAccess = new FakeDataAccess().on(
      (call) => call.sql.includes('FROM v$session'),
      () => ({ rows: [] }),
    );

    await withHarness(dataAccess, async (harness) => {
      await call(harness, 'list_active_sessions', { username: 'DEVUSER', sid: 42 });
    });

    expect(sql(dataAccess)).toContain('last_call_et AS seconds_since_last_call');
    expect(sql(dataAccess)).toContain("WHERE status = 'ACTIVE'");
    expect(sql(dataAccess)).toContain('ORDER BY sid');
    expect(binds(dataAccess)).toEqual(['DEVUSER', 'DEVUSER', 42, 42]);
  });

  it('list_blocked_sessions trae blocker_username/blocker_program del JOIN a bs', async () => {
    const dataAccess = new FakeDataAccess().on(
      (call) => call.sql.includes('blocking_session'),
      () => ({ rows: [] }),
    );

    await withHarness(dataAccess, async (harness) => {
      await call(harness, 'list_blocked_sessions');
    });

    expect(sql(dataAccess)).toContain('s.blocking_session AS blocker_sid');
    expect(sql(dataAccess)).toContain('bs.username AS blocker_username');
    expect(sql(dataAccess)).toContain('bs.program AS blocker_program');
    expect(sql(dataAccess)).toContain('s.event AS wait_event');
    expect(sql(dataAccess)).toContain('s.seconds_in_wait');
    expect(binds(dataAccess)).toEqual(undefined);
  });

  it('list_locks decodifica tipo/modos y une v$locked_object con all_objects', async () => {
    const dataAccess = new FakeDataAccess().on(
      (call) => call.sql.includes('v$lock'),
      () => ({ rows: [] }),
    );

    await withHarness(dataAccess, async (harness) => {
      await call(harness, 'list_locks');
    });

    expect(sql(dataAccess)).toContain('DECODE(l.type,');
    expect(sql(dataAccess)).toContain(
      "'TM','DML','TX','Transaction','UL','User','MR','Media Recovery',",
    );
    expect(sql(dataAccess)).toContain("DECODE(l.lmode,0,'None',1,'Null',2,'Row Share'");
    expect(sql(dataAccess)).toContain('lo.oracle_username AS locked_user');
    expect(sql(dataAccess)).toContain('o.object_name, o.object_type');
    expect(sql(dataAccess)).toContain("IN ('TM','TX','UL','MR','ST','CU','JX')");
    expect(sql(dataAccess)).toContain('AND (l.lmode > 0 OR l.request > 0)');
    expect(sql(dataAccess)).toContain('ORDER BY l.sid, l.type');
  });

  it('get_session_sql_text localiza por address+hash_value y concatena sin separador', async () => {
    const dataAccess = new FakeDataAccess().on(
      (call) => call.sql.includes('v$sqltext_with_newlines'),
      () => ({ rows: [{ SQL_TEXT: 'SELECT ' }, { SQL_TEXT: '1 FROM dual' }] }),
    );

    let result: ToolResult | undefined;
    await withHarness(dataAccess, async (harness) => {
      result = await call(harness, 'get_session_sql_text', { sid: 7, serialNum: 9 });
    });

    expect(sql(dataAccess)).toContain(
      'WHERE address = (SELECT sql_address FROM v$session WHERE sid = :sid AND serial# = :serial)',
    );
    expect(sql(dataAccess)).toContain(
      'AND hash_value = (SELECT sql_hash_value FROM v$session WHERE sid = :sid AND serial# = :serial)',
    );
    expect(sql(dataAccess)).toContain('ORDER BY piece');
    expect(binds(dataAccess)).toEqual([7, 9, 7, 9]);
    // Java: StringBuilder append pieza a pieza, sin '\n' entre ellas.
    expect(result?.content[0]?.text).toBe('SELECT 1 FROM dual');
  });

  it('list_top_sql interpola el ORDER BY whitelisted y bindea solo el limit', async () => {
    const dataAccess = new FakeDataAccess().on(
      (call) => call.sql.includes('FROM v$sql'),
      () => ({ rows: [] }),
    );

    await withHarness(dataAccess, async (harness) => {
      await call(harness, 'list_top_sql');
      await call(harness, 'list_top_sql', { orderBy: 'disk' });
      await call(harness, 'list_top_sql', { orderBy: 'elapsed_time', limit: 5 });
    });

    expect(sql(dataAccess, 0)).toContain('ORDER BY buffer_gets DESC');
    expect(sql(dataAccess, 0)).toContain('SUBSTR(sql_text, 1, 200) AS sql_preview');
    expect(sql(dataAccess, 0)).toContain('FETCH FIRST :limit ROWS ONLY');
    expect(binds(dataAccess, 0)).toEqual([10]);
    expect(sql(dataAccess, 1)).toContain('ORDER BY disk_reads DESC');
    expect(binds(dataAccess, 1)).toEqual([10]);
    expect(sql(dataAccess, 2)).toContain('ORDER BY elapsed_time DESC');
    expect(binds(dataAccess, 2)).toEqual([5]);
  });

  it('get_wait_events filtra por sid y wait_class', async () => {
    const dataAccess = new FakeDataAccess().on(
      (call) => call.sql.includes('v$session_wait'),
      () => ({ rows: [] }),
    );

    await withHarness(dataAccess, async (harness) => {
      await call(harness, 'get_wait_events', { sid: 7, waitClass: 'User I/O' });
    });

    expect(sql(dataAccess)).toContain('SELECT sid, seq#, event, p1text, p1, p2text, p2');
    expect(sql(dataAccess)).toContain('wait_time, seconds_in_wait, state');
    expect(binds(dataAccess)).toEqual([7, 7, 'User I/O', 'User I/O']);
  });

  it('get_session_longops solo trae operaciones en curso', async () => {
    const dataAccess = new FakeDataAccess().on(
      (call) => call.sql.includes('v$session_longops'),
      () => ({ rows: [] }),
    );

    await withHarness(dataAccess, async (harness) => {
      await call(harness, 'get_session_longops', { sid: 7 });
    });

    expect(sql(dataAccess)).toContain(
      'TO_CHAR(ROUND((sofar / NULLIF(totalwork,0)) * 100, 2)) AS pct_done',
    );
    expect(sql(dataAccess)).toContain('AND sofar < totalwork');
    expect(sql(dataAccess)).toContain('ORDER BY start_time DESC');
    expect(binds(dataAccess)).toEqual([7, 7]);
  });

  it('get_instance_info devuelve objeto vacío sin filas, con las columnas del Java', async () => {
    const dataAccess = new FakeDataAccess().on(
      (call) => call.sql.includes('v$instance'),
      () => ({ rows: [] }),
    );

    let result: ToolResult | undefined;
    await withHarness(dataAccess, async (harness) => {
      result = await call(harness, 'get_instance_info');
    });

    expect(sql(dataAccess)).toContain('parallel, thread# AS thread, archiver, logins');
    expect(sql(dataAccess)).toContain('shutdown_pending, database_status');
    expect(result?.content[0]?.text).toBe('{}');
  });

  it('get_database_info incluye dbid, plataforma, role y force_logging', async () => {
    const dataAccess = new FakeDataAccess().on(
      (call) => call.sql.includes('v$database'),
      () => ({ rows: [] }),
    );

    await withHarness(dataAccess, async (harness) => {
      await call(harness, 'get_database_info');
    });

    expect(sql(dataAccess)).toContain(
      'platform_id, platform_name, database_role AS role, force_logging, flashback_on',
    );
  });

  it('get_system_stats devuelve stat_id y class con el filtro de clases del Java', async () => {
    const dataAccess = new FakeDataAccess().on(
      (call) => call.sql.includes('v$sysstat'),
      () => ({ rows: [] }),
    );

    await withHarness(dataAccess, async (harness) => {
      await call(harness, 'get_system_stats');
    });

    expect(sql(dataAccess)).toContain('SELECT statistic# AS stat_id, name, class, value');
    expect(sql(dataAccess)).toContain('WHERE class IN (1, 2, 4, 8, 16, 32, 64, 128)');
    expect(sql(dataAccess)).toContain('ORDER BY class, name');
  });

  it('get_db_time_model devuelve stat_id y stat_name AS name', async () => {
    const dataAccess = new FakeDataAccess().on(
      (call) => call.sql.includes('v$sys_time_model'),
      () => ({ rows: [] }),
    );

    await withHarness(dataAccess, async (harness) => {
      await call(harness, 'get_db_time_model');
    });

    expect(sql(dataAccess)).toContain('SELECT stat_id, stat_name AS name, value');
    expect(sql(dataAccess)).toContain('ORDER BY stat_name');
  });

  it('get_parameter aplica LikePatterns y el ESCAPE del Java', async () => {
    const dataAccess = new FakeDataAccess().on(
      (call) => call.sql.includes('v$parameter'),
      () => ({ rows: [] }),
    );

    await withHarness(dataAccess, async (harness) => {
      await call(harness, 'get_parameter');
      await call(harness, 'get_parameter', { name: 'sga_target' });
    });

    expect(sql(dataAccess)).toContain('isses_modifiable AS session_modifiable');
    expect(sql(dataAccess)).toContain('issys_modifiable AS system_modifiable');
    expect(sql(dataAccess)).toContain("LIKE UPPER(:name) ESCAPE '\\'");
    expect(binds(dataAccess, 0)).toEqual(['%']);
    // 'sga_target' contiene '_' (wildcard): LikePatterns lo pasa tal cual, uppercased.
    expect(binds(dataAccess, 1)).toEqual(['SGA_TARGET']);
  });

  it('list_datafile_io une v$datafile con v$filestat', async () => {
    const dataAccess = new FakeDataAccess().on(
      (call) => call.sql.includes('v$filestat'),
      () => ({ rows: [] }),
    );

    await withHarness(dataAccess, async (harness) => {
      await call(harness, 'list_datafile_io');
    });

    expect(sql(dataAccess)).toContain('d.bytes / 1024 / 1024 AS size_mb');
    expect(sql(dataAccess)).toContain('LEFT JOIN v$filestat fs ON fs.file# = d.file#');
    expect(sql(dataAccess)).toContain('fs.avgiotim AS avg_io_ms');
  });
});

describe('performance — sin privilegio de catálogo', () => {
  it('devuelve isError con el hint del grant cuando falta el privilegio V$', async () => {
    const dataAccess = new FakeDataAccess().alwaysFail(
      Object.assign(new Error('ORA-00942: table or view does not exist'), { code: 'ORA-00942' }),
    );

    await withHarness(dataAccess, async (harness) => {
      const result = await call(harness, 'get_instance_info');

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('SELECT ANY DICTIONARY');
    });
  });

  it('otros errores ORA llegan isError sin el hint del grant', async () => {
    const dataAccess = new FakeDataAccess().alwaysFail(
      Object.assign(new Error('ORA-00904: "X": invalid identifier'), { code: 'ORA-00904' }),
    );

    await withHarness(dataAccess, async (harness) => {
      const result = await call(harness, 'list_locks');

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).not.toContain('SELECT ANY DICTIONARY');
    });
  });
});
