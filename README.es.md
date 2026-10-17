![lu-query](docs/banner.png)

[![npm](https://img.shields.io/npm/v/lu-query?style=flat-square&label=npm)](https://www.npmjs.com/package/lu-query)
[![license](https://img.shields.io/npm/l/lu-query?style=flat-square&label=license)](https://github.com/zademy/lu-query/blob/master/LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522-informational?style=flat-square)](https://nodejs.org)

[![lu-query promo](https://github.com/user-attachments/assets/9740a811-cd16-4a68-967f-7792a60d1b04)](https://github.com/user-attachments/assets/9740a811-cd16-4a68-967f-7792a60d1b04)

Servidor MCP que expone una base de datos Oracle a clientes MCP por **stdio**: 75 tools para consultar, modificar, inspeccionar y diagnosticar la base, en modo thin sin instalar nada y con auditoría Markdown de cada sentencia.

## Requisitos

- Node.js >= 22
- Oracle Database 12c+ (desarrollado y probado contra Oracle Database 26ai Free)
- Sin cliente Oracle: node-oracledb corre en modo thin

## Inicio rápido

```bash
npx lu-query
```

Configuración del cliente (ejemplo para Claude Desktop; sirve cualquier cliente MCP):

```json
{
  "mcpServers": {
    "lu-query": {
      "command": "npx",
      "args": ["lu-query"],
      "env": {
        "ORACLE_DB_URL": "jdbc:oracle:thin:@//db.host:1521/FREEPDB1",
        "ORACLE_DB_USERNAME": "app_user",
        "ORACLE_DB_PASSWORD": "secret"
      }
    }
  }
}
```

### Con OpenCode

OpenCode lee `mcp.servers` de su configuracion (`opencode.json`, o `.opencode/` en el proyecto). Registra lu-query como servidor local:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "lu-query": {
        "type": "local",
        "command": ["npx", "-y", "lu-query"],
        "environment": {
          "ORACLE_DB_URL": "{env:ORACLE_DB_URL}",
          "ORACLE_DB_USERNAME": "{env:ORACLE_DB_USERNAME}",
          "ORACLE_DB_PASSWORD": "{env:ORACLE_DB_PASSWORD}"
        },
        "timeout": { "startup": 120000 }
      }
    }
  }
}
```

Notas:

- `{env:NAME}` es la sintaxis de sustitucion de OpenCode para leer una variable de tu entorno; formas de shell como `$NAME` **no** se expanden dentro de JSON. Deja la contrasena en el entorno, no en el archivo.
- `timeout.startup` sube a 120 s porque la primera ejecucion de `npx` tiene que descargar el paquete; el default global es 45 s.
- Sin `ORACLE_DB_SCHEMA`, cada tool usa el schema del usuario conectado; fijala para forzar uno.
- Verifica la conexion con `opencode mcp list`. El pool es perezoso, asi que un servidor conectado sin base de datos igual responde `initialize`; las credenciales solo se necesitan cuando una tool consulta de verdad.

### Ejecutar desde un clon local

Antes de que el paquete exista en npm (o si estas trabajandon en el), apunta el comando a tu build:

```json
"lu-query": {
  "type": "local",
  "command": ["node", "/ruta/absoluta/a/lu-query/dist/index.js"],
  "cwd": "/ruta/absoluta/a/lu-query",
  "environment": {
    "ORACLE_DB_URL": "{env:ORACLE_DB_URL}",
    "ORACLE_DB_USERNAME": "{env:ORACLE_DB_USERNAME}",
    "ORACLE_DB_PASSWORD": "{env:ORACLE_DB_PASSWORD}"
  },
  "timeout": { "startup": 120000 }
}
```

Recuerda `npm run build` primero: `dist/` se genera y esta en .gitignore.

El pool es perezoso: el server arranca y responde `initialize` sin base de datos; la primera tool abre la conexión.

## Configuración

| Variable                      | Requerida | Default              | Propósito                                                                                                   |
| ----------------------------- | --------- | -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ORACLE_DB_URL`               | sí        | —                    | Cadena de conexión: JDBC (`jdbc:oracle:thin:@//host:1521/service`) o easy-connect (`host:1521/service`)     |
| `ORACLE_DB_USERNAME`          | sí        | —                    | Usuario de base de datos                                                                                    |
| `ORACLE_DB_PASSWORD`          | sí        | —                    | Contraseña                                                                                                  |
| `ORACLE_DB_SCHEMA`            | no        | default de sesión    | Schema fijado con `ALTER SESSION SET CURRENT_SCHEMA` en cada sesión del pool                                |
| `ORACLE_POOL_SIZE`            | no        | `4`                  | Tamaño del pool de conexiones                                                                               |
| `MCP_SERVER_VERSION`          | no        | `2.13.0`             | Versión que reporta el server                                                                               |
| `MCP_AUDIT_ENABLED`           | no        | `true`               | Auditoría activada por defecto — único cambio de contrato contra el server Java (que defaulteaba a `false`) |
| `MCP_AUDIT_DIR`               | no        | `./mcp-audit-logs`   | Directorio de los Markdown de auditoría                                                                     |
| `SENTRY_ENABLED`              | no        | `false`              | Reporte de errores a Sentry                                                                                 |
| `SENTRY_DSN`                  | si Sentry | —                    | DSN de Sentry                                                                                               |
| `SENTRY_ENV`                  | no        | —                    | Ambiente Sentry                                                                                             |
| `SENTRY_RELEASE`              | no        | `MCP_SERVER_VERSION` | Release Sentry                                                                                              |
| `SENTRY_SEND_DEFAULT_PII`     | no        | `false`              | PII en eventos Sentry                                                                                       |
| `SENTRY_AUTH_TOKEN`           | no        | —                    | Aceptada por paridad de configuración; sin uso en runtime (`@sentry/node` no la tiene)                      |
| `LOG_LEVEL` / `APP_LOG_LEVEL` | no        | `INFO`               | Nivel de log del server                                                                                     |

**Límites.** Los resultsets se cupan a 1000 filas. Tres capas de timeout: sentencia 120 s, socket 30 s, watchdog de request MCP 150 s. Los identificadores se validan contra `^[A-Za-z][A-Za-z0-9_$#]{0,127}$`; los literales se escapan (`'` -> `''`).

## Auditoría de sesión

Cada sesión escribe un Markdown `lu-query-<timestamp>-log.md` en `MCP_AUDIT_DIR`, con una entrada por ejecución de tool: nombre, kind de la sentencia (SELECT, INSERT, …) y type (READ/WRITE/OTHER), duración, filas, parámetros y el SQL verbatim.

````markdown
### #1 · 11:33:52 · test_connection · SELECT · READ · ✅ OK

| Inicio | 11:33:52.410 | Fin | 11:33:52.492 | Duración | 82 ms | Filas | 1 | Parámetros | |

```sql
SELECT * FROM V$VERSION
```
````

Una sesión se relee con el recurso `oracle://audit/session/{id}` (el autocompletado ofrece `current` y los ids recientes). La auditoría se desactiva sola ante errores de I/O y lo avisa por stderr. Desactívala con `MCP_AUDIT_ENABLED=false`. Los archivos contienen cada sentencia ejecutada — protege el directorio (ver [SECURITY.md](https://github.com/zademy/lu-query/blob/master/SECURITY.md)).

## Tools (75)

### Sistema (1)

| Tool              | Propósito                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `test_connection` | Verificación de conectividad: versión, nombre de base, usuario/schema actuales, instancia |

### Query (2)

| Tool              | Propósito                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `run_query`       | Ejecuta un solo SELECT (verbatim, CTE permitidas) con paginación `offset`/`limit` opcional |
| `get_sample_data` | Primeras N filas de una tabla (10 por defecto, máximo 1000) con notificaciones de progreso |

### DML (3)

| Tool                         | Propósito                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `execute_dml`                | Ejecuta un INSERT/UPDATE/DELETE/MERGE y commitea                                              |
| `execute_dml_preview`        | Dry-run de un UPDATE/DELETE: filas que se verían afectadas y desglose del WHERE, sin ejecutar |
| `execute_dml_rollback_first` | Ejecuta DML en una transacción que se revierte de inmediato — nada persiste                   |

### DDL (7)

| Tool                     | Propósito                                                                       |
| ------------------------ | ------------------------------------------------------------------------------- |
| `comment_on_table`       | Añade o reemplaza el comentario de una tabla (solo tablas propias)              |
| `comment_on_column`      | Añade o reemplaza el comentario de una columna (solo tablas propias)            |
| `create_or_replace_view` | Crea o reemplaza una vista en el schema propio                                  |
| `create_synonym`         | Crea un sinónimo privado o público hacia un objeto de otro schema               |
| `create_sequence`        | Crea una secuencia en el schema propio                                          |
| `create_index`           | Crea un índice sobre una tabla (array columns; tabla propia o CREATE ANY INDEX) |
| `create_mview_log`       | Crea un log de vista materializada para refresh rápido                          |

### Metadata — núcleo (8)

| Tool             | Propósito                                                               |
| ---------------- | ----------------------------------------------------------------------- |
| `list_schemas`   | Schemas (usuarios) visibles a la conexión                               |
| `list_tables`    | Tablas con schema y patrón LIKE opcionales                              |
| `list_views`     | Vistas con schema y patrón LIKE opcionales                              |
| `describe_table` | Columnas de una tabla: tipo, nulabilidad, default, comentario           |
| `table_exists`   | true/false vía ALL_TABLES (las vistas no cuentan)                       |
| `search_objects` | Busca objetos por patrón LIKE case-insensitive, filtro de tipo opcional |
| `list_objects`   | Lista objetos por schema y tipo (tablas, vistas, packages, …)           |
| `get_ddl`        | DDL de un objeto vía DBMS_METADATA.GET_DDL (como string CLOB)           |

### Metadata — catálogo (21)

| Tool                      | Propósito                                                               |
| ------------------------- | ----------------------------------------------------------------------- |
| `list_indexes`            | Índices de una tabla con columnas, unicidad, status                     |
| `list_constraints`        | Constraints PK/FK/unique/check con columnas y referencias               |
| `list_sequences`          | Secuencias con rango, incremento, último número, cycle, cache           |
| `get_sequence_info`       | Metadata de una secuencia                                               |
| `list_triggers`           | Triggers con tipo, evento, tabla, status                                |
| `list_procedures`         | Procedures, functions, packages, types                                  |
| `list_synonyms`           | Sinónimos privados/públicos con destino resuelto y DB link              |
| `list_db_links`           | Database links visibles al usuario                                      |
| `list_directories`        | Objetos directorio y rutas de filesystem                                |
| `list_external_tables`    | Tablas externas: driver, directorio, reject limit, access params        |
| `list_materialized_views` | MViews con modo/método de refresh, último refresh, staleness            |
| `list_mview_logs`         | Logs de vistas materializadas sobre tablas                              |
| `list_partitions`         | Particiones de tabla: high value, filas, compresión, último analyze     |
| `list_ind_partitions`     | Particiones de índice: status, leaf blocks, distinct keys               |
| `list_subpartitions`      | Subparticiones de una tabla compuesta                                   |
| `list_lob_columns`        | Columnas LOB: segmento, índice, caching, SECUREFILE, retention          |
| `list_types`              | Tipos definidos por el usuario: typecode, atributos, métodos, supertipo |
| `list_invalid_objects`    | Objetos con status INVALID (código roto)                                |
| `list_dependencies`       | Objetos de los que depende un objeto dado (análisis de impacto)         |
| `list_scheduler_jobs`     | Jobs del scheduler: estado, corridas/fallos, próxima ejecución          |
| `list_scheduler_job_runs` | Detalle de corridas recientes: duración, código de error, salida        |

### Estadísticas del optimizador y salud (7)

| Tool                       | Propósito                                                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `get_table_stats`          | Stats del optimizador de tabla: filas, bloques, largo medio, último analyze                                                             |
| `get_column_stats`         | Stats de columna: NDV, densidad, nulls, buckets                                                                                         |
| `get_histogram`            | Endpoints del histograma de una columna                                                                                                 |
| `get_session_privs`        | Privilegios de sistema concedidos y efectivos                                                                                           |
| `get_session_roles`        | Roles activos con flags admin/default                                                                                                   |
| `get_plsql_errors`         | Errores de compilación de unidades PL/SQL                                                                                               |
| `oracle_mcp_health_report` | Chequeo de disponibilidad en un tiro: conectividad, versión, rol de catálogo, objetos inválidos, config del server, estado de auditoría |

### PL/SQL (2)

| Tool             | Propósito                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `describe_plsql` | Argumentos y código fuente completo de un objeto PL/SQL                                       |
| `call_procedure` | Ejecuta procedure/function/subprograma de package con args IN/OUT/INOUT y retornos REF CURSOR |

### Explain y tuning (4)

| Tool                     | Propósito                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `explain_plan`           | Plan de ejecución vía EXPLAIN PLAN + DBMS_XPLAN sin ejecutar la sentencia                    |
| `suggest_index`          | Analiza el plan de una sentencia; propone CREATE INDEX cuando una tabla se lee por full scan |
| `list_unused_indexes`    | Índices con columnas e información de uso best-effort                                        |
| `run_sql_tuning_advisor` | Reporte de DBMS_SQLTUNE con recomendaciones                                                  |

### Grafos y helpers (7)

| Tool                      | Propósito                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `get_next_sequence_value` | NEXTVAL de una secuencia — lectura con efecto: avanza el contador                   |
| `validate_fk_integrity`   | Filas huérfanas por FK de una tabla (lista vacía = integridad intacta)              |
| `find_free_id`            | Id libre más bajo en 1..maxRange (default 1000, tope 10000) no presente en la tabla |
| `find_duplicates`         | Grupos de valores duplicados en una o más columnas (NULLs excluidos)                |
| `count_rows`              | Conteo exacto de filas de una tabla sin correr SQL                                  |
| `get_dependency_graph`    | Grafo de dependencias de objetos de un schema (Mermaid)                             |
| `get_fk_graph`            | Grafo de foreign keys de un schema o tabla (Mermaid)                                |

### Performance — vistas V$ (13)

Requiere `SELECT ANY DICTIONARY` (o equivalente) en el usuario de base de datos; las tools devuelven un hint del grant ante ORA-00942/01031.

| Tool                    | Propósito                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `list_active_sessions`  | Sesiones ACTIVE: usuario, máquina, programa, last call elapsed                      |
| `list_blocked_sessions` | Sesiones bloqueadas con sid/usuario bloqueante y wait event                         |
| `list_locks`            | Locks DML/transacción/usuario mantenidos y pedidos, objeto y modo decodificado      |
| `get_session_sql_text`  | Texto SQL completo que ejecuta una sesión (sid + serial#)                           |
| `list_top_sql`          | Top-N SQL por buffer_gets (default), disk_reads, elapsed_time, executions, cpu_time |
| `get_wait_events`       | Waits actuales de V$SESSION_WAIT, filtro sid/clase opcional                         |
| `get_session_longops`   | Operaciones largas con progreso desde V$SESSION_LONGOPS                             |
| `get_instance_info`     | Instancia: nombre, host, versión, arranque, status, archiver                        |
| `get_database_info`     | Base: nombre, creación, log mode, open mode, rol                                    |
| `get_system_stats`      | Stats acumuladas de V$SYSSTAT: parses, DB time, IO físico                           |
| `get_db_time_model`     | V$SYS_TIME_MODEL: DB CPU, DB time, tiempos de parse                                 |
| `get_parameter`         | Parámetros de inicialización de V$PARAMETER                                         |
| `list_datafile_io`      | Datafiles con tamaño, lecturas/escrituras y tiempo medio de IO                      |

## Recursos (4)

| Plantilla URI                                  | Propósito                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| `oracle://audit/session/{id}`                  | Log Markdown de auditoría de una sesión (`current` resuelve a la viva) |
| `oracle://schema/{schema}/table/{table}`       | Descripción a nivel columna de una tabla o vista                       |
| `oracle://schema/{schema}/object/{object}/ddl` | DDL de cualquier objeto (tipo autodetectado)                           |
| `oracle://schema/{schema}/plsql/{object}`      | Código PL/SQL (procedure, function, package, type body)                |

## Prompts (9)

`review-sql-performance`, `explain-schema`, `debug-invalid-plsql`, `safe-dml-plan`, `data-quality-audit`, `triage-database-incident`, `prepare-plsql-call`, `operating-rules`, `oracle-sql-style` — guías de trabajo de solo lectura para tareas Oracle comunes con estas tools.

## Skills para agentes (opcional)

Ocho skills por tarea que enseñan a un agente cómo usar bien estas 75 tools: qué tool para cada trabajo, en qué orden, qué modifica datos, cómo se ven los fallos y cómo leer los resultados. Instálalas con el CLI [`skills`](https://www.npmjs.com/package/skills), que coloca cada skill donde tu agente la busca:

```bash
npx skills@latest add zademy/lu-query           # instala las ocho skills
npx skills@latest add zademy/lu-query --list    # solo listarlas
```

Flags útiles: `-g` instala global en vez de por proyecto, `-a <agent>` elige el destino (`claude-code`, `opencode`, `cursor`, `codex`, `gemini-cli`, …), `-s <skill>` instala una sola (o `'*'` para todas), `--copy` copia en vez de enlazar.

¿Sin CLI? Cópialas a mano: cada carpeta es autocontenida (`SKILL.md` + `references/`):

```bash
cp -r node_modules/lu-query/skills/lu-query-* ~/.claude/skills/   # Claude Code y OpenCode
```

Skills: `lu-query-explore-schema`, `lu-query-query-data`, `lu-query-audit-data-quality`, `lu-query-plan-data-changes`, `lu-query-manage-schema`, `lu-query-use-plsql`, `lu-query-tune-sql`, `lu-query-triage-incident`. Catálogo y procedencia de los ejemplos: [`skills/README.md`](https://github.com/zademy/lu-query/blob/master/skills/README.md). Instalar el server nunca instala skills por su cuenta.

## Seguridad

Ver [SECURITY.md](https://github.com/zademy/lu-query/blob/master/SECURITY.md). Puntos clave: solo stdio (sin puertos), allow-list de identificadores, literales escapados, directorio de auditoría a proteger. El usuario de base de datos debe ser de mínimos privilegios: el server depende de los grants de Oracle, no de sus propios checks, para todo lo que las tools no validan.

## Contribuir

Ver [CONTRIBUTING.md](https://github.com/zademy/lu-query/blob/master/CONTRIBUTING.md). La publicación a npm es manual y la hace el mantenedor. Vocabulario en [GLOSSARY.md](https://github.com/zademy/lu-query/blob/master/GLOSSARY.md); decisiones en [docs/adr/](https://github.com/zademy/lu-query/blob/master/docs/adr/).

## Licencia

MIT (c) 2026 Sadot Hernández Moreno
