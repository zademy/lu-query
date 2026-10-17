import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { auditFileName } from './markdown.js';

/** Ids de las sesiones auditadas en `dir`, en orden alfabético. */
export async function listAuditSessions(dir: string): Promise<string[]> {
  const files = await readdir(dir).catch(() => [] as string[]);
  return files
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.slice(0, -'.md'.length))
    .sort();
}

/** Markdown crudo de una sesión, o undefined si no existe. */
export function readAuditSession(dir: string, sessionId: string): Promise<string | undefined> {
  return readFile(join(dir, auditFileName(sessionId)), 'utf8').catch(() => undefined);
}
