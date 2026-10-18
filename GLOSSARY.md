# lu-query

Servidor MCP que expone una base de datos Oracle como tools a clientes MCP, con paridad 1:1 con el servidor Java `mcp-oracle-db`. Este glosario fija el vocabulario del proyecto.

## Lenguaje

**Tool**:
Operación MCP expuesta al cliente (run_query, describe_table, …) sobre la base Oracle.
_Avoid_: comando, endpoint, función

**Paridad**:
Equivalencia conductual 1:1 con `mcp-oracle-db` (Java): el contrato de cada tool se decide contra su firma Java original.
_Avoid_: compatibilidad, fidelidad

**Chokepoint**:
El único paso por el que atraviesan todas las sentencias SQL del server; ahí se aplican auditoría, timeouts y commit.
_Avoid_: repositorio, DAO, capa de datos

**Archivo de auditoría de sesión**:
Registro Markdown, uno por sesión del server, con una entrada por sentencia que atravesó el chokepoint (tool, kind, type, duración, filas, SQL verbatim).
_Avoid_: log JSON, audit log a secas

**Kind**:
Familia sintáctica de una sentencia SQL (SELECT, INSERT, CREATE, BEGIN…): el primer token en mayúsculas.
_Avoid_: tipo de sentencia (se confunde con Type)

**Type**:
Efecto de una sentencia sobre los datos (READ, WRITE u OTHER); se deriva del kind.
_Avoid_: modo, categoría

**Capped select**:
SELECT de lectura envuelto en paginación (OFFSET/FETCH) que limita las filas que devuelve el server.
_Avoid_: paginación manual, límite de filas

**Barrera de mínimos privilegios**:
Segunda línea de defensa de las tools de lectura: rechazan sentencias que no son SELECT aunque el usuario de BD tuviera permisos para más.
_Avoid_: validación SQL, filtro SQL

**Schema de sesión**:
El schema vigente de la sesión Oracle (CURRENT_SCHEMA) cuando ni la tool ni la configuración especifican uno.
_Avoid_: schema por defecto, schema del usuario

**Skill**:
Carpeta opcional con un `SKILL.md` que enseña a un agente cómo usar este server por tarea (explorar, consultar, auditar, cambiar, afinar, diagnosticar). Se copia al directorio de skills del agente; no se instala sola.
_Avoid_: documentación de la API, tutorial, plugin

**Ejemplo verificado**:
Tool call reproducida contra una base real, con su salida real citada; se distingue de la cobertura meramente documental.
_Avoid_: ejemplo inventado, snippet ilustrativo

**Reporte de auditoría**:
HTML autogenerado que resume las sentencias registradas en los archivos de auditoría dentro de una ventana de reporte; se produce leyendo los `.md`, sin tocar la base de datos.
_Avoid_: dashboard, export de auditoría, informe de una ejecución

**Ventana del reporte**:
Rango de fechas en `dd/mm/aaaa`, inclusivo y de un mes como máximo, que delimita qué entradas entran al reporte de auditoría.
_Avoid_: periodo, rango de ejecución, filtro de sesión

**Huella de resultado**:
Resumen de una sola fila (COUNT y checksum) que resume el conjunto completo que devolvio una sentencia, para poder compararlo con el de otra version cuando la tool corta la lectura a 1000 filas.
_Avoid_: muestra, comparacion de filas

**Repeticion**:
Una ejecucion completa de la sentencia medida. Un benchmark repite la sentencia N veces y compara medianas, no medias: las primeras son calentamiento de cache y si se promedian ocultan el resultado.
_Avoid_: iteracion, pasada, muestra

**Envolvente de tope**:
El SELECT que el server envuelve alrededor de toda lectura para limitarla a 1000 filas. No es parte de la sentencia del usuario pero aparece en su plan medido, asi que hay que filtrarla antes de analizarlo.
_Avoid_: cap, limitador, paginacion

