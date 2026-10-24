import * as Sentry from '@sentry/node';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { loadConfig } from '../../src/config.js';
import { DataAccessError } from '../../src/errors.js';
import { beforeSend, createSentrySink } from '../../src/observability/sentry.js';
import { createHarness } from '../helpers/harness.js';

/** DSN con formato válido cuyo destino (puerto 1) no escucha: nada sale a la red. */
const LOCAL_DSN = 'http://public@127.0.0.1:1/1';

/** Config que ve la tool, tal y como la resuelve el bootstrap desde el env. */
function configFromEnv(env: Record<string, string>): ReturnType<typeof loadConfig> {
  return loadConfig({ MCP_AUDIT_ENABLED: 'false', ...env });
}

/** Evento de error mínimo: solo importa el mensaje de la excepción. */
function errorEvent(message: string): Sentry.ErrorEvent {
  return { type: undefined, exception: { values: [{ type: 'Error', value: message }] } };
}

afterEach(async () => {
  // Tras `close` el cliente sigue vinculado pero sin transport, así que `isEnabled()`
  // vuelve a false y cada test arranca sin el cliente del anterior.
  await Sentry.close(50);
});

describe('filtro de ORA antes de enviar a Sentry', () => {
  it.each([
    ['ORA-01031', 'query: ORA-01031 insufficient privileges'],
    ['ORA-00942', 'query: ORA-00942 table or view does not exist'],
    ['ORA-01039', 'session: ORA-01039 no create session privilege'],
  ])('descarta %s: es un rechazo esperado de mínimos privilegios', (code, message) => {
    const error = new DataAccessError(message, code);

    expect(beforeSend(errorEvent(error.message))).toBeNull();
  });

  it.each(['ORA-00933', 'ORA-01013', 'ORA-12541'])(
    'deja pasar %s: no es un rechazo esperado',
    (code) => {
      const event = errorEvent(`query: ${code} fallo real`);

      expect(beforeSend(event)).toBe(event);
    },
  );

  it('deja pasar un error que no viene de Oracle', () => {
    const event = errorEvent('se cayó la tool');

    expect(beforeSend(event)).toBe(event);
  });

  it('deja pasar eventos sin excepción (mensajes)', () => {
    const event: Sentry.ErrorEvent = { type: undefined, message: 'reinicio' };

    expect(beforeSend(event)).toBe(event);
  });
});

describe('createSentrySink · inicialización', () => {
  it('con SENTRY_ENABLED=false no inicializa nada', () => {
    const sink = createSentrySink(configFromEnv({}));

    expect(sink.enabled).toBe(false);
    expect(Sentry.isEnabled()).toBe(false);
  });

  it('con SENTRY_ENABLED=true pero sin DSN no inicializa', () => {
    const sink = createSentrySink(configFromEnv({ SENTRY_ENABLED: 'true' }));

    expect(sink.enabled).toBe(false);
    expect(Sentry.isEnabled()).toBe(false);
  });

  it('con SENTRY_ENABLED=true y DSN inicializa con el filtro y los tags del env', () => {
    const config = configFromEnv({
      SENTRY_ENABLED: 'true',
      SENTRY_DSN: LOCAL_DSN,
      SENTRY_ENV: 'prod',
      SENTRY_RELEASE: '9.9.9',
    });

    const sink = createSentrySink(config);
    const options = Sentry.getClient()?.getOptions();

    expect(sink.enabled).toBe(true);
    expect(options?.environment).toBe('prod');
    expect(options?.release).toBe('9.9.9');
    // Paridad con el Java: send-default-pii false salvo que se pida explícitamente.
    expect(options?.sendDefaultPii).toBe(false);
    expect(
      options?.beforeSend?.(errorEvent('ORA-00942 table or view does not exist'), {}),
    ).toBeNull();
  });

  it('sin SENTRY_ENV ni SENTRY_RELEASE usa local y la versión del server', () => {
    const config = configFromEnv({ SENTRY_ENABLED: 'true', SENTRY_DSN: LOCAL_DSN });

    createSentrySink(config);
    const options = Sentry.getClient()?.getOptions();

    expect(options?.environment).toBe('local');
    expect(options?.release).toBe('0.0.1-SNAPSHOT');
  });

  it('inicializar no rompe el arranque: el transporte MCP sigue respondiendo', async () => {
    const config = configFromEnv({ SENTRY_ENABLED: 'true', SENTRY_DSN: LOCAL_DSN });
    const sink = createSentrySink(config);
    const { client, close } = await createHarness({ config: { sentry: config.sentry } });

    try {
      const { tools } = await client.listTools();

      expect(sink.enabled).toBe(true);
      expect(tools.map((tool) => tool.name)).toContain('test_connection');
    } finally {
      await close();
    }
  });
});

describe('createSentrySink · captura que nunca rompe el flujo', () => {
  it('con Sentry deshabilitado capturar es un no-op', () => {
    const sink = createSentrySink(configFromEnv({}));

    expect(() => sink.captureException(new Error('boom'))).not.toThrow();
    expect(() => sink.captureMessage('mensaje')).not.toThrow();
    expect(Sentry.isEnabled()).toBe(false);
  });

  it('con Sentry habilitado capturar con contexto no lanza ni altera la respuesta MCP', async () => {
    // DSN mal formado: el SDK cae en NoopTransport, así que nada sale a la red.
    const config = configFromEnv({ SENTRY_ENABLED: 'true', SENTRY_DSN: 'no-es-un-dsn' });
    const sink = createSentrySink(config);
    const { client, close } = await createHarness({ config: { sentry: config.sentry } });

    try {
      const result = await client.callTool({
        name: 'query',
        arguments: { sql: 'SELECT * FROM nope' },
      });

      expect(sink.enabled).toBe(true);
      expect(result.isError).toBe(true);
      expect(() =>
        sink.captureException(new DataAccessError('boom ORA-01031', 'ORA-01031'), {
          tool: 'query',
        }),
      ).not.toThrow();
      expect(() => sink.captureMessage('mensaje')).not.toThrow();
    } finally {
      await close();
    }
  });
});
