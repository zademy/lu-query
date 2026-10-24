# Sustitutos donde el ecosistema TS no tiene equivalente Java

Cuando una dependencia del Java no existe en TS, sustituimos y documentamos el hueco en lugar de imitar el comportamiento a mano. El contrato MCP se mantiene idéntico; la mecánica interna se adapta al driver real con evidencia (probe contra la versión instalada o su documentación).

## Sustituciones vigentes

- `node-sql-parser` no tiene dialecto Oracle: parsea como PostgreSQL y lo que no entiende (p. ej. MERGE) se clasifica `UNKNOWN` y Oracle decide.
- `oracledb` thin no autocommitea (commit explícito en el chokepoint) y no expone `stmtTimeout` (se simula con `Promise.race` + `breakExecution`).
- `@sentry/node` no acepta `SENTRY_AUTH_TOKEN`: se ignora en runtime.
- EXPLAIN PLAN requiere bloques con `PRAGMA AUTONOMOUS_TRANSACTION` para no ensuciar la sesión.
- TypeScript va pineado a 6.x solo para tsserver/editor: el typecheck del gate corre por tsgolint (TypeScript Go) desde la migracion a Vite+ (ADR 0006).
