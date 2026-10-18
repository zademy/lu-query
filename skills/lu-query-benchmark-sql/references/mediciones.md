# El contrato de 04-mediciones.json

El agente ejecuta las sentencias y transcribe lo que le devolvieron las tools.
`bench-report.mjs` se encarga de toda la aritmetica: medianas, veredicto de la
huella y factores. Si el agente los calculara a mano, un redondeo suyo se leeria
como si fuera una medicion de Oracle.

## Forma completa

```json
{
  "meta": {
    "queryName": "pedidos de julio por linea",
    "sourceFile": "/ruta/a/consulta.sql",
    "repetitions": 10,
    "warmup": 2,
    "serverVersion": "2.16.3",
    "database": "Oracle Database 26ai Free Release 23.26.3.0.0-0",
    "generatedAt": "2026-10-18T13:40:00-06:00",
    "caveats": [
      "La sentencia medida lleva el hint gather_plan_statistics.",
      "run_query la envuelve en SELECT * FROM (...) WHERE ROWNUM <= 1000.",
      "Medicion de una sola sesion, sin concurrencia."
    ]
  },
  "original": {
    "sql": "SELECT ...",
    "plan": "texto plano del plan, tal cual lo devuelve la tool",
    "fingerprint": { "rows": 71543, "checksum": -1846230577 },
    "samples": [
      { "rep": 1, "ms": 4821.3, "buffers": 2104382, "reads": 981220 },
      { "rep": 2, "ms": 4102.7, "buffers": 1988004, "reads": 903118 }
    ]
  },
  "optimized": {
    "sql": "SELECT ...",
    "plan": "...",
    "fingerprint": { "rows": 71543, "checksum": -1846230577 },
    "samples": [{ "rep": 1, "ms": 214.5, "buffers": 91204, "reads": 0 }]
  },
  "findings": [
    {
      "severity": "alta",
      "title": "Conversion implicita sobre la fecha indexada",
      "detail": "TO_CHAR(fecha,'YYYY-MM') impide el uso de BENCH_ORD_CREATED_IX.",
      "evidence": "TABLE ACCESS FULL en BENCH_ORDERS, 3180 bloques leidos.",
      "fix": "Comparar contra un rango: fecha >= DATE '2025-07-01' AND fecha < DATE '2025-08-01'."
    }
  ],
  "errors": [
    {
      "step": "ejecucion de la version optimizada",
      "message": "ORA-00904: \"X\": identificador no valido"
    }
  ]
}
```

## Reglas

1. **`samples` va ordenado por `rep` ascendente y completo.** Si una repeticion
   fallo, no existe: se deja el hueco y el reporte lo dira. No se rellena.
2. **`ms` es el `A-Time` de la fila raiz convertido a milisegundos.** Oracle lo da
   en microsegundos acumulados en toda la fila.
3. **`buffers` y `reads` son los de la fila raiz.** Las demas filas tambien traen
   los suyos, y sumarlos contaria el mismo trabajo varias veces. La fila raiz es la
   ultima del plan, la que no tiene `Id` con letra, la que cierra el `SELECT`.
   Las otras 9 repeticiones se miden con esos tres numeros y nada mas.
4. **`plan` es el plan de la repeticion 1**, la de cache fria. Es el unico donde se
   ven las lecturas fisicas, y es el que se analiza para los cuellos de botella.
5. **`fingerprint.checksum` puede ser negativo.** Es un `SUM(ORA_HASH(...))` sobre
   la tabla entera. Lo que importa es que sea igual en las dos versiones.
6. **`caveats` no es opcional.** Un reporte de benchmark sin sus limites se lee
   como si estuviera midiendo produccion. Si no hay ninguno, casi seguro se
   olvido alguno.
7. **`errors` va vacio si no hubo errores.** Un error tragado es peor que un hueco:
   el reporte lo muestra con el paso que fallo y el mensaje de Oracle tal cual.

## Como se saca la huella de resultado

`run_query` corta en 1000 filas, asi que comparar resultados fila por fila no dice
nada sobre las 70,000 que devolvio la sentencia. En vez de eso se pide a la base
un resumen de una sola fila:

```sql
SELECT COUNT(*) AS filas,
       SUM(ORA_HASH(col_a || '|' || col_b || '|' || col_c)) AS checksum
  FROM ( <la sentencia, sin ORDER BY y sin el ROWNUM> );
```

Detalles que importan:

- **Sin `ORDER BY`.** El orden de la consulta original no es parte del conjunto de
  resultado, y ordenar 70,000 filas para tirar el orden despues es puro costo.
- **La lista de columnas es la de la sentencia.** `run_query` ya la devolvio en el
  primer `samples`; no hay que adivinarla. Las columnas `DATE` se pasan por
  `TO_CHAR` con un formato fijo, para que dos filas con la misma fecha den el mismo
  texto. Las `NULL` hay que concatenarlas con una marca fija
  (`NVL(col,'\u0000')`), porque en Oracle `||` trata el NULL como cadena vacia y
  `1` y `NULL` darian el mismo texto.
- **El `SELECT` de la huella tiene que ser solo de tipo `SELECT`.** Por eso se
  envuelve la sentencia en una subconsulta: si trae `ORDER BY`, Oracle lo acepta
  dentro de un `INLINE VIEW`.
- **El cap sigue aplicando**, pero la huella devuelve una sola fila, asi que da
  igual.

Que coincida la huella significa que las dos versiones devuelven el mismo conjunto.
No significa que este correcto: `ORA_HASH` es de 32 bits y colisiona. El reporte
dice `coincide` o `no coincide`, nunca `correcto`.

## indexRecommendations

Optional top-level array, populated by the agent from the measured plan and catalog evidence. Older reports without it display “No se registró una revisión de índices”. An empty array means no recommendations were recorded, not that all indexes are healthy.

Each entry has string fields: title, table, index (optional), explanation, evidence, suggestion, tradeoff, validation, sql (optional, displayed only). status is candidate (untested idea), query (predicate/rewrite issue), review (existing index needs investigation), or measured (change actually tested, with before/after evidence). Never use measured for an unexecuted DDL. The renderer preserves these findings; it does not infer index suitability from table timings.

Example, illustrative only; replace with evidence from the current run:

```json
{
  "indexRecommendations": [
    {
      "status": "query",
      "title": "Buscar la fecha sin cambiar su forma",
      "table": "ORDERS",
      "explanation": "El índice guarda fechas. Convertir cada fecha en texto puede impedir buscar directamente en él.",
      "evidence": "Registrar aquí el predicado y la definición real del índice.",
      "suggestion": "Probar un rango de fechas con los mismos límites.",
      "tradeoff": "Hay que conservar la zona horaria y los límites del día.",
      "validation": "Comparar resultados y repetir las mediciones; comprobar el nuevo plan."
    }
  ]
}
```
