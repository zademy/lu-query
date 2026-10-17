import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listAuditSessions, readAuditSession } from '../../src/audit/audit-reader.js';
import { createFileAuditWriter } from '../../src/audit/audit-writer.js';
import {
  auditFileName,
  renderAuditEntry,
  renderSessionHeader,
  sessionTimestamp,
  sqlAuditKind,
  sqlAuditType,
  type AuditRecord,
} from '../../src/audit/markdown.js';

/** Registro con los mismos valores que la entrada aprobada en diseño del issue #4. */
const APPROVED: AuditRecord = {
  sequence: 12,
  tool: 'run_query',
  kind: 'SELECT',
  type: 'READ',
  outcome: 'OK',
  rows: 42,
  params: 'sql=SELECT * FROM emp, offset=null, limit=null',
  sql: 'SELECT * FROM emp',
  startedAt: '2026-10-17T14:32:07.123-06:00',
  startedClock: '14:32:07',
  finishedAt: '2026-10-17T14:32:07.253-06:00',
  durationMs: 130,
  error: '',
};

describe('renderAuditEntry', () => {
  it('renderiza la entrada aprobada en diseño, línea a línea', () => {
    expect(renderAuditEntry(APPROVED)).toBe(
      [
        '### #12 · 14:32:07 · run_query · SELECT · READ · ✅ OK',
        '| Campo      | Valor |',
        '|------------|-------|',
        '| Inicio     | 2026-10-17T14:32:07.123-06:00 |',
        '| Fin        | 2026-10-17T14:32:07.253-06:00 |',
        '| Duración   | 130 ms |',
        '| Filas      | 42 |',
        '| Parámetros | sql=SELECT * FROM emp, offset=null, limit=null |',
        '',
        '```sql',
        'SELECT * FROM emp',
        '```',
        '',
      ].join('\n'),
    );
  });

  it('la entrada de error cambia el estado y añade el bloque del mensaje', () => {
    const markdown = renderAuditEntry({
      ...APPROVED,
      outcome: 'ERROR',
      rows: -1,
      durationMs: 12,
      error: 'ORA-01017: invalid username/password',
    });

    expect(markdown).toContain('### #12 · 14:32:07 · run_query · SELECT · READ · ❌ ERROR');
    expect(markdown).toContain('| Filas      | -1 |');
    expect(markdown).toContain('| Duración   | 12 ms |');
    expect(markdown).toContain('```text\nORA-01017: invalid username/password\n```');
    expect(markdown).not.toContain('✅');
  });
});

describe('renderSessionHeader', () => {
  it('declara server, session-id, started-at, timezone y format-version 3-md', () => {
    expect(
      renderSessionHeader({
        server: 'lu-query',
        sessionId: '20261017T143207.123000000-0600',
        startedAt: '2026-10-17T14:32:07.123-06:00',
        timezone: 'America/Mexico_City',
      }),
    ).toBe(
      [
        '# Auditoría de lu-query',
        '',
        '| Campo          | Valor |',
        '|----------------|-------|',
        '| server         | lu-query |',
        '| session-id     | 20261017T143207.123000000-0600 |',
        '| started-at     | 2026-10-17T14:32:07.123-06:00 |',
        '| timezone       | America/Mexico_City |',
        '| format-version | 3-md |',
        '',
      ].join('\n'),
    );
  });
});

describe('naming de sesión', () => {
  it('el id es el timestamp local con offset y el archivo lo envuelve en el nombre del server', () => {
    const timestamp = sessionTimestamp(new Date(2026, 9, 17, 14, 32, 7, 123));

    expect(timestamp.startsWith('20261017T143207.123000000')).toBe(true);
    expect(timestamp).toMatch(/[+-]\d{4}$/);
    expect(auditFileName(timestamp)).toBe(`lu-query-${timestamp}-log.md`);
  });
});

describe('sniff de kind y type', () => {
  it('kind es el primer token en mayúsculas y type lo clasifica', () => {
    expect(sqlAuditKind('  select 1 from dual')).toBe('SELECT');
    expect(sqlAuditKind('   ')).toBe('OTHER');
    expect(sqlAuditType('SELECT')).toBe('READ');
    expect(sqlAuditType('WITH')).toBe('READ');
    expect(sqlAuditType('INSERT')).toBe('WRITE');
    expect(sqlAuditType('UPDATE')).toBe('WRITE');
    expect(sqlAuditType('DELETE')).toBe('WRITE');
    expect(sqlAuditType('MERGE')).toBe('WRITE');
    expect(sqlAuditType('COMMENT')).toBe('WRITE');
    expect(sqlAuditType('CREATE')).toBe('OTHER');
  });
});

const STARTED_AT = new Date(2026, 9, 17, 14, 32, 7, 123);
const SESSION_ID = sessionTimestamp(STARTED_AT);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lu-query-audit-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function record(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return { ...APPROVED, sequence: 0, ...overrides };
}

describe('createFileAuditWriter', () => {
  it('no crea nada hasta la primera entrada', async () => {
    const logs = join(dir, 'logs');
    const writer = createFileAuditWriter({ dir: logs, startedAt: STARTED_AT });

    expect(existsSync(logs)).toBe(false);

    await writer.write(record());

    expect(await readdir(logs)).toEqual([auditFileName(SESSION_ID)]);
  });

  it('escribe header y entradas en un único archivo, con secuencia creciente', async () => {
    const writer = createFileAuditWriter({ dir, startedAt: STARTED_AT });

    await writer.write(record({ tool: 'test_connection' }));
    await writer.write(record({ tool: 'list_tables' }));

    const markdown = await readFile(join(dir, auditFileName(SESSION_ID)), 'utf8');
    expect(markdown.startsWith('# Auditoría de lu-query\n')).toBe(true);
    expect(markdown).toContain(`| session-id     | ${SESSION_ID} |`);
    expect(markdown).toContain('| format-version | 3-md |');
    expect(markdown.match(/^### /gm)).toHaveLength(2);
    expect(markdown).toContain('### #1 · 14:32:07 · test_connection');
    expect(markdown).toContain('### #2 · 14:32:07 · list_tables');
  });

  it('con dos sesiones del mismo instante, la segunda lleva sufijo y su propio session-id', async () => {
    const first = createFileAuditWriter({ dir, startedAt: STARTED_AT });
    const second = createFileAuditWriter({ dir, startedAt: STARTED_AT });

    await first.write(record());
    await second.write(record());

    const files = (await readdir(dir)).sort();
    expect(files).toEqual([auditFileName(`${SESSION_ID}-001`), auditFileName(SESSION_ID)]);
    expect(second.sessionId()).toBe(`${SESSION_ID}-001`);
    expect(await readFile(join(dir, files[0]!), 'utf8')).toContain(
      `| session-id     | ${SESSION_ID}-001 |`,
    );
    expect(await readFile(join(dir, files[1]!), 'utf8')).toContain(
      `| session-id     | ${SESSION_ID} |`,
    );
  });

  it('se deshabilita ante un error de I/O y no lo propaga', async () => {
    // Un archivo donde debería ir el directorio: mkdir falla con ENOTDIR.
    const blocker = join(dir, 'bloqueado');
    await writeFile(blocker, 'soy un archivo');
    const writer = createFileAuditWriter({ dir: join(blocker, 'logs'), startedAt: STARTED_AT });

    await expect(writer.write(record())).resolves.toBeUndefined();
    await expect(writer.write(record())).resolves.toBeUndefined();

    expect(writer.disabled).toBe(true);
    expect(existsSync(join(blocker, 'logs'))).toBe(false);
  });

  it('con enabled=false no escribe nada', async () => {
    const writer = createFileAuditWriter({ dir, startedAt: STARTED_AT, enabled: false });

    await writer.write(record());

    expect(writer.disabled).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });

  it('serializa escrituras concurrentes en el mismo archivo', async () => {
    const writer = createFileAuditWriter({ dir, startedAt: STARTED_AT });

    await Promise.all([
      writer.write(record({ tool: 'a' })),
      writer.write(record({ tool: 'b' })),
      writer.write(record({ tool: 'c' })),
    ]);

    const markdown = await readFile(join(dir, auditFileName(SESSION_ID)), 'utf8');
    expect(markdown.match(/^### /gm)).toHaveLength(3);
    expect(markdown).toContain('### #3 · 14:32:07 · c');
  });
});

describe('audit reader', () => {
  async function writeSession(id: string, markdown: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, auditFileName(id)), markdown, 'utf8');
  }

  it('lista los ids reales de sesión y descarta lo que no es un log', async () => {
    await writeSession('20260101T101010.100000000+0000', 'a');
    await writeSession('20260101T101010.100000000+0000-002', 'b');
    await writeSession('20260101T101010.100000000-0600', 'c');
    await writeFile(join(dir, 'notas.md'), 'ignorado');
    await writeFile(join(dir, 'lu-query-20260101T1010.100-0600-log.md'), 'formato viejo');

    expect(await listAuditSessions(dir)).toEqual([
      '20260101T101010.100000000+0000',
      '20260101T101010.100000000+0000-002',
      '20260101T101010.100000000-0600',
    ]);
  });

  it('devuelve el Markdown crudo de la sesión y undefined si no existe', async () => {
    await writeSession(SESSION_ID, renderAuditEntry(record()));

    expect(await readAuditSession(dir, SESSION_ID)).toContain('| Parámetros |');
    expect(await readAuditSession(dir, '20260101T101010.100000000+0000')).toBeUndefined();
  });

  it('tolera un archivo truncado a media entrada', async () => {
    const truncated = `${renderAuditEntry(record())}${renderAuditEntry(record()).slice(0, 40)}`;
    await writeSession(SESSION_ID, truncated);

    expect(await readAuditSession(dir, SESSION_ID)).toBe(truncated);
  });

  it('no acepta ids que no son sesiones de auditoría', async () => {
    await writeFile(join(dir, 'passwd'), 'root:x:0:0');

    expect(await readAuditSession(dir, '../passwd')).toBeUndefined();
    expect(await readAuditSession(dir, 'current')).toBeUndefined();
    expect(await listAuditSessions(dir)).toEqual([]);
  });
});
