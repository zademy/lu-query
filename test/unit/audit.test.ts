import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listAuditSessions, readAuditSession } from '../../src/audit/audit-reader.js';
import { createFileAuditWriter, type AuditWriter } from '../../src/audit/audit-writer.js';
import { withToolContext } from '../../src/audit/context.js';
import { loadConfig } from '../../src/config.js';
import { FakeDataAccess } from '../../src/db/fake-data-access.js';
import { withAudit, type DataAccess } from '../../src/db/data-access.js';
import { createServer } from '../../src/server.js';
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

describe('hook de auditoría en el chokepoint DataAccess', () => {
  function audited(audit: AuditWriter = createFileAuditWriter({ enabled: true, dir })): DataAccess {
    return withAudit(
      new FakeDataAccess().always(() => ({ rows: [{ ID: 1 }, { ID: 2 }] })),
      audit,
    );
  }

  async function auditFile(): Promise<string> {
    const [file] = await readdir(dir);
    return readFile(join(dir, file!), 'utf8');
  }


  it('deja una entrada por sentencia con tool, kind, type, filas y SQL verbatim', async () => {
    const rows = await withToolContext(
      'run_query',
      { sql: 'SELECT * FROM emp', offset: null, limit: undefined },
      () => audited().queryForList('SELECT * FROM emp'),
    );
    const markdown = await auditFile();

    expect(rows).toHaveLength(2);
    expect(markdown).toMatch(/### #1 · \d\d:\d\d:\d\d · run_query · SELECT · READ · ✅ OK/);
    expect(markdown).toContain('| Filas      | 2 |');
    expect(markdown).toContain('| Parámetros | sql=SELECT * FROM emp, offset=null, limit=null |');
    expect(markdown).toContain('```sql\nSELECT * FROM emp\n```');
    expect(markdown).toMatch(/\| Duración   \| \d+ ms \|/);
  });

  it('el DML cuenta las filas afectadas y el call deja la sentencia BEGIN', async () => {
    const dataAccess = withAudit(
      new FakeDataAccess().always(() => ({ rowCount: 7 })),
      createFileAuditWriter({ enabled: true, dir }),
    );

    await withToolContext('execute_dml', { sql: 'UPDATE emp SET sal = 1' }, () =>
      dataAccess.execute('UPDATE emp SET sal = 1'),
    );
    await dataAccess.call('mi_proc(1)');
    const markdown = await auditFile();

    expect(markdown).toContain('execute_dml · UPDATE · WRITE · ✅ OK');
    expect(markdown).toContain('| Filas      | 7 |');
    expect(markdown).toContain('(unknown) · BEGIN · OTHER · ✅ OK');
    expect(markdown).toContain('```sql\nBEGIN mi_proc(1); END;\n```');
  });

  it('una sentencia fallida deja entrada ❌ con filas -1 y el mensaje, y el error sigue subiendo', async () => {
    const error = Object.assign(new Error('ORA-01017: invalid username/password; logon denied'), {
      code: 'ORA-01017',
    });
    const dataAccess = withAudit(
      new FakeDataAccess().alwaysFail(error),
      createFileAuditWriter({ enabled: true, dir }),
    );

    await expect(
      withToolContext('test_connection', {}, () => dataAccess.queryForObject('SELECT 1 FROM dual')),
    ).rejects.toBe(error);

    const markdown = await auditFile();
    expect(markdown).toMatch(
      /### #1 · \d\d:\d\d:\d\d · test_connection · SELECT · READ · ❌ ERROR/,
    );
    expect(markdown).toContain('| Filas      | -1 |');
    expect(markdown).toContain('```text\nORA-01017: invalid username/password; logon denied\n```');
  });

  it('si la auditoría no puede escribir, la respuesta de la tool no se resiente', async () => {
    const blocker = join(dir, 'bloqueado');
    await writeFile(blocker, 'soy un archivo');
    const writer = createFileAuditWriter({ enabled: true, dir: join(blocker, 'logs') });

    const rows = await withToolContext('run_query', {}, () =>
      withAudit(
        new FakeDataAccess().always(() => ({ rows: [{ ID: 1 }] })),
        writer,
      ).queryForList('SELECT * FROM emp'),
    );

    expect(rows).toHaveLength(1);
    expect(await readdir(dir)).toEqual(['bloqueado']);
  });

  it('apagar MCP_AUDIT_ENABLED deja el chokepoint intacto y sin escribir', async () => {
    const apagada = createFileAuditWriter({ enabled: false, dir });


    await expect(
      withToolContext('run_query', {}, () => audited(apagada).queryForList('SELECT 1 FROM dual')),
    ).resolves.toHaveLength(2);

    expect(await readdir(dir)).toEqual([]);
  });
});

describe('recurso MCP de auditoría', () => {
  /** El contenido puede ser texto o blob; el recurso de auditoría siempre es texto. */
  function textOf(contents: readonly unknown[]): string {
    return String((contents[0] as { text?: string } | undefined)?.text);
  }
  /** Server MCP con el fake: `createServer` lo envuelve con auditoría, como en producción. */
  async function auditedServer(auditDir: string) {
    const config = { ...loadConfig({}), audit: { enabled: true, dir: auditDir } };
    const dataAccess = new FakeDataAccess().always(() => ({
      rows: [{ VERSION: 'Oracle Database 19c' }],
    }));
    const handle = createServer({ config, dataAccess });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'lu-query-audit-test', version: '0.0.0' });
    await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);

    return {
      client,
      sessionId: handle.context.audit.sessionId(),
      close: async () => {
        await client.close();
        await handle.close();
      },
    };
  }

  it('la tool audita su sentencia y el recurso current sirve ese Markdown', async () => {
    const oracle = await auditedServer(dir);

    try {
      await oracle.client.callTool({ name: 'test_connection', arguments: {} });

      const sessionId = oracle.sessionId;
      const { contents } = await oracle.client.readResource({
        uri: `oracle://audit/session/${sessionId}`,
      });
      const text = textOf(contents);

      expect(contents[0]?.mimeType).toBe('text/markdown');
      expect(text).toContain('# Auditoría de lu-query');
      expect(text).toContain(`| session-id     | ${sessionId} |`);
      expect(text).toMatch(/### #1 · \d\d:\d\d:\d\d · test_connection · SELECT · READ · ✅ OK/);
      expect(text).toContain('SYS_CONTEXT');
      expect(text).toBe(await readAuditSession(dir, sessionId));
    } finally {
      await oracle.close();
    }
  });

  it('current resuelve la sesión viva, el listado trae ids reales y el completion los ofrece', async () => {
    const oracle = await auditedServer(dir);

    try {
      await oracle.client.callTool({ name: 'test_connection', arguments: {} });
      const sessionId = oracle.sessionId;

      const current = await oracle.client.readResource({ uri: 'oracle://audit/session/current' });
      expect(textOf(current.contents)).toContain(`| session-id     | ${sessionId} |`);

      const { resources } = await oracle.client.listResources();
      expect(resources.map((resource) => resource.uri)).toEqual([
        `oracle://audit/session/${sessionId}`,
      ]);
      const { resourceTemplates } = await oracle.client.listResourceTemplates();
      expect(resourceTemplates.map((template) => template.uriTemplate)).toContain(
        'oracle://audit/session/{id}',
      );

      const completion = await oracle.client.complete({
        ref: { type: 'ref/resource', uri: 'oracle://audit/session/{id}' },
        argument: { name: 'id', value: sessionId },
      });
      expect(completion.completion.values).toEqual([sessionId]);
      expect(
        (
          await oracle.client.complete({
            ref: { type: 'ref/resource', uri: 'oracle://audit/session/{id}' },
            argument: { name: 'id', value: '' },
          })
        ).completion.values,
      ).toEqual(['current', sessionId]);
    } finally {
      await oracle.close();
    }
  });

  it('una sesión inexistente responde con un mensaje, no con un error de transporte', async () => {
    const oracle = await auditedServer(dir);

    try {
      const missing = await oracle.client.readResource({
        uri: 'oracle://audit/session/20260101T101010.100000000+0000',
      });

      expect(textOf(missing.contents)).toContain('No hay auditoría para la sesión');
    } finally {
      await oracle.close();
    }
  });
});
