import { appendFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditEntry } from './context.js';
import { auditFileName, renderAuditMarkdown, renderSessionHeader } from './markdown.js';

/** Chokepoint de escritura de auditoría (#4 lo flesh-out con el hook de tools). */
export interface AuditWriter {
  write(entry: AuditEntry): Promise<void>;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Escribe un .md por sesión, añadiendo cada operación al final. */
export function createFileAuditWriter(dir: string): AuditWriter {
  return {
    async write(entry) {
      await mkdir(dir, { recursive: true });
      const file = join(dir, auditFileName(entry.sessionId));
      const header = (await exists(file)) ? '' : renderSessionHeader(entry.sessionId);
      await appendFile(file, header + renderAuditMarkdown(entry), 'utf8');
    },
  };
}

/** No hace nada: se usa cuando MCP_AUDIT_ENABLED=false. */
export function createNoopAuditWriter(): AuditWriter {
  return { write: () => Promise.resolve() };
}
