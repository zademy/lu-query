import { describe, expect, it } from 'vitest';
import { SecurityError } from '../../src/errors.js';
import {
  assertIdentifier,
  isValidIdentifier,
  safeLiteral,
} from '../../src/security/identifiers.js';

describe('isValidIdentifier', () => {
  it('acepta la allow-list ^[A-Za-z][A-Za-z0-9_$#]{0,127}$', () => {
    expect(isValidIdentifier('EMPLOYEES')).toBe(true);
    expect(isValidIdentifier('my_table$1#col')).toBe(true);
    expect(isValidIdentifier('a'.repeat(128))).toBe(true);
  });

  it('rechaza lo que se sale de la allow-list', () => {
    expect(isValidIdentifier('_leading')).toBe(false);
    expect(isValidIdentifier('1abc')).toBe(false);
    expect(isValidIdentifier('a'.repeat(129))).toBe(false);
    expect(isValidIdentifier('EMP LOYEE')).toBe(false);
    expect(isValidIdentifier('EMPLOYEES; DROP TABLE T')).toBe(false);
    expect(isValidIdentifier('EM"PLOYEE')).toBe(false);
    expect(isValidIdentifier('')).toBe(false);
  });
});

describe('assertIdentifier', () => {
  it('devuelve el identificador cuando es válido', () => {
    expect(assertIdentifier('EMPLOYEES', 'tabla')).toBe('EMPLOYEES');
  });

  it('lanza SecurityError nombrando el valor rechazado', () => {
    expect(() => assertIdentifier('1abc', 'tabla')).toThrow(SecurityError);
    expect(() => assertIdentifier('1abc', 'tabla')).toThrow(/tabla.*1abc/);
  });
});

describe('safeLiteral', () => {
  it('escapa la comilla simple duplicándola', () => {
    expect(safeLiteral("O'Brien")).toBe("'O''Brien'");
  });

  it('rechaza literales que rompen la cadena', () => {
    expect(() => safeLiteral("'; DROP TABLE employees; --")).toThrow(SecurityError);
  });
});
