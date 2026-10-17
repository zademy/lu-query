import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/errors.js';
import { assertNodeVersion, loadConfig, parseOracleConnectString } from '../../src/config.js';

const pkgVersion: string = createRequire(import.meta.url)('../../package.json').version;

describe('parseOracleConnectString', () => {
  it('traduce el formato JDBC thin con doble barra a connect string de node-oracledb', () => {
    expect(parseOracleConnectString('jdbc:oracle:thin:@//localhost:1521/FREEPDB1')).toBe(
      'localhost:1521/FREEPDB1',
    );
    expect(parseOracleConnectString('jdbc:oracle:thin:@//db.example.com:1521/ORCLPDB1')).toBe(
      'db.example.com:1521/ORCLPDB1',
    );
  });

  it('traduce easy-connect (sin doble barra)', () => {
    expect(parseOracleConnectString('jdbc:oracle:thin:@db.example.com:1521/ORCL')).toBe(
      'db.example.com:1521/ORCL',
    );
  });

  it('traduce el separador SID (host:port:SID) a service name', () => {
    expect(parseOracleConnectString('jdbc:oracle:thin:@localhost:1521:FREE')).toBe(
      'localhost:1521/FREE',
    );
  });

  it('deja pasar un alias TNS simple', () => {
    expect(parseOracleConnectString('jdbc:oracle:thin:@MYALIAS')).toBe('MYALIAS');
  });

  it('conserva el descriptor (DESCRIPTION=...) quitando solo el prefijo jdbc', () => {
    const descriptor =
      'jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db)(PORT=1521))' +
      '(CONNECT_DATA=(SERVICE_NAME=ORCL)))';
    expect(parseOracleConnectString(descriptor)).toBe(descriptor.replace('jdbc:oracle:thin:@', ''));
  });

  it('acepta una connect string de node-oracledb sin prefijo jdbc', () => {
    expect(parseOracleConnectString('localhost:1521/FREEPDB1')).toBe('localhost:1521/FREEPDB1');
  });

  it('rechaza URLs de otro driver con mensaje claro', () => {
    expect(() => parseOracleConnectString('jdbc:mysql://localhost:3306/db')).toThrow(ConfigError);
    expect(() => parseOracleConnectString('jdbc:mysql://localhost:3306/db')).toThrow(/jdbc:oracle/);
  });

  it('rechaza un jdbc:oracle:thin vacío', () => {
    expect(() => parseOracleConnectString('jdbc:oracle:thin:@')).toThrow(ConfigError);
  });
});

describe('loadConfig', () => {
  it('aplica los defaults de paridad con el Java cuando no hay env vars', () => {
    const config = loadConfig({});

    expect(config.connectString).toBeUndefined();
    expect(config.schema).toBeUndefined();
    expect(config.poolSize).toBe(4);
    expect(config.serverVersion).toBe(pkgVersion);
    expect(config.audit.enabled).toBe(true);
    expect(config.audit.dir).toBe('./mcp-audit-logs');
    expect(config.sentry.enabled).toBe(false);
    expect(config.sentry.sendDefaultPii).toBe(false);
    expect(config.logLevel).toBe('INFO');
  });

  it('lee las env vars y traduce ORACLE_DB_URL', () => {
    const config = loadConfig({
      ORACLE_DB_URL: 'jdbc:oracle:thin:@//localhost:1521/FREEPDB1',
      ORACLE_DB_USERNAME: 'scott',
      ORACLE_DB_PASSWORD: 'tiger',
      ORACLE_DB_SCHEMA: 'APP',
      ORACLE_POOL_SIZE: '8',
      MCP_SERVER_VERSION: '2.13.1',
      MCP_AUDIT_DIR: '/tmp/audit',
      MCP_AUDIT_ENABLED: 'false',
      LOG_LEVEL: 'DEBUG',
    });

    expect(config.connectString).toBe('localhost:1521/FREEPDB1');
    expect(config.user).toBe('scott');
    expect(config.password).toBe('tiger');
    expect(config.schema).toBe('APP');
    expect(config.poolSize).toBe(8);
    expect(config.serverVersion).toBe('2.13.1');
    expect(config.audit).toEqual({ enabled: false, dir: '/tmp/audit' });
    expect(config.logLevel).toBe('DEBUG');
  });

  it('cae al default de pool size cuando ORACLE_POOL_SIZE no es un entero válido', () => {
    expect(loadConfig({ ORACLE_POOL_SIZE: 'muchos' }).poolSize).toBe(4);
    expect(loadConfig({ ORACLE_POOL_SIZE: '0' }).poolSize).toBe(4);
  });

  it('usa APP_LOG_LEVEL como fallback de LOG_LEVEL', () => {
    expect(loadConfig({ APP_LOG_LEVEL: 'WARN' }).logLevel).toBe('WARN');
  });
});

describe('assertNodeVersion', () => {
  it('acepta Node 22 y superior', () => {
    expect(() => assertNodeVersion('22.0.0')).not.toThrow();
    expect(() => assertNodeVersion('24.3.1')).not.toThrow();
  });

  it('falla con mensaje que dice el mínimo y la versión detectada', () => {
    expect(() => assertNodeVersion('20.11.1')).toThrow(ConfigError);
    expect(() => assertNodeVersion('20.11.1')).toThrow(/Node\.js >= 22.*v?20\.11\.1/s);
  });
});
