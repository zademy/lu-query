import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { currentToolContext } from './context.js';
import {
  AUDIT_SERVER,
  auditFileName,
  describeAuditError,
  isoWithOffset,
  localClock,
  renderAuditEntry,
  renderSessionHeader,
  sessionTimestamp,
  sqlAuditKind,
  sqlAuditType,
  type AuditRecord,
} from './markdown.js';

/** Escritor de entradas de una sesión: un `.md` por sesión, como en el Java. */
export interface AuditWriter {
  /** Añade una entrada post-ejecución y la deja en disco. Nunca lanza. */
  write(record: AuditRecord): Promise<void>;
  /** Id de la sesión viva; ya con sufijo si hubo colisión de nombre. */
  sessionId(): string;
  /** Espera a que terminen las escrituras en vuelo (flush al apagar). */
  drain(): Promise<void>;
  /** `true` si la auditoría está apagada: por opt-out o por error de I/O. */
  readonly disabled: boolean;
}

export interface FileAuditWriterOptions {
  dir: string;
  /** Inicio de la sesión; por defecto ahora (el archivo se crea en la 1ª entrada). */
  startedAt?: Date;
  /** `false` = `MCP_AUDIT_ENABLED=false`: no escribe nada. */
  enabled?: boolean;
}

function suffix(n: number): string {
  return String(n).padStart(3, '0');
}

function isTaken(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST';
}

/**
 * Escribe un `.md` por sesión: header en la primera entrada, append y flush en
 * cada una, y ante el primer error de I/O se deshabilita sin propagar nada
 * (el Java hacía lo mismo con su `disable`).
 */
export function createFileAuditWriter(options: FileAuditWriterOptions): AuditWriter {
  const { dir, enabled = true } = options;
  const startedAt = options.startedAt ?? new Date();
  const baseId = sessionTimestamp(startedAt);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  let sequence = 0;
  let resolvedId = baseId;
  let file: string | undefined;
  let disabled = !enabled;
  let queue: Promise<void> = Promise.resolve();

  const disable = (error: unknown): void => {
    if (disabled) return;
    disabled = true;
    const message = error instanceof Error ? error.message : String(error);
    // stdout es del JSON-RPC: el aviso de auditoría va a stderr.
    console.warn(`lu-query: auditoría desactivada para el resto de la sesión (${message})`);
  };

  async function create(record: AuditRecord): Promise<void> {
    await mkdir(dir, { recursive: true });
    const entry = renderAuditEntry(record);
    for (let n = 0; n < 1000; n += 1) {
      const sessionId = n === 0 ? baseId : `${baseId}-${suffix(n)}`;
      const path = join(dir, auditFileName(sessionId));
      const header = renderSessionHeader({
        server: AUDIT_SERVER,
        sessionId,
        startedAt: isoWithOffset(startedAt),
        timezone,
      });
      try {
        // `wx` = crear o fallar: así la colisión se resuelve sin Carrera.
        await writeFile(path, `${header}\n${entry}`, { encoding: 'utf8', flag: 'wx' });
        resolvedId = sessionId;
        file = path;
        return;
      } catch (error) {
        if (!isTaken(error)) throw error;
      }
    }
    throw new Error(`no quedó un nombre libre para la sesión ${baseId}`);
  }

  async function append(record: AuditRecord): Promise<void> {
    try {
      if (disabled) return;
      if (file === undefined) {
        await create(record);
        return;
      }
      await appendFile(file, `\n${renderAuditEntry(record)}`, 'utf8');
    } catch (error) {
      disable(error);
    }
  }

  return {
    write(record) {
      sequence += 1;
      // Cola serial: dos sentencias concurrentes no se pisan en el archivo.
      const next = queue.then(() => append({ ...record, sequence }));
      queue = next.catch(() => undefined);
      return next;
    },
    sessionId: () => resolvedId,
    drain: () => queue,
    get disabled() {
      return disabled;
    },
  };
}


/**
 * Envuelve una sentencia del chokepoint DataAccess: cronometra, ejecuta y deja
 * la entrada POST-ejecución con las filas derivadas (o `-1` si falló).
 */
export async function auditStatement<T>(
  audit: AuditWriter,
  sql: string,
  run: () => Promise<T>,
  rowsOf: (value: T) => number,
): Promise<T> {
  const startedAt = new Date();
  const tool = currentToolContext();
  const kind = sqlAuditKind(sql);
  const common = {
    tool: tool?.tool ?? '(unknown)',
    params: tool?.params ?? '',
    kind,
    type: sqlAuditType(kind),
    sql,
    startedAt: isoWithOffset(startedAt),
    startedClock: localClock(startedAt),
    sequence: 0,
  };

  let value: T;
  try {
    value = await run();
  } catch (error) {
    const finishedAt = new Date();
    await audit.write({
      ...common,
      outcome: 'ERROR',
      rows: -1,
      finishedAt: isoWithOffset(finishedAt),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      error: describeAuditError(error),
    });
    throw error;
  }

  const finishedAt = new Date();
  await audit.write({
    ...common,
    outcome: 'OK',
    rows: rowsOf(value),
    finishedAt: isoWithOffset(finishedAt),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    error: '',
  });
  return value;
}
