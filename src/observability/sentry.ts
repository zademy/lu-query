import type { SentryConfig } from '../config.js';

/** Chokepoint de observabilidad; #16 lo conecta a @sentry/node y filtra ORA. */
export interface SentrySink {
  readonly enabled: boolean;
  captureException(error: unknown, context?: Record<string, unknown>): void;
  captureMessage(message: string): void;
}

/**
 * Stub funcional:Sink no-op que respeta el flag. No tira de @sentry/node hasta
 * que exista el wiring de #16, así que SENTRY_ENABLED no rompe el arranque.
 */
export function createSentrySink(config: SentryConfig): SentrySink {
  return {
    enabled: config.enabled,
    captureException: () => {},
    captureMessage: () => {},
  };
}
