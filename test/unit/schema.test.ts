import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/errors.js';
import { resolveSchema } from '../../src/catalog/schema.js';

describe('resolveSchema', () => {
  it('gana el schema pedido por la tool', () => {
    expect(resolveSchema('HR', 'SCOTT', 'list_tables')).toBe('HR');
  });

  it('cae al schema de sesión o al configurado cuando el pedido viene vacío', () => {
    expect(resolveSchema(undefined, 'SCOTT', 'list_tables')).toBe('SCOTT');
    expect(resolveSchema('   ', 'SCOTT', 'list_tables')).toBe('SCOTT');
    expect(resolveSchema(undefined, 'APP', 'list_tables')).toBe('APP');
  });

  it('falla con ConfigError si no hay schema pedido ni default', () => {
    expect(() => resolveSchema(undefined, undefined, 'list_tables')).toThrow(ConfigError);
    expect(() => resolveSchema(undefined, undefined, 'list_tables')).toThrow(/list_tables/);
  });
});
