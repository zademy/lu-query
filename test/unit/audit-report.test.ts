import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  auditFileName,
  renderAuditEntry,
  renderSessionHeader,
  type AuditRecord,
} from '../../src/audit/markdown.js';

const SCRIPT = fileURLToPath(
  new URL('../../skills/lu-query-audit-report/scripts/audit-report.mjs', import.meta.url),
);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lu-query-audit-report-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function record(
  partial: Partial<AuditRecord> & Pick<AuditRecord, 'sequence' | 'tool'>,
): AuditRecord {
  // La entrada vive en la hora que declara: la ventana se filtra por ese campo.
  const at = partial.startedAt ?? '2026-10-05T10:15:00.000-06:00';
  return {
    kind: 'SELECT',
    type: 'READ',
    outcome: 'OK',
    rows: 1,
    params: '',
    sql: 'SELECT 1 FROM dual',
    startedAt: at,
    startedClock: at.slice(11, 19),
    finishedAt: at,
    durationMs: 100,
    error: '',
    ...partial,
  };
}

/** Sesión escrita con el mismo códec que usa el server, para que el formato no pueda divergir. */
async function writeSession(
  sessionId: string,
  startedAt: string,
  records: AuditRecord[],
  options: { fileName?: string; formatVersion?: string; truncateLast?: boolean } = {},
): Promise<void> {
  const { fileName, formatVersion, truncateLast = false } = options;
  const header = renderSessionHeader({
    server: 'lu-query',
    sessionId,
    startedAt,
    timezone: 'America/Mexico_City',
  });
  const entries = records.map((entry) => renderAuditEntry(entry));
  if (truncateLast) entries[entries.length - 1] = entries[entries.length - 1]!.split('```sql')[0]!;
  const markdown = [header, ...entries]
    .join('\n')
    .replace(/\| format-version \| [^|]* \|/, `| format-version | ${formatVersion ?? '3-md'} |`);
  await writeFile(join(dir, fileName ?? auditFileName(sessionId)), markdown, 'utf8');
}

function run(from: string, to: string) {
  const result = spawnSync(process.execPath, [SCRIPT, dir, from, to], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

/** El script solo imprime la ruta: los agregados van dentro del HTML. */
async function readReport(from: string, to: string) {
  const { status, stdout } = run(from, to);
  expect(status).toBe(0);
  const html = await readFile(stdout, 'utf8');
  const payload = /<script id="lu-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!payload) throw new Error('el HTML no trae el payload de datos');
  return JSON.parse(payload[1]!) as {
    meta: {
      from: string;
      to: string;
      filesRead: number;
      filesUnreadable: number;
      entriesDropped: number;
      unreadable: { file: string; reason: string }[];
      dropped: { file: string; reason: string }[];
    };
    totals: {
      statements: number;
      ok: number;
      errors: number;
      errorRate: number;
      rows: number;
      durationAvgMs: number;
      durationP95Ms: number;
      sessions: number;
      days: number;
    };
    byDay: { label: string; statements: number; errors: number }[];
    byHour: { label: string; statements: number }[];
    byTool: { tool: string; calls: number; errors: number; totalMs: number }[];
    byType: { type: string; statements: number }[];
    errors: { code: string; count: number; sample: string }[];
    slowest: { tool: string; durationMs: number }[];
    sessions: { sessionId: string; statements: number }[];
  };
}

describe('reporte de auditoría', () => {
  beforeEach(async () => {
    await writeSession('20261005T101500.000000000-0600', '2026-10-05T10:15:00.000-06:00', [
      record({
        sequence: 1,
        tool: 'run_query',
        rows: 10,
        durationMs: 100,
        sql: 'SELECT * FROM empleados',
      }),
      record({ sequence: 2, tool: 'count_rows', rows: 1, durationMs: 20 }),
      record({
        sequence: 3,
        tool: 'execute_dml_rollback_first',
        kind: 'UPDATE',
        type: 'WRITE',
        rows: 3,
        durationMs: 50,
      }),
      record({
        sequence: 4,
        tool: 'run_query',
        outcome: 'ERROR',
        rows: -1,
        durationMs: 30,
        error: 'ORA-00904: "X": invalid identifier',
      }),
      record({ sequence: 5, tool: 'count_rows', rows: 1, durationMs: 400 }),
    ]);
    await writeSession('20261006T090000.000000000-0600', '2026-10-06T09:00:00.000-06:00', [
      record({
        sequence: 1,
        tool: 'list_tables',
        rows: 2531,
        durationMs: 341,
        startedAt: '2026-10-06T09:00:00.000-06:00',
        startedClock: '09:00:00',
      }),
    ]);
  });

  it('agrega las sentencias de la ventana sin perder ningún campo del log', async () => {
    const report = await readReport('05/10/2026', '06/10/2026');

    expect(report.meta).toMatchObject({
      from: '05/10/2026',
      to: '06/10/2026',
      filesRead: 2,
      filesUnreadable: 0,
      entriesDropped: 0,
    });
    expect(report.totals).toMatchObject({
      statements: 6,
      ok: 5,
      errors: 1,
      rows: 2546,
      durationAvgMs: 156.8,
      durationP95Ms: 400,
      sessions: 2,
      days: 2,
    });
    expect(report.totals.errorRate).toBe(16.67);
    expect(report.byDay.map((d) => d.label)).toEqual(['05/oct', '06/oct']);
    expect(report.byHour.map((h) => h.label)).toEqual(['09:00', '10:00']);
    expect(report.byTool[0]).toMatchObject({ tool: 'count_rows', calls: 2, totalMs: 420 });
    expect(report.byType).toEqual([
      { type: 'READ', statements: 5 },
      { type: 'WRITE', statements: 1 },
    ]);
    expect(report.errors).toEqual([
      {
        code: 'ORA-00904',
        count: 1,
        sample: 'ORA-00904: "X": invalid identifier',
        tool: 'run_query',
        sql: 'SELECT 1 FROM dual',
      },
    ]);
    expect(report.slowest[0]).toMatchObject({ tool: 'count_rows', durationMs: 400 });
    expect(report.sessions.map((s) => s.statements)).toEqual([5, 1]);
  });

  it('cuenta como error una sentencia sin código ORA y excluye sus filas de -1', async () => {
    await writeSession('20261007T080000.000000000-0600', '2026-10-07T08:00:00.000-06:00', [
      record({
        sequence: 1,
        tool: 'test_connection',
        outcome: 'ERROR',
        rows: -1,
        durationMs: 5,
        startedAt: '2026-10-07T08:00:00.000-06:00',
        error: 'NJS-125: connectString cannot be empty',
      }),
    ]);

    const report = await readReport('07/10/2026', '07/10/2026');

    expect(report.errors).toEqual([
      {
        code: 'sin código ORA',
        count: 1,
        sample: 'NJS-125: connectString cannot be empty',
        tool: 'test_connection',
        sql: 'SELECT 1 FROM dual',
      },
    ]);
    expect(report.totals).toMatchObject({ statements: 1, errors: 1, ok: 0, rows: 0 });
  });

  it('solo agrega las entradas dentro de la ventana', async () => {
    const report = await readReport('06/10/2026', '06/10/2026');

    expect(report.totals).toMatchObject({ statements: 1, sessions: 1, days: 1 });
    expect(report.byTool.map((tool) => tool.tool)).toEqual(['list_tables']);
  });

  it('salta un archivo de otro format-version y lo dice, sin perder el resto', async () => {
    await writeSession(
      '20261007T090000.000000000-0600',
      '2026-10-07T09:00:00.000-06:00',
      [record({ sequence: 1, tool: 'run_query' })],
      { formatVersion: '4-md' },
    );

    const report = await readReport('07/10/2026', '07/10/2026');

    expect(report.meta.filesUnreadable).toBe(1);
    expect(report.meta.unreadable[0]?.reason).toContain('4-md');
    expect(report.totals.statements).toBe(0);
  });

  it('descarta una entrada truncada a media escritura y conserva el resto del archivo', async () => {
    await writeSession(
      '20261008T090000.000000000-0600',
      '2026-10-08T09:00:00.000-06:00',
      [
        record({ sequence: 1, tool: 'run_query', startedAt: '2026-10-08T09:00:00.000-06:00' }),
        record({ sequence: 2, tool: 'count_rows', startedAt: '2026-10-08T09:00:10.000-06:00' }),
      ],
      { truncateLast: true },
    );

    const report = await readReport('08/10/2026', '08/10/2026');

    expect(report.meta.entriesDropped).toBe(1);
    expect(report.meta.dropped[0]?.reason).toContain('#2');
    expect(report.totals.statements).toBe(1);
  });

  it('rechaza ventanas imposibles en vez de recortarlas', () => {
    const tooWide = run('01/01/2026', '17/10/2026');
    expect(tooWide.status).toBe(1);
    expect(tooWide.stderr).toContain('el máximo es 31');

    const inverted = run('06/10/2026', '05/10/2026');
    expect(inverted.status).toBe(1);
    expect(inverted.stderr).toContain('anterior a desde');

    const noLogs = run('01/09/2026', '05/09/2026');
    expect(noLogs.status).toBe(1);
    expect(noLogs.stderr).toContain('no hay sesiones');

    const badFormat = run('2026-10-05', '06/10/2026');
    expect(badFormat.status).toBe(1);
    expect(badFormat.stderr).toContain('dd/mm/aaaa');
  });
  it('falla cuando el directorio no existe', () => {
    const { stdout } = run('05/10/2026', '05/10/2026');

    expect(stdout).toBe(join(dir, 'reports', 'lu-query-05-10-2026_05-10-2026.html'));
    expect(existsSync(stdout)).toBe(true);
  });

  it('falla cuando el directorio no existe', async () => {
    await mkdir(dir, { recursive: true });
    const result = spawnSync(
      process.execPath,
      [SCRIPT, join(dir, 'nope'), '05/10/2026', '06/10/2026'],
      {
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no existe el directorio');
  });
});
