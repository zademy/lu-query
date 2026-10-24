# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.1.0/). El número de versión de `package.json` es la fuente de verdad: el workflow de release crea el tag `v<version>` al mergear a master.

## [2.19.0] - 2026-10-23

### Cambiado

- **El toolchain de desarrollo migra a Vite+** (`vp`, VoidZero, core Rust): `vp check` (Oxlint + Oxfmt + typecheck tsgolint) reemplaza `eslint` + `typescript-eslint` + `prettier` + `tsc --noEmit`; `vp test` reemplaza al runner `vitest` directo y `vp pack` (tsdown/Rolldown) reemplaza a `tsup`. Las configs se consolidan en `vite.config.ts` y salen las devDependencies `eslint`, `typescript-eslint`, `prettier` y `tsup` (`typescript` se conserva para el editor; `vitest` queda pineado al bundle de Vite+). Los npm scripts no cambian de nombre: los flujos locales y la CI se invocan igual.
- **Node minimo sube a 22.18** (`^22.18.0 || ^24.11.0 || >=26.0.0`, requisito de vite-plus). Motivo del bump minor.
- El gate es mas rapido: lint type-aware en ~0.7 s, typecheck en ~0.5 s, build del bin en ~33 ms.

### Anadido

- ADR 0006: decision de migracion a Vite+, alcance y reglas lint aceptadas como diferencias.

### Cambios internos

- El test de integracion de stdio empaqueta y ejecuta el artefacto real de produccion (`npm run build` -> `dist/index.js`) en vez de un bundle tsup ad-hoc en cache.
- `DEFAULT_SERVER_VERSION` acompana el bump (2.19.0).
- Comparadores de orden explicitos en dos tests de integracion (regla type-aware `require-array-sort-compare`).
- `allowScripts` sin `esbuild`: tsdown/Rolldown no lo usan.

## [2.16.3] - 2026-10-18

### Corregido

- **El Schema de sesion nunca se resolvia**: `resolveSchemaFor` leia la fila de `SYS_CONTEXT` por `current_schema`, pero node-oracledb devuelve el nombre de columna en mayusculas (`CURRENT_SCHEMA`). La cache nunca se llenaba y toda tool de catalogo sin `ORACLE_DB_SCHEMA` y sin argumento `schema` fallaba con `ConfigError: ... necesita un schema`. Los fakes de los tests devolvian la clave en minusculas, asi que la suite no lo podia ver; ahora se lee igual que en `test_connection`.
- **Los LOB rompian el JSON de la respuesta**: node-oracledb devuelve CLOB, NCLOB y BLOB como un objeto `Lob` que arrastra la referencia de la conexion, y `JSON.stringify` de la fila falla con `Converting circular structure to JSON`. Afectaba a cualquier tabla con columna CLOB o BLOB (`get_sample_data`, `run_query`) y a `list_external_tables`, cuyo `access_parameters` es un CLOB. Se resuelve en el chokepoint, con `fetchTypeHandler` por execute: el `fetchAsString` del pool es un no-op en node-oracledb v6.
- **El tope de filas solo se aplicaba a `run_query`**: el adapter pasaba `options?.maxRows` tal cual a oracledb, cuyo default son 100 filas, mientras el server promete `MAX_ROWS` (1000). Unas 58 tools de lectura truncaban a 100 filas en silencio. Ahora todas parten de `MAX_ROWS`.
- **El SELECT espejo del preview de DML era SQL invalido**: `execute_dml_preview` reserializaba el WHERE desde el AST de node-sql-parser con el dialecto PostgreSQL, que entrecomilla los identificadores (`"e".DEPT_ID`) y tira el alias de la tabla. Oracle lo rechazaba con ORA-00904 y ORA-00907 en cuanto la consulta llevaba alias o subconsulta. Ahora el espejo sale del SQL que escribio el usuario.

### Cambios internos

- **Un solo camino de registro para las 75 tools**: `vTool` centraliza `withToolContext` + `guardTool` + `registerTool`, y los formatters de resultado (`jsonResult`, `rawResult`, `catalogResult`) viven en un unico sitio. Los 61 sitios de registro pasan a ser uno.
- **El `AuditWriter` deja de ser un singleton de modulo**: vive en `ServerContext`, se construye en `createServer` y `registerAuditResource` solo publica el recurso. `withAudit` se aplica en `createServer`, asi que todo adapter inyectado queda auditado.
- **Un solo resolutor de schema**: `resolveSchemaFor` es el unico camino; se eliminaron `resolveSchema` y `schemaFallback`.
- **Helpers duplicados eliminados**: `likePattern`, `ownerBinds` y `stripTrailingTerminator` viven en `src/sql/text.ts`, y `explain.ts` usa el `quoteTrustedIdentifier` compartido en vez de su copia.
- `stats-health.ts` valida el identificador de tabla y columna como sus pares (`assertIdentifier`).

### Anadido

- **219 tests de integracion contra Oracle real** (19 ficheros): las 75 tools una vez cada una, el tope de filas, el schema de sesion, el SQL avanzado (joins, outer joins, window functions, CTE, hints), el zoo de objetos de Oracle (particiones, IOT, GTT, LOB, JSON, XMLTYPE, object types, packages, indices), el SQL de Oracle a fondo (CONNECT BY, PIVOT, UNPIVOT, vistas con CHECK OPTION, vistas materializadas) y el transporte stdio real en un proceso hijo.
- `assertIdentifier` en las tres tools de tabla y columna de `stats-health.ts`.

### Documentacion

- Las 9 skills se alinean con el comportamiento de 2.16.x: la resolucion de schema es automatica, el tope de 1000 filas aplica a toda tool de lectura, se documentan las formas de las columnas no escalares (CLOB, BLOB, JSON, XMLTYPE) y se anaden los 9 prompts que publica el server.

## [2.16.2] - 2026-10-17

### Cambios internos

- **Publicacion automatica a npm con trusted publishing (OIDC)**: `.github/workflows/release.yml` publica en npm en el mismo run que crea la release, con `npm publish` y sin token ni codigo OTP. Va en un workflow aparte pero se dispara con el push a master, no con el evento de release: GitHub no ejecuta workflows disparados por eventos creados con su propio `GITHUB_TOKEN`, asi que un workflow aparte con `on: release` nunca se habria ejecutado. El paso es idempotente: si esa version ya esta en npm, avisa y no publica. Resuelve el error de 2FA en el pipeline: con una cuenta que tiene 2FA, `npm publish` pide un codigo de un solo uso que un runner no puede responder; en su lugar npm verifica la identidad del workflow con un token corto firmado por GitHub (`id-token: write`). Requisitos de npm: Node >= 22.14.0 (CLI >= 11.5.1) y runners alojados por GitHub. Primera publicacion hecha por GitHub Actions con el Trusted Publisher de OIDC, sin token ni codigo OTP. La 2.16.1 se versiono pero no llego a npm.

## [2.16.0] - 2026-10-17

### Anadido

- **Skill `lu-query-audit-report`**: convierte los archivos de auditoria de sesion (Markdown) en un reporte HTML interactivo de una ventana de fechas. Pregunta el directorio y las dos fechas (dd/mm/aaaa, maximo un mes), corre `scripts/audit-report.mjs` y entrega la ruta del HTML en `<auditDir>/reports/`. Siete paneles: KPIs (sentencias, OK/ERROR, tasa de error, media y p95, filas, sesiones/dias), actividad por dia y por hora, tools por llamadas y por duracion acumulada, las 10 sentencias mas lentas con su SQL, errores agrupados por codigo ORA, reparto READ/WRITE/OTHER y una fila por sesion. Node sin dependencias: no instala nada, no consulta la base y falla con un mensaje que dice que corregir.
- `references/template.html` de esa skill es un archivo real, no un string en el codigo: `prettier --check` lo formatea, asi que la estructura del reporte la hace cumplir la maquina. Tailwind v4 y Chart.js 4 por CDN, con la paleta y el grid de `docs/banner.png`.
- `GLOSSARY.md`: **Reporte de auditoria** y **Ventana del reporte**; la entrada de **Archivo de auditoria de sesion** ahora precisa que hay una entrada por sentencia, no por llamada de tool.

### Cambios internos

- `eslint` trata `skills/**/*.mjs` como `scripts/**/*.mjs` (sin reglas tipadas: el parser se copia y corre fuera del proyecto TypeScript).
- `test/unit/audit-report.test.ts`: 8 pruebas sobre el CLI (agregados, filtrado por ventana, `format-version` desconocida, entrada truncada, ventanas imposibles, nombre del archivo). Las fixtures se escriben con el propio `renderAuditEntry` del server, asi que el formato no puede divergir.

## [2.15.1] - 2026-10-17

### Cambios

- README (EN/ES): la seccion de OpenCode documenta el flujo instalar -> configurar -> verificar con `npm i -g lu-query` como via principal, `npx -y lu-query` como alternativa sin instalacion global y el clon local como tercera via. Se aclara que `MCP_AUDIT_DIR` debe ser una ruta absoluta (el default relativo cae en el directorio de trabajo del proceso, tu proyecto) y que el install script de `oracledb` bloqueado por npm es inocuo en modo thin.
- README (EN/ES): el banner apunta a una URL absoluta de `raw.githubusercontent.com` porque npmjs.com no resuelve rutas relativas de imagen.
- README (EN/ES): el badge de licencia de shields.io anade `cacheSeconds` para invalidar la cache negativa guardada cuando el paquete aun no existia.

## [2.15.0] - 2026-10-17

### Anadido

- **Video promocional** de 33 s (`docs/lu-query-promo.mp4`: 1920x1080, 30 fps, H.264) generado con Remotion en `video/`, reproducible en el README mediante el asset del issue. Workspace de video aislado: no entra al paquete npm ni a CI.
- `video/README.md` documenta como re-renderizar el video y las reglas de estilo (motion graphics propios, sin logos ni assets de terceros).

### Cambios

- CI sin `cache: npm` (ocupa espacio en el runner sin aportar a una instalacion limpia).
- `eslint` ignora `.agents/**`: las skills de agente traen assets vendorizados que rompian el lint de raiz (`.prettierignore` ya lo hacia).
- README (EN/ES): el promo queda en una sola linea bajo los badges, sin repetir el banner.

## [2.14.1] - 2026-10-17

### Cambios internos

- Listo para publicar en npm: `prepublishOnly: npm run build` (el tarball nunca lleva un `dist/` viejo o ausente), links absolutos en README/README.es/CHANGELOG (los relativos rompen en npmjs.com) y runbook de publicacion en `CONTRIBUTING.md`.
- Banner del proyecto (`docs/banner.png`, generado con `npm run banner` desde `scripts/banner.html`) al inicio de ambos README, con badges npm/license/node.
- Documentacion de instalacion de skills con `npx skills@latest add zademy/lu-query` en ambos README y en `skills/README.md`.
- Autor: `Sadot Hernandez Moreno` en `package.json`, `LICENSE` y README.

## [2.14.0] - 2026-10-17

### Añadido

- **Skills opcionales para agentes** en `skills/` (dentro del paquete npm): 8 carpetas por tarea - explore-schema, query-data, audit-data-quality, plan-data-changes, manage-schema, use-plsql, tune-sql, triage-incident - que cubren las 75 tools con referencias de firmas y ejemplos verificados contra una base Oracle real. Se copian a mano al directorio de skills del agente; nada se instala automáticamente.
- README (EN/ES) con sección de instalación de las skills; `GLOSSARY.md` incorpora los términos _Skill_ y _Ejemplo verificado_.

### Cambios internos

- La versión reportada por el server (`DEFAULT_SERVER_VERSION`) y las expectativas de los tests derivan ahora de `package.json`, con un test que detecta drift: `package.json` es la única fuente de verdad del número de release.

## [2.13.0] — 2026-10-17

Release inicial: puerto a TypeScript del servidor Java `mcp-oracle-db` 2.13.0, con paridad 1:1 de tools.

### Añadido

- **75 tools**: sistema (1), query (2), DML (3), DDL (7), metadata núcleo (8), catálogo (21), stats del optimizador y salud (7), PL/SQL (2), explain y tuning (4), grafos y helpers (7), performance V$ (13).
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

- stdio únicamente; allow-list de identificadores `^[A-Za-z][A-Za-z0-9_$#]{0,127}$` y escape de literales (`'` → `''`). Ver [SECURITY.md](https://github.com/zademy/lu-query/blob/master/SECURITY.md).
