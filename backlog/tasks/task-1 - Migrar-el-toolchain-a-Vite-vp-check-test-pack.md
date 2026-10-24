---
id: TASK-1
title: Migrar el toolchain a Vite+ (vp check/test/pack)
status: In Progress
assignee:
  - '@sadot'
created_date: '2026-10-24T03:54:00Z'
updated_date: '2026-10-24T04:16:00Z'
labels: []
dependencies: []
modified_files:
  - src/config.ts
  - src/sql/kind.ts
  - CHANGELOG.md
  - CONTRIBUTING.md
  - docs/adr/0003-sustitutos-de-ecosistema.md
  - docs/adr/0006-toolchain-vite-plus.md
  - .prettierignore
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
El gate de calidad vive en cinco herramientas separadas (eslint+typescript-eslint, prettier, vitest, tsup, tsc) y cada una arrastra su arbol de dependencias y su config: lento en local y en CI. Vite+ (viteplus.dev, VoidZero; core Rust: Oxlint/Oxfmt/tsgolint/Rolldown) unifica lint+formato+typecheck en 'vp check', tests en 'vp test' y build de libreria en 'vp pack' (tsdown), con una sola devDependency 'vite-plus'. Decisiones tomadas con el owner: alcance completo (incluye build tsup->tsdown y typecheck via tsgolint); conservar la devDependency 'typescript' para tsserver/editor; bump 2.19.0 (minor) porque engines sube de >=22 a ^22.18.0 || ^24.11.0 || >=26.0.0; reformatear el repo con oxfmt si diverge de prettier; aceptar y documentar (ADR + CHANGELOG) las reglas type-aware de ESLint sin equivalente exacto en Oxlint. La regla no-console (stdout reservado al JSON-RPC) es critica y debe migrar. Via oficial: 'vp migrate' (idempotente).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 vp check pasa: lint (Oxlint), formato (Oxfmt) y typecheck (tsgolint) sin errores
- [ ] #2 vp test corre la suite unit+smoke completa sin Oracle y verde
- [ ] #3 vp pack produce dist/index.js ESM para node22 con shebang ejecutable (bin funcional)
- [ ] #4 Se eliminan eslint, typescript-eslint, prettier, tsup y vitest de devDependencies; typescript se conserva
- [ ] #5 Config consolidada en vite.config.ts (bloques lint/fmt/test/pack); se borran eslint.config.js, .prettierrc, .prettierignore, vitest.config.ts y tsup.config.ts
- [ ] #6 no-console (allow error/warn/info) y no-unused-vars (^_) migradas a Oxlint
- [ ] #7 engines = ^22.18.0 || ^24.11.0 || >=26.0.0 y version 2.19.0 en package.json, con entrada en CHANGELOG.md
- [ ] #8 Los npm scripts mantienen sus nombres (lint, format, format:check, typecheck, test, test:integration, build) delegando en vp; el gate completo local y la CI (ci.yml, matriz 22/24/26) pasan sin cambiar sus invocaciones
- [ ] #9 ADR 0006 en docs/adr/ registra la decision, el alcance y las reglas lint aceptadas como diferencias
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Rama feature/vite-plus desde develop. 2. vp migrate via npx (vite-plus) y revision del reporte. 3. Ajustes: reglas oxlint (no-console allow error/warn/info, no-unused-vars ^_, consistent-type-imports), ignores (.agents, .ua, mcp-audit-logs, video), opciones fmt, proyectos test (unit+integration secuencial), pack con shebang. 4. Limpiar devDeps (eslint, typescript-eslint, prettier, tsup, vitest) y allowScripts esbuild; engines ^22.18.0 || ^24.11.0 || >=26.0.0; version 2.19.0; scripts vp con nombres preservados. 5. vp fmt (reformato) y gate completo local. 6. CHANGELOG 2.19.0 + ADR 0006 + docs que mencionen el toolchain. 7. Commit, push -u, PR a develop.
<!-- SECTION:PLAN:END -->
