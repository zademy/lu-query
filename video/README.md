# Promo video (Remotion)

Source of `docs/lu-query-promo.mp4` - the 33-second promo used in the README.
It is a **build tool workspace**: it has its own `package.json`, its own toolchain and is
excluded from the npm package (`files: ["dist", "skills"]`), from `npm ci` at the repo root and
from CI. Nothing here ships to npm.

## Re-render

```bash
cd video
npm ci
npm run dev                    # Remotion Studio, http://localhost:3000
npx remotion render Promo ../docs/lu-query-promo.mp4 --codec=h264 --crf=26 --pixel-format=yuv420p
npx remotion render Promo out/frames --frames=120,240,540,720,900 --image-format=png   # stills to review
npm run lint                   # eslint + tsc of this workspace
```

Current output: 1920x1080, 30 fps, 33 s, H.264 (yuv420p), ~2.1 MB.

## Scenes

| Scene | Seconds | Message |
| --- | --- | --- |
| Hook | 0-5 | Your AI agent speaks Oracle |
| Install | 5-11 | No Oracle Client: `npx lu-query`, lazy thin pool |
| Tools | 11-19 | The catalog: 75 tools, grouped by job |
| Audit | 19-27 | Every statement in a Markdown audit file |
| Call to action | 27-33 | `npx lu-query`, stats, parity note |

## House rules

- No third-party logos, stock footage or icons: everything is motion graphics with the repo palette (`src/theme.ts`).
- Animation is frame-driven (`useCurrentFrame` + `interpolate` with clamping); no CSS transitions or keyframe animations.
- Copy lives in the scene components, so a wording change is a one-line edit plus a re-render.

## License note

Remotion is free for individuals and companies with up to 3 employees (commercial use included);
larger organizations need a company license. See <https://remotion.dev/license>.
