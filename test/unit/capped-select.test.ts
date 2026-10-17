import { describe, expect, it } from 'vitest';
import { buildCappedSelect, clampMaxRows } from '../../src/sql/capped-select.js';

describe('clampMaxRows', () => {
  it('usa MAX_ROWS cuando no se pide nada', () => {
    expect(clampMaxRows(undefined)).toBe(1000);
    expect(clampMaxRows(Number.NaN)).toBe(1000);
  });

  it('respeta un límite dentro del rango', () => {
    expect(clampMaxRows(10)).toBe(10);
    expect(clampMaxRows(1000)).toBe(1000);
  });

  it('recorta por arriba y por abajo', () => {
    expect(clampMaxRows(5000)).toBe(1000);
    expect(clampMaxRows(0)).toBe(1);
    expect(clampMaxRows(-5)).toBe(1);
  });
});

describe('buildCappedSelect', () => {
  it('envuelve el SELECT con un tope de ROWNUM', () => {
    expect(buildCappedSelect('SELECT * FROM employees', 10)).toBe(
      'SELECT * FROM ( SELECT * FROM employees ) WHERE ROWNUM <= 10',
    );
  });

  it('usa el máximo global cuando no se pasa límite', () => {
    expect(buildCappedSelect('SELECT * FROM employees')).toBe(
      'SELECT * FROM ( SELECT * FROM employees ) WHERE ROWNUM <= 1000',
    );
  });

  it('no duplica el tope si el SQL ya trae FETCH FIRST o ROWNUM', () => {
    expect(buildCappedSelect('SELECT * FROM employees FETCH FIRST 5 ROWS ONLY', 10)).toBe(
      'SELECT * FROM employees FETCH FIRST 5 ROWS ONLY',
    );
    expect(buildCappedSelect('select * from employees where rownum <= 3', 10)).toBe(
      'select * from employees where rownum <= 3',
    );
  });

  it('quita el punto y coma antes de envolver', () => {
    expect(buildCappedSelect('SELECT * FROM employees;', 5)).toBe(
      'SELECT * FROM ( SELECT * FROM employees ) WHERE ROWNUM <= 5',
    );
  });
});
