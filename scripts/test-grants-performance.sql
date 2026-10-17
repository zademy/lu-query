-- ---------------------------------------------------------------------------
-- scripts/test-grants-performance.sql
--
-- Requisito de las tools de performance de lu-query (src/tools/performance.ts):
-- las 13 tools de diagnostico (list_active_sessions, list_locks, list_top_sql,
-- get_wait_events, ...) solo leen las vistas dinamicas V$ y V$_FIXED. Oracle no
-- las expone al usuario por defecto: sin privilegio de catalogo responde
-- ORA-00942 (o ORA-01031) y la tool llega al cliente como isError con este mismo
-- grant en el hint.
--
-- Que privilege hace falta
--   SELECT ANY DICTIONARY  (privilegio de sistema, el que usa este script)
--   SELECT_CATALOG_ROLE    (equivalente como rol; da acceso a mas cosas)
-- Es deliberadamente mas ancho que el usuario de minimos privilegios de los
-- catalogos (#8/#9), porque el diagnostico en vivo no se puede hacer sin el.
--
-- Como aplicarlo (usuario de pruebas del contenedor Oracle, como SYSTEM):
--   docker exec -i oracle-26ai-free \
--     bash -c "sqlplus -s system/OraclePassword123@FREEPDB1" < scripts/test-grants-performance.sql
--
-- Es idempotente: se puede repetir sin efectos. En produccion, un DBA aplica lo
-- mismo sobre el usuario MCP real y lo revierte con:
--   REVOKE SELECT ANY DICTIONARY FROM DEVUSER;
-- ---------------------------------------------------------------------------

ALTER SESSION SET CONTAINER = FREEPDB1;

GRANT SELECT ANY DICTIONARY TO DEVUSER;

-- Comprobacion: debe salir SELECT ANY DICTIONARY y un numero de sesiones activas.
SET LINESIZE 200 PAGESIZE 100 FEEDBACK OFF
COLUMN privilege FORMAT A30
SELECT privilege FROM dba_sys_privs WHERE grantee = 'DEVUSER' AND privilege = 'SELECT ANY DICTIONARY';
SELECT COUNT(*) AS active_sessions FROM v$session WHERE status = 'ACTIVE';