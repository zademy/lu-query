import * as Sentry from '@sentry/node';
import type { ResolvedConfig } from '../config.js';

/** Chokepoint de observabilidad; #16 lo conecta a @sentry/node y filtra ORA. */
export interface SentrySink {
  readonly enabled: boolean;
  captureException(error: unknown, context?: Record<string, unknown>): void;
  captureMessage(message: string): void;
}

/**
 * Rechazos de mínimos privilegios que no son fallos, sino el resultado normal
 * del modelo de seguridad de una sola capa. Mismos tres códigos que descarta
 * `SentryConfig.isExpectedDenial` en el server Java (`config/SentryConfig.java`).
 */
const EXPECTED_ORA_CODES = ['ORA-01031', 'ORA-00942', 'ORA-01039'] as const;

/** ¿El mensaje es un rechazo de privilegios esperado en vez de un fallo real? */
export function isExpectedOracleDenial(message: string | undefined): boolean {
  return message !== undefined && EXPECTED_ORA_CODES.some((code) => message.includes(code));
}

/**
 * `beforeSend` del SDK: devuelve `null` y Sentry descarta el evento entero (no
 * solo el error), igual que el Java, para no enviar el texto de Oracle, que
 * puede llevar SQL o fragmentos de conexión.
 */
export function beforeSend(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
  return isExpectedOracleDenial(event.exception?.values?.[0]?.value) ? null : event;
}

/** Sink apagado: mismo contrato, cero coste y cero red. */
function disabledSink(): SentrySink {
  return { enabled: false, captureException: () => {}, captureMessage: () => {} };
}

/** Sink activo; sin inicializar es el apagado, así que reportar es un no-op. */
let activeSink: SentrySink = disabledSink();

/**
 * Reporta un error de tool al sink activo. Es el equivalente de
 * `SentryCaptureAspect`: las tools capturan, el filtro `beforeSend` decide.
 */
export function reportToolError(error: unknown, context?: Record<string, unknown>): void {
  activeSink.captureException(error, context);
}

/** Reportar un fallo nunca debe tumbar la petición que lo provoca. */
function safely(report: () => void): void {
  try {
    report();
  } catch {
    // sin reportar: el flujo de la tool tiene prioridad
  }
}

/**
 * Inicializa @sentry/node si `SENTRY_ENABLED=true` y hay DSN (matriz de
 * comportamiento del Java), y devuelve el sink para capturar errores.
 */
export function createSentrySink(config: ResolvedConfig): SentrySink {
  const { enabled, dsn, env, release, sendDefaultPii } = config.sentry;
  if (!enabled) return disabledSink();
  if (dsn === undefined) {
    process.stderr.write(
      'Sentry habilitado pero SENTRY_DSN no está definido; el reporte de errores sigue apagado\n',
    );
    return disabledSink();
  }

  try {
    Sentry.init({
      dsn,
      // Defaults del Java (application.yaml): environment=local y release=0.0.1-SNAPSHOT.
      environment: env ?? 'local',
      release: release ?? '0.0.1-SNAPSHOT',
      sendDefaultPii,
      beforeSend,
      // SENTRY_AUTH_TOKEN es token de build del sentry-maven-plugin en el Java y
      // no existe en @sentry/node: se acepta en el env por paridad y se ignora.
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Sentry no se pudo inicializar: ${message}\n`);
    return disabledSink();
  }

  const sink: SentrySink = {
    enabled: true,
    captureException(error, context) {
      safely(() => Sentry.captureException(error, context ? { extra: context } : undefined));
    },
    captureMessage(message) {
      safely(() => Sentry.captureMessage(message));
    },
  };
  activeSink = sink;
  return sink;
}

/**
 * Vacía los eventos pendientes al salir. Acotado por el timeout y sin rechazar:
 * el apagado no puede quedarse colgado por la observabilidad.
 */
export async function flushSentry(): Promise<void> {
  try {
    await Sentry.flush(2_000);
  } catch {
    // sin flush: se pierden eventos, nunca el cierre
  }
}
