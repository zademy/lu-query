# Cuellos de botella: deteccion y que hacer

Lista de verificacion para leer el plan de una sentencia. Cada punto dice como se
reconoce en el plan, que significa y cual es el arreglo. No son reglas de estilo:
un `TABLE ACCESS FULL` sobre la tabla de 12 filas de configuracion no es un
problema, y el mismo nodo sobre 2.5 millones de filas lo es.

## Que ve este arnes y que no

La guia de Oracle SQL Developer describe herramientas de una workstation con
GUI. Este arnes solo tiene MCP, asi que cada herramienta se cubre o se declara
fuera:

| Guia SQL Developer       | Aqui                                                                                                               | Nota                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Explain Plan             | `explain_plan`                                                                                                     | Devuelve el plan estimado tal cual, sin ejecutar.                                    |
| Autotrace (Statistics)   | `run_query` con `/*+ gather_plan_statistics */` y despues `DBMS_XPLAN.DISPLAY_CURSOR(NULL, NULL, 'ALLSTATS LAST')` | Da los reales: filas, tiempo, buffers, lecturas, ejecuciones.                        |
| Autotrace (Trace)        | No hay                                                                                                             | Habria que parsear el archivo `.trc`. Aqui no existe.                                |
| SQL Tuning Advisor       | `run_sql_tuning_advisor`                                                                                           | Informe en texto. Se puede usar como segunda opinion, nunca como veredicto.          |
| Real-Time SQL Monitoring | No hay                                                                                                             | Solo aplica mientras la sentencia corre, y aqui las llamadas son sincronas y cortas. |
| Histograma de columnas   | `get_histogram`                                                                                                    | Cuando un `E-Rows` se dispara, el histograma explica por que.                        |
| Indices sin usar         | `list_unused_indexes`                                                                                              | Para justificar indexados, no para crear.                                            |

Lo que este arnes no puede decir, y hay que decirlo en el reporte:

- **No hay concurrencia.** Las mediciones son de una sesion sola, sin carga. Un
  plan que gana aqui puede perder con 50 sesiones encima.
- **No hay cache limpio.** Las dos primeras repeticiones calientan y a partir de
  ahi se mide con todo en memoria. En produccion el buffer cache tambien esta
  tibio, asi que la lectura fisica del reporte tiende a estar por debajo de la real.
- **El plan medido no es el plan de produccion.** La sentencia lleva el hint
  `gather_plan_statistics` y viaja dentro de la envoltura que impone `run_query`
  (`SELECT * FROM (...) WHERE ROWNUM <= 1000`). Su `sql_id` y su
  `plan_hash_value` no son los de la sentencia sin instrumentar.

## Como leer el plan que devuelve este arnes

`explain_plan` devuelve texto plano con el formato `TYPICAL`: costo estimado,
`A-Rows` sale como `-Rows` porque no se ejecuto. Sirve para ver la forma del plan, no su
costo real.

Para ver el plan real hay que ejecutar con estadisticas y leer el cursor:

```sql
SELECT /*+ gather_plan_statistics */ ... ;
```

despues, sin volver a ejecutar nada:

```sql
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(NULL, NULL, 'ALLSTATS LAST'));
```

En `ALLSTATS LAST` cada linea trae `E-Rows` (estimado) y `A-Rows` (real), y
`A-Time` en microsegundos acumulados. La division de mil es cuenta del agente.

**Dos filas de ruido.** `run_query` envuelve toda sentencia en
`SELECT * FROM ( ... ) WHERE ROWNUM <= 1000`. En el plan salen dos nodos que no
son de la sentencia: `VIEW` y `COUNT STOPKEY`. Filtralos antes de comparar nada,
o vas a reportar como cuello de botella el mecanismo que corta el resultado.

## Checklist

### 1. Lectura completa de tabla grande

**Senal:** `TABLE ACCESS FULL` sobre una tabla de miles de filas y sin predicado
que lo justifique.
**Que significa:** no habia indice utilizable, o el optimizador hizo cuentas y le
convino el barrido. Con `INDEX ... FULL SCAN` el indice evita el acceso a tabla.
**Que hacer:** indexar la columna del predicado solo si la consulta lo pide
seguidamente. Con `A-Rows` pequenos contra un `E-Rows` enorme, el problema suele
estar antes en la estimacion.

### 2. Estimacion equivocada

**Senal:** `A-Rows` muy por encima o por debajo de `E-Rows`. Una diferencia de
un orden de magnitud ya es un problema.
**Que significa:** el optimizador eligio con numeros falsos. Toda decision que
sale de ahi es sospechosa: joins, orden de acceso, metodo de join.
**Que hacer:** `get_table_stats` y `get_column_stats` sobre la columna; si tiene
histograma, `get_histogram`. Un indice con estadisticas de columna suele ser
mejor que un indice nuevo.

### 3. Conversion implicita

**Senal en el plan:** el indice aparece como `INDEX ... FULL SCAN` donde se
esperaba `RANGE SCAN`, o `INDEX FAST FULL SCAN` sobre algo que deberia filtrar.
**Senal en la sentencia:** una funcion o una conversion sobre la columna del
`WHERE`: `TO_CHAR(fecha) = '2025-07'`, `TO_NUMBER(campo) = 42`,
`NVL(columna, x) = y`.
**Que significa:** al meter la columna en una funcion, el indice deja de
comparar contra la columna.
**Que hacer:** mover la funcion al otro lado. `TO_CHAR(fecha,'YYYY-MM') = '2025-07'`
se vuelve `fecha >= DATE '2025-07-01' AND fecha < DATE '2025-08-01'`. Un mes es
medio abierto a proposito: un indice de `DATE` no se puede usar con
truncamiento.

### 4. Indice ausente en la foranea

**Senal:** un `JOIN` donde el lado de la llave foranea no tiene indice.
**Que significa:** por cada fila del lado de afuera, Oracle busca en el lado de
adentro. Sin indice, cada busqueda es un barrido completo.
**Que hacer:** indexar la columna foranea. Es el indice mas barato que existe y
casi nunca se ha creado.

### 5. Indice que solo sirve en un sentido

**Senal:** el plan barre completo un puente many-to-many, o el puente entra por
la columna que no es leader de su indice.
**Que significa:** `PRIMARY KEY (a, b)` indexa `a` bien y `b` no. Las consultas
que llegan por `b` pagan el barrido completo sin poder evitarlo.
**Que hacer:** segundo indice en el sentido que falta. En un puente la pregunta
correcta es que sentidos consulta el sistema: los dos.

### 6. `NOT IN` con un `NULL` en la subconsulta

**Senal:** el plan estima muchisimas filas y `A-Rows` sale en cero o casi cero.
**Que significa:** `x NOT IN (SELECT y ...)` donde `y` trae un `NULL` no
devuelve las filas que no estan en la lista: devuelve **cero filas**, porque
`x <> NULL` es desconocido para todas. El optimizador lo sabe y por eso estima
mal: esta leyendo un defecto de la sentencia, no del indice.
**Que hacer:** reescribir como `NOT EXISTS` con correlacion. `NOT EXISTS` trata
el `NULL` como lo que es, una ausencia de dato, y ademas se puede convertir en
anti-join en vez de un anti-join materializado.

```sql
-- Devuelve cero filas si y trae un NULL.
WHERE x NOT IN (SELECT y FROM t)
-- Devuelve las correctas.
WHERE NOT EXISTS (SELECT 1 FROM t WHERE t.y = x)
```

### 7. Subconsulta correlacionada en la lista de seleccion

**Senal:** `A-Rows` de la filaPadre multiplicado por `Starts` de la filaHijo, o
un `Starts` grande en un nodo por debajo de la fila final.
**Que significa:** se evalua una vez por fila de salida. Si la fila de salida se
repite, el trabajo se repite con ella.
**Que hacer:** subirla a un `JOIN` contra una rama agregada
(`LEFT JOIN (SELECT clave, MAX(...) FROM t GROUP BY clave) r ON r.clave = ...`).
El valor es el mismo y se calcula una vez por clave.

### 8. Multiplicacion de filas

**Senal:** `A-Rows` de la fila final muy por encima de la suma de las filas que
entran, sin que haya ninguna fila repetida en la salida.
**Que significa:** un join de uno a muchos multiplica. Con dos puentes en cadena
se multiplica dos veces.
**Que hacer:** acotar la rama que multiplica antes de unir (`EXISTS` en vez de
`JOIN` si las columnas del puente no se usan), o agregar `DISTINCT` como ultimo
recurso y asumir su costo.

### 9. `DISTINCT` u `ORDER BY` sobre expresion

**Senal:** `SORT ORDER BY`, `SORT UNIQUE` o `SORT GROUP BY` con `A-Rows` altos,
sobre todo en el nodo raiz.
**Que significa:** el optimizador no puede aprovechar el orden de un indice y
monta un clasificador. `DISTINCT` encima de un join multiplicado es la forma mas
cara de convertir un problema en otro.
**Que hacer:** quitar la expresion cuando la columna es `NOT NULL`
(`ORDER BY NVL(col,'')`, `ORDER BY col`), o quitar el `DISTINCT` atacando la causa
del punto 8.

### 10. Hash join donde se esperaba nested loops

**Senal:** `HASH JOIN` con `E-Rows` de miles de filas por lado.
**Que significa:** el optimizador apuesta a que las dos entradas caben en memoria.
Si no caben, hay derrames a disco temporal y la apuesta sale cara.
**Que hacer:** con `A-Rows` de miles y `E-Rows` de miles, casi siempre el problema
es la estimacion del punto 2, no el metodo de join.

### 11. `SORT` enorme por un `ORDER BY` que nadie necesita

**Senal:** `SORT ORDER BY` en el nodo raiz y ningun `FETCH FIRST` debajo.
**Que significa:** se ordenan todas las filas para que el consumidor lea las
primeras.
**Que hacer:** `FETCH FIRST n ROWS ONLY`. Y si el orden no importa para el
resultado, quitarlo entero: es la forma mas barata de ganar.

### 12. Estadisticas viejas o ausentes

**Senal:** `E-Rows` en miles sobre una tabla de millones, o `last_analyzed` muy
antiguo.
**Que significa:** el optimizador no tiene con que trabajar.
**Que hacer:** antes de crear cualquier indice, gathering de estadisticas. Es la
intervencion mas barata de la lista y la que mas se salta.

## Orden de ataque

No empieces por los indices. En este orden casi siempre se gasta menos:

1. Estadisticas (12).
2. Correccion de la estimacion (2).
3. Predicados sargables (3, 9, 11).
4. Subconsultas correlacionadas (7) y multiplicacion (8).
5. `NOT IN` a `NOT EXISTS` (6).
6. Indices ausentes (4) y de sentido faltante (5).
7. Lo demas, si sigue doliendo.
