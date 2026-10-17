import { describe, expect, it } from 'vitest';
import {
  buildCappedSelect,
  buildPagedSelect,
  clampMaxRows,
  clampPage,
} from '../../src/sql/capped-select.js';

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

describe('clampPage', () => {
  it('pagina desde 0 hasta el tope global cuando no se pide nada', () => {
    expect(clampPage(undefined, undefined)).toEqual({ offset: 0, limit: 1000 });
    expect(clampPage(Number.NaN, Number.NaN)).toEqual({ offset: 0, limit: 1000 });
  });

  it('respeta una página dentro del rango', () => {
    expect(clampPage(10, 25)).toEqual({ offset: 10, limit: 25 });
  });

  it('deja el offset en 0 si es negativo y capa el limit a max-rows', () => {
    expect(clampPage(-5, 5000)).toEqual({ offset: 0, limit: 1000 });
    expect(clampPage(2, 0)).toEqual({ offset: 2, limit: 1 });
  });
});

describe('buildPagedSelect', () => {
  it('envuelve en OFFSET/FETCH cuando hay offset (paridad con QueryService del Java)', () => {
    expect(buildPagedSelect('SELECT * FROM employees', { offset: 20, limit: 10 })).toBe(
      'SELECT * FROM ( SELECT * FROM employees ) OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY',
    );
  });

  it('usa el tope heredado de ROWNUM cuando la página empieza en 0', () => {
    expect(buildPagedSelect('SELECT * FROM employees', { offset: 0, limit: 10 })).toBe(
      'SELECT * FROM ( SELECT * FROM employees ) WHERE ROWNUM <= 10',
    );
  });

  it('quita el punto y coma del SELECT que se envuelve', () => {
    expect(buildPagedSelect('SELECT * FROM employees;', { offset: 3, limit: 2 })).toBe(
      'SELECT * FROM ( SELECT * FROM employees ) OFFSET 3 ROWS FETCH NEXT 2 ROWS ONLY',
    );
  });
});
