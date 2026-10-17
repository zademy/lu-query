import type { ServerContext } from '../server.js';
import { registerDdl } from './ddl.js';
import { registerDml } from './dml.js';
import { registerExplain } from './explain.js';
import { registerGraph } from './graph.js';
import { registerMetadataCatalog } from './metadata-catalog.js';
import { registerMetadataCore } from './metadata-core.js';
import { registerPerformance } from './performance.js';
import { registerPlsql } from './plsql.js';
import { registerPrompts } from './prompts.js';
import { registerQuery } from './query.js';
import { registerStatsHealth } from './stats-health.js';
import { registerSystem } from './system.js';

/** Un grupo de tools: registra sobre `ctx.server` lo que le toca. */
export type ToolGroup = (ctx: ServerContext) => void;

/**
 * Orden fijo de registro (paridad con el Java). `ticket` es el numero de ticket
 * de migracion del grupo en el repo original: sirve para rastrear el origen.
 */
export const toolGroups: { ticket: number; name: string; register: ToolGroup }[] = [
  { ticket: 3, name: 'system', register: registerSystem },
  { ticket: 5, name: 'query', register: registerQuery },
  { ticket: 6, name: 'dml', register: registerDml },
  { ticket: 7, name: 'ddl', register: registerDdl },
  { ticket: 8, name: 'metadata-core', register: registerMetadataCore },
  { ticket: 9, name: 'metadata-catalog', register: registerMetadataCatalog },
  { ticket: 10, name: 'stats-health', register: registerStatsHealth },
  { ticket: 11, name: 'plsql', register: registerPlsql },
  { ticket: 12, name: 'explain', register: registerExplain },
  { ticket: 13, name: 'graph', register: registerGraph },
  { ticket: 14, name: 'performance', register: registerPerformance },
  { ticket: 15, name: 'prompts', register: registerPrompts },
];

export function registerToolGroups(ctx: ServerContext): void {
  for (const group of toolGroups) group.register(ctx);
}
