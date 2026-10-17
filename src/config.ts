import { ConfigError } from './errors.js';

/** Versión del paquete; es también el default de MCP_SERVER_VERSION (paridad Java). */
export const DEFAULT_SERVER_VERSION = '2.16.2';

/** max-rows global del Java. */
export const MAX_ROWS = 1000;

/** Timeouts en las 3 capas del Java: statement/query, socket, request MCP. */
export const TIMEOUTS = {
  statementMs: 120_000,
  socketSeconds: 30,
  requestMs: 150_000,
} as const;

/** Mínimo de runtime declarado en package.json#engines. */
export const MIN_NODE_MAJOR = 22;

const JDBC_PREFIX = 'jdbc:oracle:thin:@';

export interface SentryConfig {
  enabled: boolean;
  dsn: string | undefined;
  env: string | undefined;
  release: string | undefined;
  sendDefaultPii: boolean;
  authToken: string | undefined;
}

export interface AuditConfig {
  enabled: boolean;
  dir: string;
}

export interface ResolvedConfig {
  /** Connect string de node-oracledb (host:port/service o descriptor). */
  connectString: string | undefined;
  user: string | undefined;
  password: string | undefined;
  /** Schema por defecto de las tools; undefined = schema de la sesión. */
  schema: string | undefined;
  poolSize: number;
  serverVersion: string;
  audit: AuditConfig;
  sentry: SentryConfig;
  logLevel: string;
}

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

/** Convencion heredada del Java: solo `false`, `0` y `no` apagan; todo lo demas enciende. */
function bool(value: string | undefined, fallback: boolean): boolean {
  const raw = trimmed(value)?.toLowerCase();
  if (raw === undefined) return fallback;
  return raw !== 'false' && raw !== '0' && raw !== 'no';
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(trimmed(value) ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Traduce la URL del Java (`jdbc:oracle:thin:@...`) a la connect string de
 * node-oracledb. Acepta thin con `//`, easy-connect, alias TNS y descriptor
 * (DESCRIPTION=...); una connect string sin prefijo jdbc pasa tal cual.
 */
export function parseOracleConnectString(raw: string): string {
  const value = trimmed(raw);
  if (value === undefined) {
    throw new ConfigError('ORACLE_DB_URL está vacía');
  }
  if (!value.startsWith('jdbc:')) return value;

  if (!value.startsWith(JDBC_PREFIX)) {
    throw new ConfigError(
      `ORACLE_DB_URL con driver no soportado: ${value}. Se espera ${JDBC_PREFIX}<host:puerto/servicio>`,
    );
  }

  let target = value.slice(JDBC_PREFIX.length);
  if (!target) {
    throw new ConfigError(`ORACLE_DB_URL sin destino: ${value}`);
  }

  if (target.startsWith('(')) return target; // descriptor TNS: se pasa directo a node-oracledb

  target = target.startsWith('//') ? target.slice(2) : target;

  // host:port:SID (SID) -> host:port/SID (service name)
  const sid = /^(?<host>[^/:]+):(?<port>\d+):(?<sid>.+)$/.exec(target);
  return sid?.groups ? `${sid.groups.host}:${sid.groups.port}/${sid.groups.sid}` : target;
}

/** Falla con mensaje claro si el runtime es anterior a Node >= MIN_NODE_MAJOR. */
export function assertNodeVersion(version: string): void {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    throw new ConfigError(
      `lu-query requiere Node.js >= ${MIN_NODE_MAJOR} (detectado v${version}). ` +
        'Actualiza Node.js o usa npx con una versión soportada.',
    );
  }
}

/** Lee la configuración desde el env con los defaults de paridad con el Java. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const url = trimmed(env.ORACLE_DB_URL);
  return {
    connectString: url === undefined ? undefined : parseOracleConnectString(url),
    user: trimmed(env.ORACLE_DB_USERNAME),
    password: env.ORACLE_DB_PASSWORD === undefined ? undefined : env.ORACLE_DB_PASSWORD,
    schema: trimmed(env.ORACLE_DB_SCHEMA),
    poolSize: positiveInt(env.ORACLE_POOL_SIZE, 4),
    serverVersion: trimmed(env.MCP_SERVER_VERSION) ?? DEFAULT_SERVER_VERSION,
    audit: {
      enabled: bool(env.MCP_AUDIT_ENABLED, true), // en el Java era opt-in; aquí default true
      dir: trimmed(env.MCP_AUDIT_DIR) ?? './mcp-audit-logs',
    },
    sentry: {
      enabled: bool(env.SENTRY_ENABLED, false),
      dsn: trimmed(env.SENTRY_DSN),
      env: trimmed(env.SENTRY_ENV),
      release: trimmed(env.SENTRY_RELEASE),
      sendDefaultPii: bool(env.SENTRY_SEND_DEFAULT_PII, false),
      authToken: trimmed(env.SENTRY_AUTH_TOKEN),
    },
    logLevel: trimmed(env.LOG_LEVEL) ?? trimmed(env.APP_LOG_LEVEL) ?? 'INFO',
  };
}
