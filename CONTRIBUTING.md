# Contribuir a lu-query

## Requisitos

- Node.js ≥ 22 y npm ≥ 10 (`npm ci`; en npm ≥ 11 el `allowScripts` de `package.json` aprueba los install scripts de `esbuild` y `oracledb`).

## Paridad ante todo

La fuente de verdad de cada tool es su firma Java en `mcp-oracle-db` (`tools/`, `service/`, `model/`). Un cambio de contrato se justifica citando la firma Java original, o se marca explícitamente como desviación. Vocabulario: `GLOSSARY.md`; decisiones: `docs/adr/`.

## Desarrollo

```bash
npm ci
npm run lint && npm run typecheck
npm test                      # unit: sin Oracle, FakeDataAccess inyectado por el harness
npm run build                 # dist/index.js con shebang
```

### Tests de integración (Oracle real)

```bash
LU_TEST_INTEGRATION=1 \
ORACLE_DB_URL='jdbc:oracle:thin:@//localhost:1521/FREEPDB1' \
ORACLE_DB_USERNAME=DEVUSER ORACLE_DB_PASSWORD=… \
npm run test:integration
```

Necesitan una Oracle accesible (el equipo usa el contenedor `oracle-26ai-free`; scripts de grants en `scripts/`). No ejecutes dos suites de integración en paralelo: mutan el esquema.

## Issues y commits

- Issues en GitHub (`gh`); los tickets de implementación son sub-issues de la spec (#1).
- Commits: `feat(#N): …` / `fix(#N): …` / `test(#N): …`, en español, referenciando el ticket.

## Publicación

`npm publish` es **manual y la hace el maintainer** — no hay CI que publique. Antes de publicar: `npm run build`, smoke `npx lu-query` contra un cliente real, y bump de versión en `package.json` + entrada en `CHANGELOG.md`.
