---
id: TASK-1
title: Migrar el toolchain a Vite+ (vp check/test/pack)
status: Done
assignee:
  - '@sadot'
created_date: '2026-10-24T03:54:00Z'
updated_date: '2026-10-24T04:50:00Z'
labels: []
dependencies: []
modified_files:
  - .github/workflows/ocr-review.yml
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
El gate de calidad vive en cinco herramientas separadas (eslint+typescript-eslint, prettier, vitest, tsup, tsc) y cada una arrastra su arbol de dependencias y su config: lento en local y en CI. Vite+ (viteplus.dev, VoidZero; core Rust: Oxlint/Oxfmt/tsgolint/Rolldown) unifica lint+formato+typecheck en 'vp check', tests en 'vp test' y build de libreria en 'vp pack' (tsdown), con una sola devDependency 'vite-plus'. Decisiones tomadas con el owner: alcance completo (incluye build tsup->tsdown y typecheck via tsgolint); conservar la devDependency 'typescript' para tsserver/editor; bump 2.19.0 (minor) porque engines sube de >=22 a ^22.18.0 || ^24.11.0 || >=26.0.0; reformatear el repo con oxfmt si diverge de prettier; aceptar y documentar (ADR + CHANGELOG) las reglas type-aware de ESLint sin equivalente exacto en Oxlint. La regla no-console (stdout reservado al JSON-RPC) es critica y debe migrar. Via oficial: 'vp migrate' (idempotente).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 vp check pasa: lint (Oxlint), formato (Oxfmt) y typecheck (tsgolint) sin errores
- [x] #2 vp test corre la suite unit+smoke completa sin Oracle y verde
- [x] #3 vp pack produce dist/index.js ESM para node22 con shebang ejecutable (bin funcional)
- [x] #4 Se eliminan eslint, typescript-eslint, prettier, tsup y vitest de devDependencies; typescript se conserva
- [x] #5 Config consolidada en vite.config.ts (bloques lint/fmt/test/pack); se borran eslint.config.js, .prettierrc, .prettierignore, vitest.config.ts y tsup.config.ts
- [x] #6 no-console (allow error/warn/info) y no-unused-vars (^_) migradas a Oxlint
- [x] #7 engines = ^22.18.0 || ^24.11.0 || >=26.0.0 y version 2.19.0 en package.json, con entrada en CHANGELOG.md
- [x] #8 Los npm scripts mantienen sus nombres (lint, format, format:check, typecheck, test, test:integration, build) delegando en vp; el gate completo local y la CI (ci.yml, matriz 22/24/26) pasan sin cambiar sus invocaciones
- [x] #9 ADR 0006 en docs/adr/ registra la decision, el alcance y las reglas lint aceptadas como diferencias
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Rama feature/vite-plus desde develop. 2. vp migrate via npx (vite-plus) y revision del reporte. 3. Ajustes: reglas oxlint (no-console allow error/warn/info, no-unused-vars ^_, consistent-type-imports), ignores (.agents, .ua, mcp-audit-logs, video), opciones fmt, proyectos test (unit+integration secuencial), pack con shebang. 4. Limpiar devDeps (eslint, typescript-eslint, prettier, tsup, vitest) y allowScripts esbuild; engines ^22.18.0 || ^24.11.0 || >=26.0.0; version 2.19.0; scripts vp con nombres preservados. 5. vp fmt (reformato) y gate completo local. 6. CHANGELOG 2.19.0 + ADR 0006 + docs que mencionen el toolchain. 7. Commit, push -u, PR a develop.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Validacion: vp check unificado pass (formato 408ms + lint/typecheck 643ms); unit 361/361 (3.4s); integracion 219/219 contra oracle-26ai-free (incluye stdio real con dist/index.js); smoke del bin responde initialize con serverInfo 2.19.0. El fallo inicial de get_fk_graph (42 FKs vs 3) era contaminacion preexistente del esquema DEVUSER (BENCH_*/DIM*/FACT*), reproducido identico en develop via stash; esquema limpiado (recreable con scripts/seed-bench.sql). tsdown emite .mjs por defecto: outExtensions fija .js (bin declara dist/index.js). DEFAULT_SERVER_VERSION acompaña el bump. Commit 9cddde2, PR #69 a develop.

Fix ocr-review: el wrapper bin/ocr.js del CLI 1.13.2 lanza un self-update detached (npm i -g @latest, scripts/update.js:154) cuando el registry reporta version mas nueva; con 1.13.3 publicada (22-oct) el reemplazo en caliente cayo en mitad del paso Configure OCR del run 40061693643 (MODULE_NOT_FOUND ../scripts/platform). Fix: OCR_NO_UPDATE=1 en el env del step + bump action y ocr_version a 1.13.3.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Toolchain migrado a Vite+ 1.4.0 (vp check/test/pack) con config unica en vite.config.ts; version 2.19.0 (minor por engines ^22.18.0 || ^24.11.0 || >=26.0.0). DevDeps fuera: eslint, typescript-eslint, prettier, tsup; typescript se conserva para editor. Nombres de npm scripts intactos: CI sin cambios. Gate completo local y suites unit (361) e integracion (219) verdes. Diferencias de reglas lint aceptadas y documentadas en ADR 0006. Riesgo residual: paridad parcial de reglas type-aware (compensada por typecheck de vp check); CHANGELOG tenia deuda previa (2.17/2.18 sin entrada). Entrega: PR zademy/lu-query#69.
<!-- SECTION:FINAL_SUMMARY:END -->
