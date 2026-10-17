import type { ServerContext } from '../server.js';
import { listAuditSessions, readAuditSession } from './audit-reader.js';

export const AUDIT_URI = 'oracle://audit/sessions';

/**
 * Recurso MCP con las sesiones de auditoría (#4 lo flesh-out: recurso por
 * sesión `oracle://audit/session` con templates).
 */
export function registerAuditResource(ctx: ServerContext): void {
  ctx.server.registerResource(
    'audit-sessions',
    AUDIT_URI,
    {
      title: 'Sesiones de auditoría de lu-query',
      description: `Archivos .md de auditoría escritos en ${ctx.config.audit.dir}`,
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: await renderIndex(ctx.config.audit.dir),
        },
      ],
    }),
  );
}

async function renderIndex(dir: string): Promise<string> {
  const sessions = await listAuditSessions(dir);
  if (sessions.length === 0) return '# Auditoría\n\nTodavía no hay sesiones auditadas.\n';
  const bodies = await Promise.all(
    sessions.map(async (session) => (await readAuditSession(dir, session)) ?? ''),
  );
  return bodies.join('\n');
}
