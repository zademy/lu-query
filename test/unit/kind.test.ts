import { describe, expect, it } from 'vitest';
import { detectStatementKind } from '../../src/sql/kind.js';

describe('detectStatementKind', () => {
  it('detecta DML por la primera palabra clave ignorando mayúsculas y espacios', () => {
    expect(detectStatementKind('SELECT * FROM employees')).toBe('select');
    expect(detectStatementKind('  select 1 from dual')).toBe('select');
    expect(detectStatementKind('INSERT INTO employees (a) VALUES (1)')).toBe('insert');
    expect(detectStatementKind('update employees set a = 1')).toBe('update');
    expect(detectStatementKind('DELETE FROM employees')).toBe('delete');
    expect(
      detectStatementKind('MERGE INTO t USING s ON (1=1) WHEN MATCHED THEN UPDATE SET a = 1'),
    ).toBe('merge');
  });

  it('salta comentarios de línea y de bloque', () => {
    expect(detectStatementKind('-- consulta de conteo\nSELECT 1 FROM dual')).toBe('select');
    expect(detectStatementKind('/* conteo */\n INSERT INTO t (a) VALUES (1)')).toBe('insert');
  });

  it('detecta DDL, incluidos CREATE de PL/SQL', () => {
    expect(detectStatementKind('CREATE TABLE t (a NUMBER)')).toBe('ddl');
    expect(detectStatementKind('CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;')).toBe('ddl');
    expect(detectStatementKind('CREATE OR REPLACE VIEW v AS SELECT 1 FROM dual')).toBe('ddl');
    expect(detectStatementKind('DROP TABLE t')).toBe('ddl');
    expect(detectStatementKind('TRUNCATE TABLE t')).toBe('ddl');
  });

  it('detecta bloques PL/SQL y explain plan', () => {
    expect(detectStatementKind('BEGIN NULL; END;')).toBe('plsql');
    expect(detectStatementKind('DECLARE x NUMBER; BEGIN NULL; END;')).toBe('plsql');
    expect(detectStatementKind('EXPLAIN PLAN FOR SELECT * FROM t')).toBe('explain');
  });

  it('detecta SELECT aunque empiece con WITH', () => {
    expect(detectStatementKind('WITH x AS (SELECT 1 FROM dual) SELECT * FROM x')).toBe('select');
  });

  it('es unknown para entrada vacía o no SQL', () => {
    expect(detectStatementKind('')).toBe('unknown');
    expect(detectStatementKind('   ')).toBe('unknown');
    expect(detectStatementKind('DROP TABLE t;')).toBe('ddl');
  });
});
