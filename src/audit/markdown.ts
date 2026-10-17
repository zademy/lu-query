import type { AuditEntry } from './context.js';

/** Cabecera del archivo de una sesión. */
export function renderSessionHeader(sessionId: string): string {
  return `# lu-query audit — ${sessionId}\n`;
}

/** Renderiza una operación como sección Markdown legible (sin dependencias). */
export function renderAuditMarkdown(entry: AuditEntry): string {
  if (entry.outcome === 'pending') return '';
  const detail = entry.detail ? `\n- detail: ${entry.detail}` : '';
  return [
    `## ${entry.startedAt} · ${entry.tool} · ${entry.outcome} (${entry.durationMs} ms)`,
    '',
    `- arguments: \`${JSON.stringify(entry.arguments)}\``,
    `- outcome: ${entry.outcome}`,
    `- duration_ms: ${entry.durationMs}${detail}`,
    '',
  ].join('\n');
}

/** Nombre del archivo de una sesión. */
export function auditFileName(sessionId: string): string {
  return `${sessionId}.md`;
}
