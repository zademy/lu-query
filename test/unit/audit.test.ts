import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  completeAuditEntry,
  createAuditEntry,
  newAuditSessionId,
} from '../../src/audit/context.js';
import { renderAuditMarkdown } from '../../src/audit/markdown.js';
import { createFileAuditWriter } from '../../src/audit/audit-writer.js';
import { listAuditSessions, readAuditSession } from '../../src/audit/audit-reader.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lu-query-audit-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('audit entry', () => {
  it('genera un id de sesión y cierra la entrada con su desenlace', () => {
    const entry = createAuditEntry(newAuditSessionId(), 'test_connection', { schema: 'HR' });
    const done = completeAuditEntry(entry, 'ok', 'conectado');

    expect(entry.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.outcome).toBe('pending');
    expect(done.tool).toBe('test_connection');
    expect(done.arguments).toEqual({ schema: 'HR' });
    expect(done.outcome).toBe('ok');
    expect(done.detail).toBe('conectado');
    expect(done.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('renderAuditMarkdown', () => {
  it('deja la operación legible en Markdown', () => {
    const markdown = renderAuditMarkdown(
      completeAuditEntry(
        createAuditEntry('sesion-1', 'run_query', { sql: 'SELECT 1 FROM dual', max_rows: 10 }),
        'ok',
        '1 fila',
      ),
    );

    expect(markdown).toContain('run_query');
    expect(markdown).toContain('"sql":"SELECT 1 FROM dual"');
    expect(markdown).toContain('1 fila');
  });
});

describe('file audit writer/reader', () => {
  it('escribe un .md por sesión y lo vuelve a leer', async () => {
    const writer = createFileAuditWriter(dir);
    const sessionId = newAuditSessionId();

    await writer.write(
      completeAuditEntry(createAuditEntry(sessionId, 'list_tables', {}), 'ok', '3 tablas'),
    );
    await writer.write(
      completeAuditEntry(
        createAuditEntry(sessionId, 'describe_table', { table: 'T' }),
        'error',
        'ORA-00942',
      ),
    );

    expect(await listAuditSessions(dir)).toEqual([sessionId]);
    const markdown = await readAuditSession(dir, sessionId);
    expect(markdown).toContain('# lu-query audit — ' + sessionId);
    expect(markdown).toContain('list_tables');
    expect(markdown).toContain('describe_table');
    expect(markdown).toContain('ORA-00942');
  });

  it('devuelve undefined si la sesión no existe', async () => {
    expect(await readAuditSession(dir, 'nope')).toBeUndefined();
  });

  it('lista solo sesiones .md', async () => {
    await writeFile(join(dir, 'notas.txt'), 'ignorado');

    expect(await listAuditSessions(dir)).toEqual([]);
  });
});
