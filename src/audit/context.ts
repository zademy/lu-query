import { randomUUID } from 'node:crypto';

/** Una operación auditada; `outcome` pasa a ok/error cuando la tool termina. */
export interface AuditEntry {
  sessionId: string;
  tool: string;
  startedAt: string;
  durationMs: number;
  arguments: Record<string, unknown>;
  outcome: 'pending' | 'ok' | 'error';
  detail: string;
}

/** Id de sesión de auditoría (un .md por sesión, como en el Java). */
export function newAuditSessionId(): string {
  return randomUUID();
}

export function createAuditEntry(
  sessionId: string,
  tool: string,
  args: Record<string, unknown>,
): AuditEntry {
  return {
    sessionId,
    tool,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    arguments: args,
    outcome: 'pending',
    detail: '',
  };
}

export function completeAuditEntry(
  entry: AuditEntry,
  outcome: 'ok' | 'error',
  detail: string,
): AuditEntry {
  return {
    ...entry,
    outcome,
    detail,
    durationMs: Date.now() - Date.parse(entry.startedAt),
  };
}
