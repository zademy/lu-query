import { describe, expect, it } from 'vite-plus/test';
import { SecurityError } from '../../src/errors.js';
import {
  assertIdentifier,
  isValidIdentifier,
  qualifiedName,
  qualifiedTrustedName,
  quoteCsv,
  quoteIdentifier,
  quoteTrustedIdentifier,
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

describe('quoteIdentifier', () => {
  it('valida y entrecomilla con dobles comillas', () => {
    expect(quoteIdentifier('EMP')).toBe('"EMP"');
    expect(quoteIdentifier('my_table$1#col')).toBe('"my_table$1#col"');
  });

  it('rechaza lo que no pasa la allow-list, nombrando el valor', () => {
    expect(() => quoteIdentifier('1abc', 'columna')).toThrow(SecurityError);
    expect(() => quoteIdentifier('1abc', 'columna')).toThrow(/columna.*1abc/);
  });
});

describe('qualifiedName', () => {
  it('entrecomilla las dos partes del nombre cualificado', () => {
    expect(qualifiedName('DEVUSER', 'EMPLOYEES')).toBe('"DEVUSER"."EMPLOYEES"');
  });

  it('rechaza si cualquiera de las dos partes no pasa la allow-list', () => {
    expect(() => qualifiedName('DEVUSER', 'EMP; DROP')).toThrow(SecurityError);
    expect(() => qualifiedName('A B', 'EMPLOYEES')).toThrow(SecurityError);
  });
});

describe('quoteCsv', () => {
  it('une los identificadores validados como CSV entrecomillado', () => {
    expect(quoteCsv(['A', 'B'])).toBe('"A", "B"');
  });

  it('rechaza si algún elemento no pasa la allow-list', () => {
    expect(() => quoteCsv(['A', 'B;C'])).toThrow(SecurityError);
  });
});

describe('nombres trusted (del diccionario de Oracle)', () => {
  it('entrecomilla sin validar, duplicando la doble comilla', () => {
    expect(quoteTrustedIdentifier('My"Table')).toBe('"My""Table"');
    expect(quoteTrustedIdentifier('Tabla Con Espacios')).toBe('"Tabla Con Espacios"');
    expect(quoteTrustedIdentifier('1abc')).toBe('"1abc"');
  });

  it('arma el nombre cualificado sin validar ninguna de las partes', () => {
    expect(qualifiedTrustedName('Mi Schema', 'Mi"Tabla')).toBe('"Mi Schema"."Mi""Tabla"');
  });
});
