# Toolchain unificado en Vite+ (vp)

## Contexto

El gate de calidad vivía en cinco herramientas separadas (eslint + typescript-eslint, prettier, vitest, tsup, tsc), cada una con su config y su árbol de dependencias. El gate local y la CI (matriz 9) pagaban ese costo en cada corrida, y TypeScript estaba pineado a 6.x porque typescript-eslint no soportaba 7.

Vite+ (viteplus.dev, VoidZero) unifica lint, formato, typecheck, test y build en el CLI `vp`, con core Rust (Oxlint, Oxfmt, tsgolint, Rolldown/tsdown).

## Decisión

- Migración completa vía `vp migrate` (Vite+ 1.4.0): `vp check` (lint + formato + typecheck), `vp test`, `vp pack`.
- Una sola config: `vite.config.ts` con los bloques `lint`, `fmt`, `test` y `pack`. Se eliminan `eslint.config.js`, `.prettierrc`, `.prettierignore`, `vitest.config.ts` y `tsup.config.ts`.
- devDependencies fuera: eslint, typescript-eslint, prettier y tsup. `vitest` queda pineado al bundle (5.0.5) vía `overrides`, y `vite` se aliasea a `@voidzero-dev/vite-plus-core` (mecanismo documentado de Vite+).
- `typescript` se conserva solo para tsserver/editor: el typecheck del gate corre por tsgolint (TypeScript Go) dentro de `vp check`.
- Los npm scripts conservan sus nombres (`lint`, `format`, `format:check`, `typecheck`, `test`, `build`): la CI y los flujos documentados no cambian sus invocaciones.
- `engines` sube a `^22.18.0 || ^24.11.0 || >=26.0.0` (requisito de vite-plus): motivo del bump minor 2.19.0.
- El bin mantiene su contrato: `dist/index.js` ESM, target node22, shebang. `outExtensions` fija `.js` porque tsdown emite `.mjs` por defecto en esm.
- El test de integración de stdio empaqueta y ejecuta el artefacto real (`npm run build` → `dist/index.js`) en vez de un bundle ad-hoc en caché.

## Diferencias aceptadas

- Oxlint type-aware no replica 1:1 `recommendedTypeChecked` de typescript-eslint. `vp migrate` mapeó las reglas vigentes (incluidas `no-console` con allow error/warn/info, crítica porque stdout está reservado al JSON-RPC; `no-unused-vars` con `argsIgnorePattern: '^'`_ y `consistent-type-imports`); lo que no tiene equivalente se acepta como diferencia, compensada en parte por el typecheck completo de `vp check`. A cambio, el lint type-aware baja de varios segundos a ~0.7 s y el build a decenas de ms.
- Oxfmt es ~99% compatible con Prettier; el reformateo del repo fue necesario y su diff resultó mínimo.
