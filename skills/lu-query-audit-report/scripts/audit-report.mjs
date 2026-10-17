#!/usr/bin/env node
/**
 * Reporte de auditoría HTML a partir de los archivos Markdown de sesión.
 *
 * No habla con la base de datos: solo lee los .md que el server ya escribió.
 * Node sin dependencias, a propósito: la skill se copia sola a la máquina del
 * agente y no puede depender de que haya otro runtime instalado.
 *
 *   node audit-report.mjs <auditDir> <dd/mm/aaaa> <dd/mm/aaaa>
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const TEMPLATE = new URL('../references/template.html', import.meta.url);
const FORMAT_VERSION = '3-md';
const AUDIT_FILE = /^lu-query-(\d{8})T\d{6}\.\d+[+-]\d{4}(?:-\d+)?-log\.md$/;
const ENTRY_HEADER = /^#(\d+) · (\d{2}:\d{2}:\d{2}) · (\S+) · (\S+) · (\S+) · (✅ OK|❌ ERROR)$/;
const TABLE_ROW = /^\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|$/;
const SQL_FENCE = /```sql\n([\s\S]*?)```/;
const TEXT_FENCE = /```text\n([\s\S]*?)```/;
const MAX_DAYS = 31;
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** Falla con un mensaje que dice qué hacer, no solo qué pasó. */
class ReportError extends Error {}

const key = (date) => date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();

const formatKey = (dayKey) =>
  `${String(dayKey % 100).padStart(2, '0')}/${String(Math.floor(dayKey / 100) % 100).padStart(2, '0')}/${Math.floor(dayKey / 10000)}`;

function parseDate(text, label) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text ?? '');
  if (!match) throw new ReportError(`${label} no es una fecha dd/mm/aaaa: "${text ?? ''}"`);
  const [, dd, mm, yyyy] = match.map(Number);
  const date = new Date(yyyy, mm - 1, dd);
  if (date.getFullYear() !== yyyy || date.getMonth() !== mm - 1 || date.getDate() !== dd) {
    throw new ReportError(`${label} no existe en el calendario: "${text}"`);
  }
  return date;
}

/** El día que el propio log declara, sin convertir de zona: 2026-10-17T23:59-0600 es del 17. */
const dayOf = (isoTimestamp) => {
  const [date] = isoTimestamp.split('T');
  const [yyyy, mm, dd] = date.split('-').map(Number);
  return yyyy * 10000 + mm * 100 + dd;
};

const hourOf = (isoTimestamp) => Number(isoTimestamp.slice(11, 13));

function headerField(markdown, label) {
  const match = new RegExp(`^\\|\\s*${label}\\s*\\|\\s*([^|]*?)\\s*\\|$`, 'm').exec(markdown);
  return match?.[1];
}

/** Una sesión, o el motivo por el que no se pudo leer. */
function readSession(name, markdown) {
  const formatVersion = headerField(markdown, 'format-version');
  if (!formatVersion) return { skipped: 'sin cabecera de sesión' };
  if (formatVersion !== FORMAT_VERSION) {
    return { skipped: `format-version ${formatVersion}; esta skill lee ${FORMAT_VERSION}` };
  }

  const entries = [];
  const dropped = [];
  for (const block of markdown.split(/^### /m).slice(1)) {
    const newline = block.indexOf('\n');
    const header = ENTRY_HEADER.exec(block.slice(0, newline));
    if (!header) {
      dropped.push('bloque sin cabecera reconocible');
      continue;
    }
    const [, sequence, clock, tool, entryKind, entryType, state] = header;
    const body = block.slice(newline + 1);

    const fields = {};
    for (const line of body.split('\n')) {
      if (!line.startsWith('|')) break;
      const row = TABLE_ROW.exec(line);
      if (row) fields[row[1]] = row[2];
    }

    const sql = SQL_FENCE.exec(body)?.[1];
    // Sin su bloque sql la entrada quedó a medias: el proceso murió al vaciar el búfer.
    if (!sql || !fields.Inicio || fields.Duración === undefined || fields.Filas === undefined) {
      dropped.push(`entrada #${sequence} incompleta`);
      continue;
    }

    entries.push({
      sequence: Number(sequence),
      clock,
      tool,
      kind: entryKind,
      type: entryType,
      error: state === '❌ ERROR',
      startedAt: fields.Inicio,
      durationMs: Number.parseInt(fields.Duración, 10),
      rows: Number.parseInt(fields.Filas, 10),
      params: fields['Parámetros'] ?? '',
      sql: sql.trimEnd(),
      message: TEXT_FENCE.exec(body)?.[1]?.trimEnd() ?? '',
    });
  }

  return {
    session: {
      sessionId: headerField(markdown, 'session-id') ?? basename(name, '-log.md'),
      startedAt: headerField(markdown, 'started-at') ?? '',
      timezone: headerField(markdown, 'timezone') ?? '',
      file: name,
    },
    entries,
    dropped,
  };
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

const round = (value, digits = 1) => Number(value.toFixed(digits));

function bump(map, name, create) {
  const found = map.get(name);
  if (found) return found;
  const created = create();
  map.set(name, created);
  return created;
}

function aggregate(entries, sessions, meta) {
  const durations = [];
  let rows = 0;
  let durationTotalMs = 0;
  const byDay = new Map();
  const byHour = new Map();
  const byTool = new Map();
  const byType = new Map();
  const errorCodes = new Map();

  for (const entry of entries) {
    durations.push(entry.durationMs);
    durationTotalMs += entry.durationMs;
    if (entry.rows > 0) rows += entry.rows;

    const day = dayOf(entry.startedAt);
    const dayRow = bump(byDay, day, () => ({
      date: day,
      label: `${String(day % 100).padStart(2, '0')}/${MONTHS[(Math.floor(day / 100) % 100) - 1]}`,
      statements: 0,
      errors: 0,
      durationMs: 0,
    }));
    dayRow.statements += 1;
    dayRow.durationMs += entry.durationMs;
    if (entry.error) dayRow.errors += 1;

    const hour = hourOf(entry.startedAt);
    const hourRow = bump(byHour, hour, () => ({
      hour,
      label: `${String(hour).padStart(2, '0')}:00`,
      statements: 0,
      errors: 0,
    }));
    hourRow.statements += 1;
    if (entry.error) hourRow.errors += 1;

    const toolRow = bump(byTool, entry.tool, () => ({
      tool: entry.tool,
      calls: 0,
      errors: 0,
      totalMs: 0,
      maxMs: 0,
    }));
    toolRow.calls += 1;
    toolRow.totalMs += entry.durationMs;
    toolRow.maxMs = Math.max(toolRow.maxMs, entry.durationMs);
    if (entry.error) toolRow.errors += 1;

    byType.set(entry.type, (byType.get(entry.type) ?? 0) + 1);

    if (entry.error) {
      const code = /ORA-\d{5}/.exec(entry.message)?.[0] ?? 'sin código ORA';
      bump(errorCodes, code, () => ({
        code,
        count: 0,
        sample: entry.message,
        tool: entry.tool,
        sql: entry.sql,
      }));
      errorCodes.get(code).count += 1;
    }
  }

  const errors = entries.filter((entry) => entry.error).length;

  return {
    meta,
    totals: {
      statements: entries.length,
      errors,
      ok: entries.length - errors,
      errorRate: entries.length === 0 ? 0 : round((errors / entries.length) * 100, 2),
      rows,
      durationTotalMs,
      durationAvgMs: entries.length === 0 ? 0 : round(durationTotalMs / entries.length, 1),
      durationP95Ms: percentile(durations, 0.95),
      sessions: sessions.length,
      days: byDay.size,
    },
    byDay: [...byDay.values()].sort((a, b) => a.date - b.date),
    byHour: [...byHour.values()].sort((a, b) => a.hour - b.hour),
    byTool: [...byTool.values()].sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool)),
    byType: ['READ', 'WRITE', 'OTHER']
      .filter((type) => byType.has(type))
      .map((type) => ({ type, statements: byType.get(type) })),
    errors: [...errorCodes.values()].sort(
      (a, b) => b.count - a.count || a.code.localeCompare(b.code),
    ),
    slowest: [...entries]
      .sort((a, b) => b.durationMs - a.durationMs || a.sequence - b.sequence)
      .slice(0, 10)
      .map((entry) => ({
        startedAt: entry.startedAt,
        tool: entry.tool,
        kind: entry.kind,
        type: entry.type,
        durationMs: entry.durationMs,
        rows: entry.rows,
        sql: entry.sql,
      })),
    sessions,
  };
}

function renderHtml(report) {
  const template = readFileSync(TEMPLATE, 'utf8');
  // Un </script> dentro del payload cerraría el tag antes de tiempo.
  const payload = JSON.stringify(report).replace(/</g, '\\u003c');
  return template.replace(
    '<!--lu-data-->',
    `<script id="lu-data" type="application/json">${payload}</script>`,
  );
}

const dayOfFile = (name) => Number(AUDIT_FILE.exec(name)[1]);

async function buildReport(dir, from, to) {
  const fromKey = key(from);
  const toKey = key(to);
  const windowDays = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  if (windowDays > MAX_DAYS) {
    throw new ReportError(
      `la ventana cubre ${windowDays} días y el máximo es ${MAX_DAYS}: pide la auditoría por tramos más cortos`,
    );
  }

  const names = (await readdir(dir)).filter((name) => AUDIT_FILE.test(name)).sort();
  if (names.length === 0) {
    throw new ReportError(`${dir} no tiene archivos de auditoría de sesión`);
  }

  // Una sesión que empieza la noche antes puede tener entradas pasada la medianoche.
  const spillKey = key(new Date(from.getFullYear(), from.getMonth(), from.getDate() - 1));
  const inWindow = names.filter((name) => {
    const day = dayOfFile(name);
    return day >= spillKey && day <= toKey;
  });
  if (inWindow.length === 0) {
    const near = [...names]
      .sort((a, b) => Math.abs(dayOfFile(a) - fromKey) - Math.abs(dayOfFile(b) - fromKey))
      .slice(0, 3)
      .map((name) => name);
    throw new ReportError(
      `no hay sesiones del ${formatKey(fromKey)} al ${formatKey(toKey)} (${windowDays} días); los archivos más cercanos: ${near.join(', ')}`,
    );
  }

  const entries = [];
  const sessions = [];
  const unreadable = [];
  const dropped = [];
  for (const name of inWindow) {
    const read = readSession(name, await readFile(join(dir, name), 'utf8'));
    if (read.skipped) {
      unreadable.push({ file: name, reason: read.skipped });
      continue;
    }
    const mine = read.entries.filter((entry) => {
      const day = dayOf(entry.startedAt);
      return day >= fromKey && day <= toKey;
    });
    for (const note of read.dropped) dropped.push({ file: name, reason: note });
    if (mine.length === 0) continue;
    entries.push(...mine);
    sessions.push({
      ...read.session,
      statements: mine.length,
      errors: mine.filter((entry) => entry.error).length,
      durationMs: mine.reduce((total, entry) => total + entry.durationMs, 0),
    });
  }

  if (unreadable.length === inWindow.length) {
    const reasons = unreadable.map((s) => `${s.file}: ${s.reason}`).join('; ');
    throw new ReportError(`ningún archivo de la ventana se pudo leer (${reasons})`);
  }

  return aggregate(entries, sessions, {
    from: formatKey(fromKey),
    to: formatKey(toKey),
    auditDir: dir,
    formatVersion: FORMAT_VERSION,
    filesRead: inWindow.length - unreadable.length,
    filesUnreadable: unreadable.length,
    entriesDropped: dropped.length,
    unreadable,
    dropped,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    generatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
  });
}

async function main(argv) {
  const [dirArg, fromArg, toArg] = argv;
  if (!dirArg || !fromArg || !toArg) {
    throw new ReportError(
      'uso: node audit-report.mjs <auditDir> <dd/mm/aaaa> <dd/mm/aaaa>\n' +
        '  auditDir  la carpeta MCP_AUDIT_DIR con los lu-query-<sesión>-log.md',
    );
  }

  const dir = resolve(dirArg);
  if (!existsSync(dir)) {
    const configured = process.env.MCP_AUDIT_DIR;
    throw new ReportError(
      `no existe el directorio ${dir}${configured ? `; MCP_AUDIT_DIR apunta a ${configured}` : ''}`,
    );
  }

  const from = parseDate(fromArg, 'desde');
  const to = parseDate(toArg, 'hasta');
  if (key(to) < key(from)) {
    throw new ReportError(`hasta (${toArg}) es anterior a desde (${fromArg})`);
  }

  const report = await buildReport(dir, from, to);
  const window = `${fromArg.replaceAll('/', '-')}_${toArg.replaceAll('/', '-')}`;
  const target = join(dir, 'reports', `lu-query-${window}.html`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, renderHtml(report), 'utf8');
  process.stdout.write(`${target}\n`);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof ReportError ? error.message : error);
  process.exitCode = 1;
}
