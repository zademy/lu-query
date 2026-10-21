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

## Pipeline de CI

```text
push a rama feature     nada corre (no hay CI por push)
PR feature -> develop   ci (matriz 9) + ocr-review (advisory, en paralelo)
merge en develop        nada: el arbol ya se valido en el PR
PR develop -> master    ci (matriz 9; son los required checks de master)
merge en master         release (tag + notas) + publish (npm), en paralelo
```

-- Los tests solo corren en PRs (`ci.yml`): sin trigger de `push`, un commit en una rama no dispara nada y el merge no repite la matriz.
-- `release` y `publish` solo existen después del merge a `master`: se disparan con el push que produce ese merge, nunca antes. Ambos son idempotentes (tag `v<version>` o versión en npm ya existentes terminan en aviso, sin publicar).

## Review de código en los PR

`.github/workflows/ocr-review.yml` corre [OpenCodeReview](https://open-codereview.ai) sobre cada PR que entra a `develop` y deja los hallazgos como comentarios de review.

-- Es **advisory**: OCR no aprueba, no pide cambios y no bloquea el merge. El veredicto es de quien revisa; los required checks de `master` siguen siendo solo los de la matriz de CI.
-- Revisa el rango `merge-base(develop)..head`, o sea el cambio del PR. El PR de release (`develop` → `master`) queda fuera: su diff es todo el delta acumulado y repetiría los hallazgos ya revisados PR a PR.
-- Severidad `medium` o menor y categorías `style`/`documentation` van al resumen en vez de comentarios inline.
-- Para relanzar el review: comentar `/open-code-review` en el PR.
-- GLM 5.3 corre con `thinking` activado y `effort: high` (3 rondas de review): más calidad por comentario, a cambio de PRs más lentos y caros. El ajuste vive en `llm_extra_body` / `effort` del workflow.
--- El reviewer recibe el cuerpo del PR como contexto (`background`): un PR bien descrito recibe un review mejor informado.
--- `max_tokens_budget` topa el costo por review; al llegar al tope se publican los hallazgos parciales sin fallar el job.

Las reglas de este repo están en `.opencodereview/rule.json`: paridad con `mcp-oracle-db`, seam de `DataAccess`, stdout reservado al JSON-RPC, test por bugfix.

Necesita cuatro secrets (Settings → Secrets and variables → Actions), para GLM 5.3 (Z.ai): `OCR_LLM_URL` = `https://api.z.ai/api/coding/paas/v4/chat/completions` (API regular: `https://api.z.ai/api/paas/v4/chat/completions`), `OCR_LLM_AUTH_TOKEN` (API key), `OCR_LLM_MODEL` = `glm-5.3` y `OCR_LLM_USE_ANTHROPIC` = `false` (GLM habla el protocolo OpenAI-compatible, no el de Anthropic).

## Issues y commits

- Issues en GitHub (`gh`); los tickets de implementación son sub-issues de la spec (#1).
- Commits: `feat(#N): …` / `fix(#N): …` / `test(#N): …`, en español, referenciando el ticket.

## Publicación

`npm publish` es **manual y la hace el maintainer** — no hay CI que publique. El merge a master crea el _release_ de GitHub (`v<version>` de `package.json`), no el paquete npm.

Antes de publicar: bump de versión en `package.json` + entrada en `CHANGELOG.md`, `npm run lint && npm run typecheck && npm test` desde árbol limpio, y smoke de `npx lu-query` contra un cliente MCP real. `prepublishOnly` compila `dist/` por ti, así que el tarball nunca lleva un build viejo.

```bash
npm whoami                # confirma la sesión (si no: npm login)
npm publish --dry-run     # revisa el tarball: deben salir dist/, skills/, README*, LICENSE
npm publish               # 2FA: pide OTP si tu cuenta lo tiene activo
npm view lu-query dist-tags   # latest debe apuntar a la versión recién subida
npm view lu-query version && curl -sI https://registry.npmjs.org/lu-query | head -1   # 200
```

Notas del registro:

- **Unpublish**: solo dentro de las 72 h desde la publicación, y ese número de versión queda quemado para siempre.
- **Scripts de instalación**: en npm ≥ 11 el consumidor recibe un aviso por los install scripts de las dependencias (`oracledb`). No es un fallo: el driver thin no necesita compilación nativa. `npm install --ignore-scripts` también funciona.
- **Nombre**: si el paquete se despublica y pasan 24 h, cualquiera puede tomar el nombre. Publicar pronto o usar un scope.
