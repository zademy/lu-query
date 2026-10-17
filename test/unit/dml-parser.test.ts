import { describe, expect, it } from 'vitest';
import { parseDmlTarget } from '../../src/sql/dml-parser.js';

describe('parseDmlTarget', () => {
  it('extrae el objeto destino de cada verbo DML', () => {
    expect(parseDmlTarget("INSERT INTO employees (name) VALUES ('x')")).toEqual({
      kind: 'insert',
      table: 'employees',
    });
    expect(parseDmlTarget('UPDATE hr.employees SET salary = 1 WHERE id = 2')).toEqual({
      kind: 'update',
      table: 'hr.employees',
    });
    expect(parseDmlTarget('delete from EMPLOYEES where id = 1')).toEqual({
      kind: 'delete',
      table: 'EMPLOYEES',
    });
    expect(
      parseDmlTarget('MERGE INTO tgt USING src ON (1=1) WHEN MATCHED THEN UPDATE SET a = 1'),
    ).toEqual({ kind: 'merge', table: 'tgt' });
  });

  it('conserva el case del identificador para que el allow-list lo valide', () => {
    expect(parseDmlTarget('INSERT INTO HR.Employees VALUES (1)')?.table).toBe('HR.Employees');
  });

  it('ignora comentarios iniciales', () => {
    expect(parseDmlTarget('/* dml */ UPDATE employees SET a = 1')).toEqual({
      kind: 'update',
      table: 'employees',
    });
  });

  it('devuelve null para lo que no es DML', () => {
    expect(parseDmlTarget('SELECT * FROM employees')).toBeNull();
    expect(parseDmlTarget('CREATE TABLE t (a NUMBER)')).toBeNull();
    expect(parseDmlTarget('BEGIN NULL; END;')).toBeNull();
    expect(parseDmlTarget('')).toBeNull();
  });
});
