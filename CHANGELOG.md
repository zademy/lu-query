# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.1.0/). El número de versión de `package.json` es la fuente de verdad: el workflow de release crea el tag `v<version>` al mergear a master.

## [2.16.1] - 2026-10-17

### Cambios internos

- **Publicacion automatica a npm con trusted publishing (OIDC)**: `.github/workflows/publish.yml` corre al publicar una release y hace `npm publish` sin token ni codigo OTP. Resuelve el error de 2FA en el pipeline: con una cuenta que tiene 2FA, `npm publish` pide un codigo de un solo uso que un runner no puede responder; en su lugar npm verifica la identidad del workflow con un token corto firmado por GitHub (`id-token: write`). Requisitos de npm: Node >= 22.14.0 (CLI >= 11.5.1) y runners alojados por GitHub.

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
