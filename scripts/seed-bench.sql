-- Seed de benchmark: marketplace de retail multi-almacen.
--
-- Aporta ~12.9M filas en 11 tablas con PK, FK y dos puentes M2M, para que la skill
-- lu-query-benchmark-sql tenga algo real que medir y con que comparar resultados.
--
-- El generador es deterministico (LCG congruencial, no DBMS_RANDOM): correrlo dos
-- veces produce el mismo contenido fila por fila. Sin eso la huella de resultado de
-- la comparacion antes/despues no valdria nada.
--
-- Uso (usuario con CREATE ANY TABLE). El argumento BORRAR solo se liga si el script
-- entra como archivo de sqlplus; por eso el orden importa:
--   sqlplus -s DEVUSER/***@FREEPDB1 @scripts/seed-bench.sql BORRAR
--
-- Contra el contenedor de desarrollo:
--   docker cp scripts/seed-bench.sql oracle-26ai-free:/tmp/
--   docker exec -it oracle-26ai-free bash -c \
--     "sqlplus -s DEVUSER/***@FREEPDB1 @/tmp/seed-bench.sql BORRAR"
--
-- No se usa CREATE USER: el usuario de pruebas no tiene ese privilegio, asi que
-- el esquema vive como prefijo BENCH_ dentro del schema actual.

WHENEVER SQLERROR EXIT SQL.SQLCODE
SET DEFINE ON

PROMPT === 0/13  Limpieza (solo con el argumento BORRAR) ===
DECLARE
  v_confirm VARCHAR2(16) := '&1';
  v_count   PLS_INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM user_tables
  WHERE table_name LIKE 'BENCH!_%' ESCAPE '!';

  IF v_confirm = 'BORRAR' THEN
    FOR t IN (SELECT table_name FROM user_tables WHERE table_name LIKE 'BENCH!_%' ESCAPE '!') LOOP
      EXECUTE IMMEDIATE 'DROP TABLE "' || t.table_name || '" CASCADE CONSTRAINTS PURGE';
    END LOOP;
    dbms_output.put_line('Borradas ' || v_count || ' tablas BENCH_*.');
  ELSIF v_count > 0 THEN
    dbms_output.put_line('Ya existen ' || v_count || ' tablas BENCH_*. Se conservan.');
    dbms_output.put_line('Para empezar de cero:  sqlplus -s usuario/clave @scripts/seed-bench.sql BORRAR');
  END IF;
END;
/

PROMPT === 1/13  Tablas ===
CREATE TABLE BENCH_WAREHOUSES (
  warehouse_id   NUMBER(4)    NOT NULL,
  warehouse_code VARCHAR2(12) NOT NULL,
  name           VARCHAR2(60) NOT NULL,
  region         VARCHAR2(30),
  opened_on      DATE         NOT NULL,
  CONSTRAINT BENCH_WAR_PK PRIMARY KEY (warehouse_id)
);

CREATE TABLE BENCH_CUSTOMERS (
  customer_id NUMBER(10)    NOT NULL,
  email       VARCHAR2(120) NOT NULL,
  full_name   VARCHAR2(120) NOT NULL,
  country     CHAR(2)       NOT NULL,
  created_at  DATE          NOT NULL,
  CONSTRAINT BENCH_CUS_PK PRIMARY KEY (customer_id)
);

CREATE TABLE BENCH_ADDRESSES (
  address_id   NUMBER(10)  NOT NULL,
  customer_id  NUMBER(10)  NOT NULL,
  address_kind VARCHAR2(12),
  city         VARCHAR2(60),
  country      CHAR(2),
  postal_code  VARCHAR2(12),
  CONSTRAINT BENCH_ADR_PK PRIMARY KEY (address_id),
  CONSTRAINT BENCH_ADR_CUS_FK FOREIGN KEY (customer_id)
    REFERENCES BENCH_CUSTOMERS (customer_id)
);

CREATE TABLE BENCH_CATEGORIES (
  category_id NUMBER(10)  NOT NULL,
  parent_id   NUMBER(10),
  name        VARCHAR2(80) NOT NULL,
  depth       NUMBER(2)   NOT NULL,
  CONSTRAINT BENCH_CAT_PK PRIMARY KEY (category_id)
);

CREATE TABLE BENCH_SELLERS (
  seller_id       NUMBER(10)    NOT NULL,
  seller_name     VARCHAR2(120) NOT NULL,
  warehouse_id    NUMBER(4)     NOT NULL,
  hired_on        DATE          NOT NULL,
  commission_rate NUMBER(5,2)   NOT NULL,
  CONSTRAINT BENCH_SEL_PK PRIMARY KEY (seller_id),
  CONSTRAINT BENCH_SEL_WAR_FK FOREIGN KEY (warehouse_id)
    REFERENCES BENCH_WAREHOUSES (warehouse_id)
);

CREATE TABLE BENCH_PRODUCTS (
  product_id  NUMBER(10)    NOT NULL,
  sku         VARCHAR2(32)  NOT NULL,
  name        VARCHAR2(160) NOT NULL,
  category_id NUMBER(10)    NOT NULL,
  seller_id   NUMBER(10)    NOT NULL,
  list_price  NUMBER(10,2)  NOT NULL,
  active      CHAR(1)       NOT NULL,
  created_at  DATE          NOT NULL,
  CONSTRAINT BENCH_PRO_PK PRIMARY KEY (product_id),
  CONSTRAINT BENCH_PRO_CAT_FK FOREIGN KEY (category_id)
    REFERENCES BENCH_CATEGORIES (category_id),
  CONSTRAINT BENCH_PRO_SEL_FK FOREIGN KEY (seller_id)
    REFERENCES BENCH_SELLERS (seller_id)
);

-- Puente M2M productos<->categorias. La PK (product_id, category_id) deja product_id
-- como columna leader: el indice sirve para "categorias de un producto" y NO para
-- "productos de una categoria". Es el hueco que hace caro el benchmark.
CREATE TABLE BENCH_PRODUCT_CATEGORIES (
  product_id  NUMBER(10) NOT NULL,
  category_id NUMBER(10) NOT NULL,
  CONSTRAINT BENCH_PCAT_PK PRIMARY KEY (product_id, category_id),
  CONSTRAINT BENCH_PCAT_PRO_FK FOREIGN KEY (product_id)
    REFERENCES BENCH_PRODUCTS (product_id),
  CONSTRAINT BENCH_PCAT_CAT_FK FOREIGN KEY (category_id)
    REFERENCES BENCH_CATEGORIES (category_id)
);

CREATE TABLE BENCH_ORDERS (
  order_id         NUMBER(10)    NOT NULL,
  order_ref        VARCHAR2(24)  NOT NULL,
  customer_id      NUMBER(10)    NOT NULL,
  seller_id        NUMBER(10)    NOT NULL,
  warehouse_id     NUMBER(4)     NOT NULL,
  status           VARCHAR2(16)  NOT NULL,
  shipping_country CHAR(2)       NOT NULL,
  created_at       DATE          NOT NULL,
  total_amount     NUMBER(12,2)  NOT NULL,
  CONSTRAINT BENCH_ORD_PK PRIMARY KEY (order_id),
  CONSTRAINT BENCH_ORD_CUS_FK FOREIGN KEY (customer_id)
    REFERENCES BENCH_CUSTOMERS (customer_id),
  CONSTRAINT BENCH_ORD_SEL_FK FOREIGN KEY (seller_id)
    REFERENCES BENCH_SELLERS (seller_id),
  CONSTRAINT BENCH_ORD_WAR_FK FOREIGN KEY (warehouse_id)
    REFERENCES BENCH_WAREHOUSES (warehouse_id)
);

-- Puente M2M ordenes<->productos. Misma trampa que el puente anterior: la PK
-- (order_id, line_num) sirve en un sentido y el otro no lo tiene.
CREATE TABLE BENCH_ORDER_ITEMS (
  order_id     NUMBER(10)   NOT NULL,
  line_num     NUMBER(3)    NOT NULL,
  product_id   NUMBER(10)   NOT NULL,
  quantity     NUMBER(5)    NOT NULL,
  unit_price   NUMBER(10,2) NOT NULL,
  discount_pct NUMBER(5,2),
  CONSTRAINT BENCH_OIT_PK PRIMARY KEY (order_id, line_num),
  CONSTRAINT BENCH_OIT_ORD_FK FOREIGN KEY (order_id)
    REFERENCES BENCH_ORDERS (order_id),
  CONSTRAINT BENCH_OIT_PRO_FK FOREIGN KEY (product_id)
    REFERENCES BENCH_PRODUCTS (product_id)
);

-- Stock por producto y almacen: doble FK, indice que solo sirve un sentido.
CREATE TABLE BENCH_INVENTORY (
  product_id    NUMBER(10) NOT NULL,
  warehouse_id  NUMBER(4)  NOT NULL,
  qty_on_hand   NUMBER(9)  NOT NULL,
  qty_reserved  NUMBER(9)  NOT NULL,
  reorder_point NUMBER(9)  NOT NULL,
  CONSTRAINT BENCH_INV_PK PRIMARY KEY (product_id, warehouse_id),
  CONSTRAINT BENCH_INV_PRO_FK FOREIGN KEY (product_id)
    REFERENCES BENCH_PRODUCTS (product_id),
  CONSTRAINT BENCH_INV_WAR_FK FOREIGN KEY (warehouse_id)
    REFERENCES BENCH_WAREHOUSES (warehouse_id)
);

CREATE TABLE BENCH_REFUNDS (
  refund_id    NUMBER(10)   NOT NULL,
  order_id     NUMBER(10)   NOT NULL,
  refunded_at  DATE         NOT NULL,
  amount       NUMBER(12,2) NOT NULL,
  reason       VARCHAR2(60) NOT NULL,
  processed_by VARCHAR2(120),
  CONSTRAINT BENCH_REF_PK PRIMARY KEY (refund_id),
  CONSTRAINT BENCH_REF_ORD_FK FOREIGN KEY (order_id)
    REFERENCES BENCH_ORDERS (order_id)
);

-- La jerarquia se valida al final: con 300 filas el costo es nulo y asi el generador
-- no tiene que respetar el orden de insercion.
ALTER TABLE BENCH_CATEGORIES ADD CONSTRAINT BENCH_CAT_PAR_FK
  FOREIGN KEY (parent_id) REFERENCES BENCH_CATEGORIES (category_id);

CREATE INDEX BENCH_ORD_CREATED_IX ON BENCH_ORDERS (created_at);
CREATE INDEX BENCH_ORD_CUS_IX     ON BENCH_ORDERS (customer_id);
CREATE INDEX BENCH_REF_ORD_IX     ON BENCH_REFUNDS (order_id);
CREATE INDEX BENCH_INV_WAR_IX     ON BENCH_INVENTORY (warehouse_id);
CREATE INDEX BENCH_PCAT_CAT_IX    ON BENCH_PRODUCT_CATEGORIES (category_id);

PROMPT === 2/13  12 almacenes (los 10, 11 y 12 no tienen region: la trampa del NOT IN) ===
INSERT INTO BENCH_WAREHOUSES (warehouse_id, warehouse_code, name, region, opened_on)
  SELECT LEVEL,
         'WH-' || LPAD(LEVEL, 2, '0'),
         'Centro ' || LEVEL,
         CASE WHEN LEVEL <= 9 THEN CASE MOD(LEVEL, 3) WHEN 0 THEN 'Norte' ELSE 'Sur' END END,
         DATE '2015-01-01' + LEVEL * 97
  FROM dual
  CONNECT BY LEVEL <= 12;

PROMPT === 3/13  2,000 vendedores ===
INSERT /*+ APPEND */ INTO BENCH_SELLERS
  (seller_id, seller_name, warehouse_id, hired_on, commission_rate)
  SELECT LEVEL,
         'Vendedor ' || LPAD(LEVEL, 5, '0'),
         MOD(LEVEL - 1, 12) + 1,
         DATE '2016-01-01' + MOD(LEVEL * 11, 3000),
         MOD(LEVEL * 7, 900) / 100
  FROM dual
  CONNECT BY LEVEL <= 2000;

PROMPT === 4/13  50,000 clientes ===
INSERT /*+ APPEND */ INTO BENCH_CUSTOMERS
  (customer_id, email, full_name, country, created_at)
  SELECT LEVEL,
         'cliente' || LEVEL || '@ejemplo.mx',
         'Cliente ' || LPAD(LEVEL, 6, '0'),
         CASE MOD(LEVEL * 13, 6) WHEN 0 THEN 'MX' WHEN 1 THEN 'US' WHEN 2 THEN 'CA'
                                  WHEN 3 THEN 'ES' WHEN 4 THEN 'AR' ELSE 'CL' END,
         DATE '2020-01-01' + MOD(LEVEL * 97, 1826)
  FROM dual
  CONNECT BY LEVEL <= 50000;

PROMPT === 5/13  80,000 direcciones ===
INSERT /*+ APPEND */ INTO BENCH_ADDRESSES
  (address_id, customer_id, address_kind, city, country, postal_code)
  SELECT LEVEL,
         MOD(LEVEL * 31, 50000) + 1,
         CASE MOD(LEVEL, 3) WHEN 0 THEN 'envio' WHEN 1 THEN 'facturacion' ELSE 'sucursal' END,
         'Ciudad ' || (MOD(LEVEL * 17, 400) + 1),
         CASE MOD(LEVEL * 13, 6) WHEN 0 THEN 'MX' WHEN 1 THEN 'US' WHEN 2 THEN 'CA'
                                  WHEN 3 THEN 'ES' WHEN 4 THEN 'AR' ELSE 'CL' END,
         LPAD(MOD(LEVEL * 43, 99999), 5, '0')
  FROM dual
  CONNECT BY LEVEL <= 80000;

PROMPT === 6/13  300 categorias en 3 niveles (la raiz no tiene parent_id) ===
INSERT /*+ APPEND */ INTO BENCH_CATEGORIES (category_id, parent_id, name, depth)
  SELECT LEVEL,
         CASE WHEN LEVEL <= 20 THEN NULL
              WHEN LEVEL <= 80 THEN MOD(LEVEL - 21, 20) + 1
              ELSE MOD(LEVEL - 81, 60) + 21 END,
         'Categoria ' || LEVEL,
         CASE WHEN LEVEL <= 20 THEN 1 WHEN LEVEL <= 80 THEN 2 ELSE 3 END
  FROM dual
  CONNECT BY LEVEL <= 300;

PROMPT === 7/13  400,000 productos ===
INSERT /*+ APPEND */ INTO BENCH_PRODUCTS
  (product_id, sku, name, category_id, seller_id, list_price, active, created_at)
  SELECT LEVEL,
         'SKU-' || LPAD(LEVEL, 8, '0'),
         'Producto ' || LEVEL || ' variante ' || MOD(LEVEL * 19, 40),
         MOD(LEVEL * 7, 300) + 1,
         MOD(LEVEL * 23, 2000) + 1,
         MOD(LEVEL * 137, 900000) / 100 + 9.99,
         CASE WHEN MOD(LEVEL * 13, 10) = 0 THEN 'N' ELSE 'S' END,
         DATE '2021-01-01' + MOD(LEVEL * 61, 1826)
  FROM dual
  CONNECT BY LEVEL <= 400000;

PROMPT === 8/13  750,000 filas del puente productos<->categorias ===
INSERT /*+ APPEND */ INTO BENCH_PRODUCT_CATEGORIES (product_id, category_id)
  SELECT FLOOR((LEVEL - 1) / 2) + 1,
         MOD(LEVEL * 13, 300) + 1
  FROM dual
  CONNECT BY LEVEL <= 750000;

PROMPT === 9/13  2,000,000 de inventario (5 almacenes distintos por producto) ===
DECLARE
  c_step  CONSTANT PLS_INTEGER := 250000;
  c_total CONSTANT PLS_INTEGER := 2000000;
BEGIN
  FOR v_base IN 0 .. (c_total - 1) / c_step LOOP
    INSERT /*+ APPEND */ INTO BENCH_INVENTORY
      (product_id, warehouse_id, qty_on_hand, qty_reserved, reorder_point)
    SELECT MOD(g.n - 1, 400000) + 1,
           MOD(MOD(g.n - 1, 400000) + 5 * FLOOR((g.n - 1) / 400000), 12) + 1,
           MOD(g.n * 29, 800),
           MOD(g.n * 41, 120),
           MOD(g.n * 53, 60)
      FROM (SELECT v_base * c_step + LEVEL AS n
              FROM dual
             CONNECT BY LEVEL <= c_step) g
     WHERE g.n <= c_total;
  END LOOP;
  COMMIT;
END;
/

PROMPT === 10/13  2,500,000 ordenes (730 dias; 97 es coprimo con 730) ===
-- A partir de aqui los generadores van en lotes. Un CONNECT BY de millones de filas
-- en un solo INSERT se muere con ORA-30009 (memoria insuficiente), y el limite
-- depende de la maquina: en lotes de 250k o 500k aguanta en cualquier lado.
DECLARE
  c_step  CONSTANT PLS_INTEGER := 250000;
  c_total CONSTANT PLS_INTEGER := 2500000;
BEGIN
  FOR v_base IN 0 .. (c_total - 1) / c_step LOOP
    INSERT /*+ APPEND */ INTO BENCH_ORDERS
      (order_id, order_ref, customer_id, seller_id, warehouse_id, status,
       shipping_country, created_at, total_amount)
    SELECT g.n,
           'ORD-' || LPAD(g.n, 9, '0'),
           MOD(g.n * 61, 50000) + 1,
           MOD(g.n * 37, 2000) + 1,
           MOD(g.n * 5, 12) + 1,
           CASE MOD(g.n, 10) WHEN 0 THEN 'CANCELLED' WHEN 1 THEN 'PENDING' ELSE 'PAID' END,
           CASE MOD(g.n * 13, 6) WHEN 0 THEN 'MX' WHEN 1 THEN 'US' WHEN 2 THEN 'CA'
                                    WHEN 3 THEN 'ES' WHEN 4 THEN 'AR' ELSE 'CL' END,
           DATE '2024-01-01' + MOD(g.n * 97, 730),
           MOD(g.n * 311, 5000000) / 100 + 50
      FROM (SELECT v_base * c_step + LEVEL AS n
              FROM dual
             CONNECT BY LEVEL <= c_step) g
     WHERE g.n <= c_total;
  END LOOP;
  COMMIT;
END;
/

PROMPT === 11/13  7,000,000 lineas de orden (2 o 3 por orden) ===
DECLARE
  c_step  CONSTANT PLS_INTEGER := 500000;
  c_total CONSTANT PLS_INTEGER := 7000000;
BEGIN
  FOR v_base IN 0 .. (c_total - 1) / c_step LOOP
    INSERT /*+ APPEND */ INTO BENCH_ORDER_ITEMS
      (order_id, line_num, product_id, quantity, unit_price, discount_pct)
    SELECT MOD(g.n - 1, 2500000) + 1,
           FLOOR((g.n - 1) / 2500000) + 1,
           MOD(g.n * 61, 400000) + 1,
           MOD(g.n * 7, 9) + 1,
           MOD(g.n * 139, 900000) / 100 + 9.99,
           CASE WHEN MOD(g.n * 11, 4) = 0 THEN MOD(g.n * 5, 40) ELSE 0 END
      FROM (SELECT v_base * c_step + LEVEL AS n
              FROM dual
             CONNECT BY LEVEL <= c_step) g
     WHERE g.n <= c_total;
  END LOOP;
  COMMIT;
END;
/

PROMPT === 12/13  90,000 devoluciones ===
INSERT /*+ APPEND */ INTO BENCH_REFUNDS
  (refund_id, order_id, refunded_at, amount, reason, processed_by)
  SELECT LEVEL,
         MOD(LEVEL * 89, 2500000) + 1,
         DATE '2024-01-01' + MOD(LEVEL * 97, 730),
         MOD(LEVEL * 401, 200000) / 100 + 10,
         CASE MOD(LEVEL * 17, 4) WHEN 0 THEN 'devolucion' WHEN 1 THEN 'producto danado'
                                  WHEN 2 THEN 'envio tardio' ELSE 'otro' END,
         CASE WHEN MOD(LEVEL, 7) = 0 THEN NULL ELSE 'sistema' END
  FROM dual
  CONNECT BY LEVEL <= 90000;

COMMIT;

PROMPT === 13/13  Estadisticas: sin esto los planes son basura ===
BEGIN
  DBMS_STATS.GATHER_SCHEMA_STATS(
    ownname          => USER,
    cascade          => TRUE,
    degree           => 4,
    estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,
    no_invalidate    => FALSE
  );
END;
/

PROMPT Listo. Conteo final:
SELECT table_name, num_rows
FROM user_tab_statistics
WHERE table_name LIKE 'BENCH!_%' ESCAPE '!'
ORDER BY table_name;

PROMPT Query de prueba: scripts/bench-demo.sql
