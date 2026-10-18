import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(
  new URL('../../skills/lu-query-benchmark-sql/scripts/bench-report.mjs', import.meta.url),
);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lu-query-benchmark-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function sample(rep: number, ms: number, buffers = 100, reads = 10) {
  return { rep, ms, buffers, reads };
}

function base(overrides: Record<string, unknown> = {}) {
  return {
    meta: { queryName: 'prueba', repetitions: 4, warmup: 1, ...(overrides.meta as object) },
    original: {
      sql: 'SELECT 1 FROM dual',
      plan: 'plan',
      fingerprint: { rows: 10, checksum: 7 },
      samples: [sample(1, 900), sample(2, 400), sample(3, 500), sample(4, 500)],
      ...(overrides.original as object),
    },
    optimized: {
      sql: 'SELECT 2 FROM dual',
      plan: 'plan',
      fingerprint: { rows: 10, checksum: 7 },
      samples: [sample(1, 100), sample(2, 200), sample(3, 200), sample(4, 200)],
      ...(overrides.optimized as object),
    },
  };
}

async function render(input: unknown) {
  await writeFile(join(dir, '04-mediciones.json'), JSON.stringify(input), 'utf8');
  return spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
}

// Lo que el payload le entrega al navegador. Suelto a proposito: el HTML pide un
// campo y lo encuentra, y lo que falta se declara en el reporte.
interface Payload {
  meta: { measured?: number; warmup?: number };
  factorMs: number | null;
  fingerprint: { match: boolean; rows: number; checksum: number } | null;
  original: { medianMs?: number; samples?: unknown[] };
}

async function payload(): Promise<Payload> {
  const html = await readFile(join(dir, '03-reporte.html'), 'utf8');
  const crudo = /<script id="lu-data" type="application\/json">(.*?)<\/script>/s.exec(html)?.[1];
  expect(crudo).toBeTypeOf('string');
  return JSON.parse(String(crudo).replaceAll('\\u003c', '<')) as Payload;
}

describe('bench-report.mjs', () => {
  it('escribe el reporte y dice donde quedo', async () => {
    const salida = await render(base());

    expect(salida.status).toBe(0);
    expect(salida.stdout.trim()).toBe(join(dir, '03-reporte.html'));
    await expect(readFile(join(dir, '03-reporte.html'), 'utf8')).resolves.toContain('lu-data');
  });

  it('la mediana excluye las Repeticiones de calentamiento', async () => {
    // La repeticion 1 de 900 ms es el arranque en frio: si entrara en la mediana,
    // el reporte prometeria una mejora que no existe.
    const datos = await payloadAfter(base());

    expect(datos.meta.measured).toBe(3);
    expect(datos.original.medianMs).toBe(500);
    expect(datos.original.samples).toHaveLength(4);
  });

  it('calcula el factor en el script y no en el navegador', async () => {
    const datos = await payloadAfter(base());

    // 500 contra 200 de mediana, 3 repeticiones medidas por version.
    expect(datos.factorMs).toBe(2.5);
  });

  it('deja el factor en null cuando no hay dos versiones medibles', async () => {
    const datos = await payloadAfter({
      meta: { queryName: 'una sola', warmup: 1 },
      original: { sql: '', plan: '', samples: [sample(1, 100), sample(2, 200)] },
    });

    expect(datos.factorMs).toBeNull();
    expect(datos.fingerprint).toBeNull();
    // El reporte se escribe igual: una metrica ausente se dice, no se esconde.
    await expect(readFile(join(dir, '03-reporte.html'), 'utf8')).resolves.toContain('lu-data');
  });

  it('la huella exige el mismo numero de filas ademas del checksum', async () => {
    const datos = await payloadAfter(
      base({
        optimized: { fingerprint: { rows: 11, checksum: 7 } },
      }),
    );

    // Mismo checksum con distinto COUNT es ruido, no buena noticia.
    expect(datos.fingerprint).toMatchObject({ match: false });
  });

  it('declara coincidencia solo con filas y checksum identicos', async () => {
    const datos = await payloadAfter(base());

    expect(datos.fingerprint).toMatchObject({ match: true, rows: 10, checksum: 7 });
  });

  it('escapa el cierre de script que traiga el SQL medido', async () => {
    await render(
      base({ original: { sql: "SELECT '</script><script>alert(1)</script>' FROM dual" } }),
    );
    const html = await readFile(join(dir, '03-reporte.html'), 'utf8');

    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script>');
  });

  it('avisa en stderr y no escribe nada cuando falta el archivo de mediciones', () => {
    const salida = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });

    expect(salida.status).toBe(1);
    expect(salida.stderr).toContain('no existe');
  });

  it('avisa cuando el archivo de mediciones no tiene meta', async () => {
    await writeFile(join(dir, '04-mediciones.json'), '{"original":{}}', 'utf8');
    const salida = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });

    expect(salida.status).toBe(1);
    expect(salida.stderr).toContain('meta');
  });
});

async function payloadAfter(input: unknown) {
  const salida = await render(input);
  expect(salida.status).toBe(0);
  return payload();
}
it('preserva recomendaciones y escapa SQL que podría cerrar el payload HTML', async () => {
  const indexRecommendations = [
    {
      status: 'candidate',
      title: 'Probar índice',
      evidence: 'Plan observado',
      sql: '</script><script>alert(1)</script>',
    },
  ];
  const result = await render({ ...base(), indexRecommendations });
  expect(result.status).toBe(0);
  const html = await readFile(join(dir, '03-reporte.html'), 'utf8');
  expect(html).not.toContain(indexRecommendations[0]!.sql);
  expect(await payload()).toMatchObject({ indexRecommendations });
});
