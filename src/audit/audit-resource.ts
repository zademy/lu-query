import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerContext } from '../server.js';
import { listAuditSessions, readAuditSession } from './audit-reader.js';
import { configureAudit, currentAuditSessionId } from './audit-writer.js';

/** Plantilla del recurso: una sesión de auditoría por lectura. */
export const AUDIT_URI = 'oracle://audit/session/{id}';

const MIME = 'text/markdown';

/** Tope de sugerencias del completion, como en el `OracleCompletions` del Java. */
const MAX_SUGGESTIONS = 20;

/**
 * Recurso MCP con el Markdown crudo de cada sesión (`id=current` = la viva) y
 * completions del `id` con los ids reales del directorio de auditoría.
 *
 * Registrarlo es también el punto donde se configura la auditoría viva del
 * proceso (una sesión por proceso, como el bean `AuditLogWriter` del Java).
 */
export function registerAuditResource(ctx: ServerContext): void {
  const { audit } = ctx.config;
  configureAudit(audit);

  ctx.server.registerResource(
    'audit-session',
    new ResourceTemplate(AUDIT_URI, {
      list: async () => ({
        resources: (await listAuditSessions(audit.dir)).map((id) => ({
          uri: `oracle://audit/session/${id}`,
          name: `Sesión de auditoría ${id}`,
          mimeType: MIME,
        })),
      }),
      complete: {
        id: async (value) => {
          const prefix = value.toUpperCase();
          return ['current', ...(await listAuditSessions(audit.dir))]
            .filter((candidate) => candidate.toUpperCase().startsWith(prefix))
            .slice(0, MAX_SUGGESTIONS);
        },
      },
    }),
    {
      title: 'Auditoría SQL por sesión',
      description:
        'Log Markdown de una sesión de lu-query: una entrada por sentencia SQL con tool, tipo, filas, duración, parámetros y SQL. El id es el timestamp de la sesión; usa "current" para la sesión viva.',
      mimeType: MIME,
    },
    async (uri, variables) => {
      const requested = String(variables.id);
      const sessionId = requested.toLowerCase() === 'current' ? currentAuditSessionId() : requested;
      // Con la auditoría apagada el recurso es inerte, como en el Java.
      const markdown = audit.enabled ? await readAuditSession(audit.dir, sessionId) : undefined;

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: MIME,
            text:
              markdown ??
              `(No hay auditoría para la sesión '${sessionId}': MCP_AUDIT_ENABLED puede estar desactivado o aún no se ha ejecutado SQL.)`,
          },
        ],
      };
    },
  );
}
