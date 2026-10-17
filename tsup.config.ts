import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  // shebang: sin esto el bin no es ejecutable con `./dist/index.js`.
  banner: { js: '#!/usr/bin/env node' },
});
