import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { auditFileName } from './markdown.js';

/** `yyyyMMdd'T'HHmmss.SSSSSSSSS±HHmm` con el sufijo opcional de colisión `-NNN`. */
const SESSION_ID = String.raw`\d{8}T\d{6}\.\d{9}[+-]\d{4}(?:-\d{3})?`;

const FILE_NAME = new RegExp(String.raw`^[a-z-]+-(${SESSION_ID})-log\.md$`);

/** Un id de sesión solo es válido con esa forma: evita escapes fuera del dir. */
function isAuditSessionId(sessionId: string): boolean {
  return new RegExp(String.raw`^${SESSION_ID}$`).test(sessionId);
}

/** Ids de las sesiones auditadas en `dir`, en orden alfabético. */
export async function listAuditSessions(dir: string): Promise<string[]> {
  const files = await readdir(dir).catch(() => [] as string[]);
  return files
    .map((file) => FILE_NAME.exec(file)?.[1])
    .filter((id): id is string => id !== undefined)
    .sort();
}

/**
 * Markdown crudo de una sesión, tal como está en disco. Un archivo truncado a
 * media entrada (flush cortado al morir el proceso) se devuelve tal cual: el
 * recurso lo sirve crudo, no lo reinterpreta.
 */
export function readAuditSession(dir: string, sessionId: string): Promise<string | undefined> {
  if (!isAuditSessionId(sessionId)) return Promise.resolve(undefined);
  return readFile(join(dir, auditFileName(sessionId)), 'utf8').catch(() => undefined);
}
