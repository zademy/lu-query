/**
 * Codec del formato de auditoría Markdown `3-md`: un archivo por sesión con una
 * entrada legible por sentencia SQL. Es el equivalente del `AuditLogCodec` del
 * Java (que escribía TXT v2 + JSONL); aquí no hay JSON en ningún sitio porque el
 * formato aprobado en diseño es una tabla Markdown por entrada.
 */

/** Nombre del server en el nombre de archivo; espeja `SERVER_NAME` de server.ts. */
export const AUDIT_SERVER = 'lu-query';

/** Versión de formato declarada en el header de cada archivo. */
export const AUDIT_FORMAT_VERSION = '3-md';

/** Clasificación de la sentencia que decide READ/WRITE/OTHER (SqlKindSniffer del Java). */
export type SqlAuditType = 'READ' | 'WRITE' | 'OTHER';

/** Una entrada de auditoría: exactamente los campos del `AuditLogRecord` del Java. */
export interface AuditRecord {
  /** Secuencia monotónica dentro de la sesión, desde 1. */
  sequence: number;
  /** Tool que originó la sentencia (`(unknown)` sin contexto, como el Java). */
  tool: string;
  /** Primer token del SQL en mayúsculas (`SELECT`, `BEGIN`, ...). */
  kind: string;
  type: SqlAuditType;
  outcome: 'OK' | 'ERROR';
  /** Filas leídas o afectadas; `-1` cuando no se puede derivar. */
  rows: number;
  /** Parámetros de la tool ya formateados: `name=value, name2=value2`. */
  params: string;
  /** SQL verbatim tal cual llegó a Oracle. */
  sql: string;
  /** ISO-8601 con offset local, p. ej. `2026-10-17T14:32:07.123-06:00`. */
  startedAt: string;
  /** Hora local `HH:mm:ss` de arranque, la que va en la cabecera de la entrada. */
  startedClock: string;
  finishedAt: string;
  durationMs: number;
  /** Mensaje del error (`ORA-01017: ...`); vacío si `outcome` es `OK`. */
  error: string;
}

export interface AuditHeader {
  server: string;
  sessionId: string;
  startedAt: string;
  timezone: string;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function offsetText(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  return `${sign}${pad(Math.floor(Math.abs(minutes) / 60))}${pad(Math.abs(minutes) % 60)}`;
}

/** ISO-8601 con el offset local del proceso (Java usaba `OffsetDateTime`). */
export function isoWithOffset(date: Date): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${day}T${time}.${pad(date.getMilliseconds(), 3)}${offsetText(date)}`;
}

/** Hora local `HH:mm:ss` de la entrada. */
export function localClock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Id de sesión: `yyyyMMdd'T'HHmmss.SSSSSSSSS±HHmm` como en el Java. Node solo
 * da milisegundos, así que la fracción se rellena con ceros hasta 9 dígitos.
 */
export function sessionTimestamp(date: Date): string {
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${day}${time}.${pad(date.getMilliseconds(), 3)}000000${offsetText(date)}`;
}

/** Nombre del archivo de una sesión: `<server>-<session-id>-log.md`. */
export function auditFileName(sessionId: string): string {
  return `${AUDIT_SERVER}-${sessionId}-log.md`;
}

/** Kind = primer token del SQL en mayúsculas; `OTHER` si no hay ninguno. */
export function sqlAuditKind(sql: string): string {
  return /^\s*(\w+)/.exec(sql)?.[1]?.toUpperCase() ?? 'OTHER';
}

/** Type a partir del kind: SELECT/WITH→READ, INSERT/UPDATE/DELETE/MERGE/COMMENT→WRITE. */
export function sqlAuditType(kind: string): SqlAuditType {
  if (kind === 'SELECT' || kind === 'WITH') return 'READ';
  if (['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COMMENT'].includes(kind)) return 'WRITE';
  return 'OTHER';
}

/** Escapa lo que rompería la celda de una tabla Markdown. */
function cell(text: string): string {
  return text.replaceAll('|', '\\|').replace(/\s*\n\s*/g, ' ');
}

/** Header del archivo: identidad de la sesión y versión del formato. */
export function renderSessionHeader(header: AuditHeader): string {
  return [
    '# Auditoría de lu-query',
    '',
    '| Campo          | Valor |',
    '|----------------|-------|',
    `| server         | ${cell(header.server)} |`,
    `| session-id     | ${cell(header.sessionId)} |`,
    `| started-at     | ${cell(header.startedAt)} |`,
    `| timezone       | ${cell(header.timezone)} |`,
    `| format-version | ${AUDIT_FORMAT_VERSION} |`,
    '',
  ].join('\n');
}

/** Una entrada por sentencia SQL, tal como la aprobó el equipo. */
export function renderAuditEntry(record: AuditRecord): string {
  const state = record.outcome === 'ERROR' ? '❌ ERROR' : '✅ OK';
  return [
    `### #${record.sequence} · ${record.startedClock} · ${record.tool} · ${record.kind} · ${record.type} · ${state}`,
    '| Campo      | Valor |',
    '|------------|-------|',
    `| Inicio     | ${record.startedAt} |`,
    `| Fin        | ${record.finishedAt} |`,
    `| Duración   | ${record.durationMs} ms |`,
    `| Filas      | ${record.rows} |`,
    `| Parámetros | ${cell(record.params)} |`,
    '',
    '```sql',
    record.sql,
    '```',
    ...(record.error ? ['', '```text', record.error, '```'] : []),
    '',
  ].join('\n');
}

/**
 * Mensaje de error para el bloque ❌. node-oracledb ya repite el código en el
 * mensaje, así que se quita para no escribirlo dos veces: `ORA-01017: msg`.
 */
export function describeAuditError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code !== '') {
    const detail = message
      .split(code)
      .join('')
      .replace(/^[\s:]+|[\s:]+$/g, '');
    return `${code}: ${detail || '(sin mensaje)'}`;
  }
  const name = error instanceof Error ? error.name : typeof error;
  return `${name}: ${message || '(sin mensaje)'}`;
}
