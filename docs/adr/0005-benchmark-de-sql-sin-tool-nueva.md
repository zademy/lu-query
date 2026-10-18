# El benchmark de SQL se arma con las tools que ya hay, sin agregar ninguna

Medir una consulta antes y despues suena a que pide una tool nueva: algo tipo
`measure_sql(sql, repeticiones)` que ejecute, recoja estadisticas reales y
devuelva el resumen. Se decidio no hacerlo. La razon no es purismo de paridad,
es que las tres piezas que harían falta ya se pueden componer con lo existente y
verificadas una por una contra la base:

1. **El plan estimado sale verbatim de `explain_plan`.** Devuelve el plan de la
   sentencia tal cual la escribio el usuario, sin la envoltura que las tools de
   lectura agregaround, y sin ejecutarla. Con eso se ve la forma del plan antes de
   tocar nada.
2. **El plan real sale de dos llamadas que ya existen.** `run_query` con el hint
   `gather_plan_statistics` seguido de `run_query` sobre
   `DBMS_XPLAN.DISPLAY_CURSOR(NULL, NULL, 'ALLSTATS LAST')` devuelve `A-Rows`,
   `A-Time`, `Buffers`, `Reads` y `Starts`. El hint no es opcional: con
   `statistics_level = TYPICAL`, que es el default, `ALLSTATS LAST` vuelve sin
   `A-Rows` alguno. El `NULL, NULL` de `DISPLAY_CURSOR` reporta la ultima
   sentencia de la sesion, asi que las dos llamadas no se pueden separar por nada
   en medio.
3. **La serie temporal sale repitiendo, no preguntando.** Diez pares de llamadas
   dan diez puntos. No hace falta una tool que "mida N veces" porque N veces es
   simplemente N llamadas.

Una tool nueva habria anadido superficie publica, un contrato que mantener y una
decima de entrada en el catalogo, a cambio de empaquetar tres llamadas que ya
funcionan. El costo de una tool es permanente; el de una instruccion en el
`SKILL.md` es una edicion.

## El limite que si obliga a resolverlo: las 1000 filas

`run_query` envuelve toda lectura en `SELECT * FROM (...) WHERE ROWNUM <= 1000` y
no tiene forma de evitarlo. Comparar los resultados fila por fila solo compararia
las primeras mil de decenas de miles: daria un "coincide" sin informacion. La
integridad deja de verificarse sobre una muestra y pasa a verificarse sobre el
conjunto entero mediante una **huella de resultado**: un `COUNT(*)` mas un
`SUM(ORA_HASH(...))` de todas las columnas del `SELECT`, que se le pide a la base
como una sola fila. Los nombres de columna ya los devolvio `run_query` en la
primera llamada, asi que no hay que adivinarlos.

`ORA_HASH` es de 32 bits y colisiona. Por eso el reporte dice `coincide` o `no
coincide` y nunca `correcto`.

## Consecuencias

- Esto es una extension de la paridad, no parte de ella: el server no cambia,
  `src/` y `test/` quedan intactos y el paquete npm ya publica `skills/`.
- Una tool nueva si se justificaria si hiciera falta medir concurrencia, leer
  `V$SQL` de otras sesiones o comparar planes con binds de verdad. Nada de eso cabe
  en dos llamadas.
- Las mediciones son de una sesion sola, sin carga y con cache caliente. El
  reporte lo declara en la cara, no en el pie.
- La aritmetica (medianas, factores, veredicto de la huella) la hace
  `bench-report.mjs`, no el agente. Un redondeo del agente en un numero que se lee
  como medicion de Oracle es el modo de fallo mas caro de esta skill.
- El plan medido lleva el hint y viaja dentro de la envoltura de tope: su `sql_id`
  y su `plan_hash_value` no son los de produccion, y el reporte lo dice.
