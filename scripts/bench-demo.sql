-- Query de prueba de la skill lu-query-benchmark-sql.
--
-- Son la MISMA consulta en dos versiones. Las dos devuelven exactamente las mismas
-- filas: la diferencia esta en como llega a ellas. Eso es lo que hace comparables las
-- dos y lo que permite exigir que la huella de resultado coincida.
--
-- Usa el esquema del seed: scripts/seed-bench.sql
--
-- MEDIDO en Oracle 26ai Free, 10 repeticiones, mediana de la 8 despues de 2 de
-- calentamiento. Se recorrio primero con filtro de mes y no habia diferencia
-- medible: con 82,000 de 2,500,000 ordenes el predicado no es selectivo y el
-- optimizador elige barrido completo en las dos versiones, para bien y para mal.
-- El filtro de un dia deja 3,424 ordenes, que si es selectivo.
--
--   ANTES     430 ms   68,695 buffers   20,426 lecturas
--   DESPUES   300 ms   68,695 buffers   20,426 lecturas
--   1.43x en tiempo, 1.00x en buffers y lecturas.
--
-- Y esa ultima linea es el hallazgo, no un fallo: los dos planes hacen el mismo
-- acceso a datos, asi que la ganancia es de CPU por fila, no de I/O. Lo que se
-- paga aqui es la evaluacion de una funcion por fila de la tabla de 2.5M.
-- Un reporte honesto dice eso. Uno que promete 5x por un indice que no se cambio
-- esta inventando.

-- Lo que se rompe a proposito en la version lenta, y que se comprobó en el plan:
--
--   1. TO_CHAR(o.created_at, 'YYYY-MM-DD') = '2025-07-15'
--      Conversion implicita. En el plan sale literal:
--      filter(TO_CHAR(INTERNAL_FUNCTION("O"."CREATED_AT"),'YYYY-MM-DD')='2025-07-15')
--      Envuelve la columna, asi que BENCH_ORD_CREATED_IX no puede usarse ni por
--      igualdad ni por rango. Oracle evalua el TO_CHAR por cada una de los 2.5M
--      renglones de la tabla. Ese es el costo que se mide.
--
--   2. NVL(o.status, 'NULO') = 'PAID'
--      Funcion sobre la columna del predicado. Aqui no cuesta casi nada porque
--      no hay indice por status, pero deja el campo preparado para el dia que si
--      lo haya, y ese dia el indice no serviria. Se deja a proposito para que el
--      reporte muestre un defecto real que no paga: no todos los antipatrones
--      que se ven en el codigo cuestan algo.
--
--   3. ORDER BY NVL(o.shipping_country, '')
--      Impide el index-ordered scan aunque el indice este disponible.
--      shipping_country es CHAR(2) NOT NULL, asi que el NVL nunca devolvio otra
--      cosa que la columna.Tampoco cuesta aqui porque el plan ordenaba igual.
--
--   4. (SELECT MAX(r.amount) FROM BENCH_REFUNDS r WHERE r.order_id = oi.order_id)
--      Iba en la lista de este archivo como cuarto defecto y resulto ser falso:
--      el optimizador ya la decorrelaciona. El plan lo delata, trae
--      VIEW VW_SSQ_1 con HASH GROUP BY debajo y despues HASH JOIN OUTER, o sea
--      ya estaba calculando la MAX por orden una sola vez. Reescribirla a mano no
--      gana nada. Se deja la subconsulta en las dos versiones y se deja escrito que
--      no costaba, porque el caso de "el plan dice otra cosa de lo que creia el
--      codigo" es justo el que un arnes como este existe para detectar.
--
-- Lo que NO lleva la version lenta a proposito: NOT IN con un NULL dentro, que
-- devuelve cero filas en lugar de las correctas. Ese es un defecto de correccion,
-- no de rendimiento, y para medir velocidad hay que conservar el resultado. Esta
-- documentado con su arreglo en references/bottlenecks.md de la skill.


-- =====================================================================
-- 01-original.sql   (la que se mide como "antes")
-- =====================================================================

SELECT o.order_id,
       o.order_ref,
       o.created_at,
       c.full_name,
       w.warehouse_code,
       oi.line_num,
       oi.quantity,
       oi.unit_price,
       p.sku,
       p.name           AS product_name,
       pc.category_id,
       (SELECT MAX(r.amount)
          FROM BENCH_REFUNDS r
         WHERE r.order_id = oi.order_id) AS mayor_devolucion,
       oi.quantity * oi.unit_price     AS bruto
  FROM BENCH_ORDERS o
  JOIN BENCH_CUSTOMERS c        ON c.customer_id  = o.customer_id
  JOIN BENCH_WAREHOUSES w       ON w.warehouse_id = o.warehouse_id
  JOIN BENCH_ORDER_ITEMS oi     ON oi.order_id    = o.order_id
  JOIN BENCH_PRODUCTS p         ON p.product_id   = oi.product_id
  JOIN BENCH_PRODUCT_CATEGORIES pc ON pc.product_id = oi.product_id
 WHERE TO_CHAR(o.created_at, 'YYYY-MM-DD') = '2025-07-15'
   AND NVL(o.status, 'NULO') = 'PAID'
 ORDER BY NVL(o.shipping_country, ''), o.order_id, oi.line_num;


-- =====================================================================
-- 02-optimizado.sql   (la que se mide como "despues")
-- =====================================================================
-- Mismo resultado, mismas filas, mismo orden. El dia se acota con un rango: la
-- columna queda comparable y BENCH_ORD_CREATED_IX vuelve a ser una opcion. La
-- subconsulta se sube a una rama agrupada para que el proposito se lea en el
-- SQL, no porque aqui haya ganado nada.

SELECT o.order_id,
       o.order_ref,
       o.created_at,
       c.full_name,
       w.warehouse_code,
       oi.line_num,
       oi.quantity,
       oi.unit_price,
       p.sku,
       p.name           AS product_name,
       pc.category_id,
       r.mayor_devolucion,
       oi.quantity * oi.unit_price AS bruto
  FROM BENCH_ORDERS o
  JOIN BENCH_CUSTOMERS c    ON c.customer_id  = o.customer_id
  JOIN BENCH_WAREHOUSES w   ON w.warehouse_id = o.warehouse_id
  JOIN BENCH_ORDER_ITEMS oi ON oi.order_id    = o.order_id
  JOIN BENCH_PRODUCTS p     ON p.product_id   = oi.product_id
  JOIN BENCH_PRODUCT_CATEGORIES pc ON pc.product_id = oi.product_id
  LEFT JOIN (SELECT order_id, MAX(amount) AS mayor_devolucion
               FROM BENCH_REFUNDS
              GROUP BY order_id) r ON r.order_id = oi.order_id
 WHERE o.created_at >= DATE '2025-07-15'
   AND o.created_at <  DATE '2025-07-16'
   AND o.status = 'PAID'
 ORDER BY o.shipping_country, o.order_id, oi.line_num;
