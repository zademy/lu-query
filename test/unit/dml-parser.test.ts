import { describe, expect, it } from 'vitest';
import { classifyDml, parseDmlTarget } from '../../src/sql/dml-parser.js';

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

describe('classifyDml', () => {
  it('clasifica cada verbo DML con el parser', () => {
    expect(classifyDml("INSERT INTO employees (name) VALUES ('x')").kind).toBe('INSERT');
    expect(classifyDml('UPDATE employees SET salary = 1 WHERE id = 2').kind).toBe('UPDATE');
    expect(classifyDml('delete from employees where id = 1').kind).toBe('DELETE');
  });

  it('devuelve el WHERE tal cual lo escribio el usuario', () => {
    expect(
      classifyDml("UPDATE hr.employees SET salary = salary * 2 WHERE id = 2 AND name = 'x'"),
    ).toEqual({ kind: 'UPDATE', where: "id = 2 AND name = 'x'", alias: null });
    expect(classifyDml('DELETE FROM employees WHERE dept = 10')).toEqual({
      kind: 'DELETE',
      where: 'dept = 10',
      alias: null,
    });
  });

  it('el WHERE conserva el alias y las subconsultas, que Oracle si acepta', () => {
    // Re-serializar el AST entrecomillaba el alias y la tabla, y en Oracle
    // `"e"` no existe: el SELECT espejo reventaba con ORA-00904.
    expect(
      classifyDml(
        'UPDATE employees e SET salary = 1 WHERE e.dept_id IN (SELECT dept_id FROM departments)',
      ),
    ).toEqual({
      kind: 'UPDATE',
      where: 'e.dept_id IN (SELECT dept_id FROM departments)',
      alias: 'e',
    });
  });

  it('quita el punto y coma y cambia los binds por literales', () => {
    // El driver de Oracle no acepta un `;` en un SELECT, y el SELECT espejo
    // no puede llevar binds: el placeholder va como literal.
    expect(classifyDml('UPDATE employees SET salary = 1 WHERE id = :id;')).toEqual({
      kind: 'UPDATE',
      where: "id = 'id'",
      alias: null,
    });
  });

  it('deja where en null cuando el DML no filtra', () => {
    expect(classifyDml('UPDATE employees SET active = 1')).toEqual({
      kind: 'UPDATE',
      where: null,
      alias: null,
    });
    expect(classifyDml("INSERT INTO employees (name) VALUES ('x')")).toEqual({
      kind: 'INSERT',
      where: null,
      alias: null,
    });
  });

  it('devuelve UNKNOWN para lo que el parser no entiende y deja decidir a Oracle', () => {
    expect(
      classifyDml('MERGE INTO tgt USING src ON (1=1) WHEN MATCHED THEN UPDATE SET a = 1'),
    ).toEqual({ kind: 'UNKNOWN', where: null, alias: null });
    expect(classifyDml('esto no es sql')).toEqual({ kind: 'UNKNOWN', where: null, alias: null });
    expect(classifyDml('')).toEqual({ kind: 'UNKNOWN', where: null, alias: null });
  });
});
