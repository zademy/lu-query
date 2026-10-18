#!/usr/bin/env node
// Renderiza el reporte de benchmark a partir de las mediciones en JSON.
//
// Node sin dependencias, a proposito: la skill se copia sola a la maquina del
// agente y no puede depender de que haya otro runtime instalado.
//
// Lo que hace el agente es ejecutar y transcribir. Toda la aritmetica que se
// puede hacer bien aqui, se hace aqui: las medianas excluyendo el calentamiento,
// el veredicto de la huella y los factores. Si el agente los calculara a mano,
// un redondeo suyo se leeria como una medicion de Oracle.

import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tableOperations } from './plan-operations.mjs';

const TEMPLATE = new URL('../references/template.html', import.meta.url);
const MEDICIONES = '04-mediciones.json';
const REPORTE = '03-reporte.html';

class ReportError extends Error {}

// Mediana de lo que va despues del calentamiento. Sin Repeticiones exclidas son
// la mediana completa, que es lo que uno quiere cuando nadie marco calentamiento.
function mediana(valores) {
  const n = valores
    .filter((v) => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!n.length) return null;
  const medio = Math.floor(n.length / 2);
  return n.length % 2 ? n[medio] : (n[medio - 1] + n[medio]) / 2;
}

// A-Rows y E-Rows se restan por fila del plan, no se suman: el total es el ultimo
// nodo, y promediar todos los nodos contaria el mismo trabajo varias veces.
function resumen(samples, warmup) {
  const enCaliente = samples.filter((s) => s.rep > warmup);
  return {
    samples,
    medianMs: mediana(enCaliente.map((s) => s.ms)),
    medianBuffers: mediana(enCaliente.map((s) => s.buffers)),
    medianReads: mediana(enCaliente.map((s) => s.reads)),
  };
}

// La huella solo puede compararse si ambas versiones devolvieron el mismo numero
// de filas. Un checksum igual con distinto COUNT no es buena noticia, es ruido.
function veredictoHuella(original, optimizado) {
  const a = original && original.fingerprint;
  const d = optimizado && optimizado.fingerprint;
  if (!a || !d) return null;
  return {
    match: a.rows === d.rows && a.checksum === d.checksum,
    rows: a.rows,
    checksum: a.checksum,
  };
}

function derive(input) {
  const meta = input.meta || {};
  const warmup = Number(meta.warmup) || 0;
  const original = input.original
    ? { ...input.original, ...resumen(input.original.samples || [], warmup) }
    : null;
  const optimizado = input.optimized
    ? { ...input.optimized, ...resumen(input.optimized.samples || [], warmup) }
    : null;
  // El factor tambien se calcula aqui. Un redondeo hecho en el navegador se lee
  // igual que uno mal hecho a mano por el agente: los dos se atribuyen a Oracle.
  const factorMs =
    original?.medianMs && optimizado?.medianMs
      ? Math.round((original.medianMs / optimizado.medianMs) * 100) / 100
      : null;
  const medido = (original?.samples || []).filter((s) => s.rep > warmup).length;

  return {
    ...input,
    meta: { ...meta, warmup, measured: medido },
    original,
    optimized: optimizado,
    operations: {
      original: tableOperations(input.original?.plan),
      optimized: tableOperations(input.optimized?.plan),
    },
    factorMs,
    fingerprint: veredictoHuella(original, optimizado),
  };
}

async function main() {
  const dir = resolve(process.argv[2] || '.');
  const source = join(dir, MEDICIONES);
  const target = join(dir, REPORTE);

  let crudo;
  try {
    crudo = await readFile(source, 'utf8');
  } catch (causa) {
    throw new ReportError(
      `No se pudo leer ${source}: ${causa.code === 'ENOENT' ? 'el archivo no existe' : causa.message}`,
    );
  }

  let input;
  try {
    input = JSON.parse(crudo);
  } catch (causa) {
    throw new ReportError(`${source} no es JSON valido: ${causa.message}`);
  }
  if (!input || typeof input !== 'object' || !input.meta) {
    throw new ReportError(`${source} no tiene "meta". Revisa references/mediciones.md.`);
  }

  const template = await readFile(TEMPLATE, 'utf8');
  if (!template.includes('<!--lu-data-->')) {
    throw new ReportError(`La plantilla no tiene el marcador <!--lu-data-->.`);
  }

  // Un </script> dentro del payload cerraria el tag antes de tiempo.
  const payload = JSON.stringify(derive(input)).replaceAll('<', '\\u003c');
  await writeFile(
    target,
    template.replace(
      '<!--lu-data-->',
      `<script id="lu-data" type="application/json">${payload}</script>`,
    ),
    'utf8',
  );
  process.stdout.write(`${target}\n`);
}

try {
  await main();
} catch (causa) {
  process.stderr.write(`${causa.message}\n`);
  process.exitCode = 1;
}
