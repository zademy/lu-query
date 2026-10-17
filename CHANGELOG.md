# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.1.0/); versionado alineado con `mcp-oracle-db` para reflejar la paridad.

## [2.13.0] — 2026-10-17

Release inicial: puerto a TypeScript del servidor Java `mcp-oracle-db` 2.13.0, con paridad 1:1 de tools.

### Añadido

- **73 tools**: sistema (1), query (2), DML (3), DDL (7), metadata núcleo (8), catálogo (21), stats del optimizador y salud (7), PL/SQL (2), explain y tuning (4), grafos y helpers (5), performance V$ (13).
- **4 recursos**: `oracle://audit/session/{id}`, `oracle://schema/{s}/table/{t}`, `oracle://schema/{s}/object/{o}/ddl`, `oracle://schema/{s}/plsql/{o}`.
- **9 prompts** de guía (review-sql-performance, explain-schema, debug-invalid-plsql, safe-dml-plan, data-quality-audit, triage-database-incident, prepare-plsql-call, operating-rules, oracle-sql-style).
- **Auditoría de sesión en Markdown** (formato `3-md`): un archivo `lu-query-<ts>-log.md` por sesión, una entrada por ejecución de tool (kind, type, duración, filas, SQL verbatim), flush por entrada y autodesactivación ante errores de I/O.
- Driver `oracledb` en **modo thin** (sin cliente Oracle), pool perezoso con `ALTER SESSION SET CURRENT_SCHEMA` por sesión.
- **3 capas de timeout** (sentencia 120 s, socket 30 s, request MCP 150 s) y tope de 1000 filas por resultset.
- Reporte de errores a **Sentry** opcional (`SENTRY_ENABLED`+`SENTRY_DSN`), con flush en señales de terminación.
- `call_procedure` con binds IN/OUT/INOUT y **REF CURSOR** nativos del driver.

### Cambios contra el server Java 2.13.0 (desviaciones deliberadas)

- `MCP_AUDIT_ENABLED` defaultea a `true` (en Java era opt-in) y la auditoría se persiste como Markdown por sesión — el JSON de auditoría desaparece.
- `run_query` rechaza sentencias no-SELECT por sí mismo (el Java delegaba a los mínimos privilegios de Oracle).
- Preview de DML con `node-sql-parser` (sin dialecto Oracle: se usa el de PostgreSQL; MERGE no se parsea y se reporta UNKNOWN, dejando que Oracle decida).
- Las tools DDL reciben las columnas como array `columns` (el Java no tiene variante por columna única) y `create_index` acepta nombre de índice propio.
- EXPLAIN/planes capturados vía bloques de transacción autónoma; `V$OBJECT_USAGE` sustituida por `USER_OBJECT_USAGE` en Oracle 26ai.
- `SENTRY_AUTH_TOKEN` se acepta en config pero no se usa (no existe en el runtime de `@sentry/node`); `SENTRY_RELEASE` defaultea a `MCP_SERVER_VERSION`.

### Seguridad

- stdio únicamente; allow-list de identificadores `^[A-Za-z][A-Za-z0-9_$#]{0,127}$` y escape de literales (`'` → `''`). Ver [SECURITY.md](SECURITY.md).
