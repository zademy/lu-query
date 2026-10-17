-- Grants y objetos de prueba para el grupo Explain/Index Advisor (#12).
--
-- Solo para el contenedor de desarrollo (oracle-26ai-free): el usuario real
-- decide su propio setup. El script de referencia del Java
-- (db/setup_least_privilege_user.sql, secciones 5 y 8) deja estos mismos
-- puntos commented-out porque son grants de DBA.
--
--   docker exec -i oracle-26ai-free bash -c "sqlplus -s system/OraclePassword123@FREEPDB1" < scripts/test-grants-explain.sql
--
-- Es idempotente: se puede reejecutar sin efectos.

SET SERVEROUTPUT ON

-- 1. explain_plan escribe en PLAN_TABLE y borra la fila al terminar. Cada
--    sesión necesita la suya propia: se crea desde SYS.PLAN_TABLE$ si falta.
DECLARE
  v_missing NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_missing FROM dual WHERE NOT EXISTS (
    SELECT 1 FROM all_tables WHERE owner = 'DEVUSER' AND table_name = 'PLAN_TABLE'
  );
  IF v_missing > 0 THEN
    EXECUTE IMMEDIATE
      'CREATE TABLE DEVUSER.PLAN_TABLE AS SELECT * FROM SYS.PLAN_TABLE$ WHERE 1=0';
    DBMS_OUTPUT.PUT_LINE('PLAN_TABLE creada en DEVUSER');
  ELSE
    DBMS_OUTPUT.PUT_LINE('PLAN_TABLE ya existía');
  END IF;
END;
/

-- 2. list_unused_indexes: sin histórico de uso la tool responde con la nota de
--    indisponibilidad. En las bases 26ai Free no existe V$OBJECT_USAGE y el
--    tool cae a su equivalente por usuario, USER_OBJECT_USAGE, que es legible
--    sin grant (SELECT_CATALOG_ROLE del rol DBA del usuario de pruebas).
--    En Enterprise, con SELECT sobre SYS.V_$OBJECT_USAGE ya funciona el primero.

-- 3. Sin ALTER INDEX ... MONITORING USAGE no hay histórico de uso y
--    likely_unused siempre vale UNKNOWN: se enciende para los índices del
--    usuario de pruebas (la consulta de la tool no necesita más privilegios).
BEGIN
  FOR r IN (SELECT index_name FROM all_indexes WHERE owner = 'DEVUSER' AND index_type = 'NORMAL') LOOP
    BEGIN
      EXECUTE IMMEDIATE 'ALTER INDEX DEVUSER."' || r.index_name || '" MONITORING USAGE';
    EXCEPTION WHEN OTHERS THEN
      DBMS_OUTPUT.PUT_LINE('monitoring omitido en ' || r.index_name || ': ' || SQLERRM);
    END;
  END LOOP;
END;
/

-- 4. run_sql_tuning_advisor: DBMS_SQLTUNE exige el privilegio de sistema
--    ADVISOR (Java, sección 8). Es el más pesado de los tres: crea y borra
--    tareas del advisor.
GRANT ADVISOR TO DEVUSER;

-- DBMS_XPLAN.DISPLAY no necesita grant propio: EXECUTE sobre SYS.DBMS_XPLAN ya
-- es público. Solo PLAN_TABLE, V_$OBJECT_USAGE y ADVISOR hay que concedirlos.

SELECT owner, object_name, object_type
FROM all_objects
WHERE owner = 'DEVUSER' AND object_name = 'PLAN_TABLE';