import { createRequire } from 'node:module';
import { describe, expect, it } from 'vite-plus/test';
import { DEFAULT_SERVER_VERSION } from '../../src/config.js';

const pkgVersion: string = createRequire(import.meta.url)('../../package.json').version;

describe('version del paquete', () => {
  it('el server reporta la version de package.json (el release se corta con esa)', () => {
    expect(DEFAULT_SERVER_VERSION).toBe(pkgVersion);
  });
});
