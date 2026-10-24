import { describe, expect, it } from 'vite-plus/test';
import { asToolError, ConfigError, DataAccessError, guardTool } from '../../src/errors.js';
import { reportToolError } from '../../src/observability/sentry.js';

/** Texto que ve el cliente MCP en un resultado de error. */
function textOf(error: unknown): string {
  const result = asToolError(error);
  expect(result.isError).toBe(true);
  return result.content[0]?.text ?? '';
}

describe('asToolError · hints de ORA frecuentes', () => {
  it('añade la causa probable de ORA-01031 (usuario de mínimos privilegios)', () => {
    expect(
      textOf(new DataAccessError('ORA-01031: insufficient privileges', 'ORA-01031')),
    ).toContain('least-privilege user has no DDL/DCL privileges');
  });

  it('explica ORA-00942 (tabla inexistente o sin SELECT)', () => {
    expect(
      textOf(new DataAccessError('ORA-00942: table or view does not exist', 'ORA-00942')),
    ).toContain('no SELECT grant on it');
  });

  it('prefija el mensaje de Oracle y apunta a las reglas de redacción', () => {
    const text = textOf(new DataAccessError('ORA-00933: bad syntax', 'ORA-00933'));

    expect(text.startsWith('Oracle error: ORA-00933')).toBe(true);
    expect(text).toContain('Pull the @oracle-sql-style prompt');
  });

  it('deja intacto el mensaje si el código no está en el catálogo', () => {
    expect(textOf(new DataAccessError('ORA-99999: cosa rara', 'ORA-99999'))).toBe(
      'Oracle error: ORA-99999: cosa rara',
    );
  });

  it('no inventa el prefijo de Oracle en errores que no son de la BD', () => {
    expect(textOf(new ConfigError('ORACLE_DB_URL está vacía'))).toBe('ORACLE_DB_URL está vacía');
    expect(textOf('se cayó la tool')).toBe('se cayó la tool');
  });
});

describe('asToolError · interrupciones del cliente', () => {
  it.each(['ORA-01013', 'ORA-03113', 'ORA-03114'])(
    'trata %s como cancelación y no como fallo de la base de datos',
    (code) => {
      const text = textOf(new DataAccessError(`${code}: user requested cancel`, code));

      expect(text).toContain(code);
      expect(text).toContain('cancel');
      expect(text).not.toContain('Oracle error:');
    },
  );

  it('no filtra el detalle del driver en una cancelación', () => {
    const text = textOf(
      new DataAccessError('ORA-01013: cancel\nSELECT password FROM hr.employees', 'ORA-01013'),
    );

    expect(text).not.toContain('password');
  });
});

describe('guardTool', () => {
  it('deja pasar el resultado de éxito tal cual', async () => {
    const ok = { content: [{ type: 'text' as const, text: '{"ok":true}' }] };

    await expect(guardTool(() => Promise.resolve(ok))).resolves.toBe(ok);
  });

  it('convierte cualquier excepción en un resultado isError', async () => {
    const result = await guardTool(() =>
      Promise.reject(new DataAccessError('ORA-01031: insufficient privileges', 'ORA-01031')),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('ORA-01031');
  });
});

it('reporta el error de tool al sink de Sentry antes de devolverlo', async () => {
  const fallo = new DataAccessError('ORA-00942: table or view does not exist', 'ORA-00942');

  const resultado = await guardTool(() => Promise.reject(fallo));

  expect(resultado.isError).toBe(true);
  // con Sentry apagado reportar es un no-op: la tool no se cae nunca
  expect(() => reportToolError(fallo)).not.toThrow();
});

it('corta la request MCP al superar TIMEOUTS.requestMs y devuelve isError', async () => {
  const colgado = new Promise<never>(() => {});

  const result = await guardTool(() => colgado, 10);

  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain('timeout de request MCP');
});
