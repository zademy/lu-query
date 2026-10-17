#!/usr/bin/env node
// Notas de release al estilo Spring Boot: secciones por tipo de commit
// conventional y una entrada por commit con enlace al commit y al issue citado.
// El workflow pone el titulo (solo v<version>); aqui solo el cuerpo agrupado.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const SECTIONS = [
  ['feat', '⭐ New Features'],
  ['fix', '🐛 Bug Fixes'],
  ['docs', '📔 Documentation'],
  ['test', '🧪 Tests'],
  ['merge', '🔀 Merges'],
  ['ci', '🔧 Maintenance'],
  ['chore', '🔧 Maintenance'],
  ['refactor', '🔧 Maintenance'],
  ['build', '🔧 Maintenance'],
  ['perf', '🔧 Maintenance'],
];
const OTHERS = '📝 Others';

export function sectionOf(subject) {
  const type = /^([a-z]+)(\([^)]*\))?!?:/.exec(subject)?.[1];
  return SECTIONS.find(([t]) => t === type)?.[1] ?? OTHERS;
}

export function renderEntry(subject, sha, repo) {
  const linked = subject.replace(/#(\d+)/g, `[#$1](https://github.com/${repo}/issues/$1)`);
  return `- ${linked} ([${sha.slice(0, 7)}](https://github.com/${repo}/commit/${sha}))`;
}

export function buildReleaseNotes(commits, repo) {
  const bySection = new Map();
  for (const { sha, subject } of commits) {
    const title = sectionOf(subject);
    bySection.set(title, [...(bySection.get(title) ?? []), renderEntry(subject, sha, repo)]);
  }
  const order = [...new Set(SECTIONS.map(([, title]) => title)), OTHERS];
  return order
    .filter((title) => bySection.has(title))
    .map((title) => `## ${title}\n\n${bySection.get(title).join('\n')}`)
    .join('\n\n');
}

function gitLog(range) {
  return execFileSync('git', ['log', ...range, '--format=%H%x1f%s'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, subject] = line.split('\x1f');
      return { sha, subject };
    });
}

function selfTest() {
  assert.equal(sectionOf('feat(#4): x'), '⭐ New Features');
  assert.equal(sectionOf('fix!: y'), '🐛 Bug Fixes');
  assert.equal(sectionOf('ci: z'), '🔧 Maintenance');
  assert.equal(sectionOf('Merge pull request #18'), '📝 Others');
  const notes = buildReleaseNotes(
    [
      { sha: 'a'.repeat(40), subject: 'feat(#4): auditoría Markdown por sesión' },
      { sha: 'b'.repeat(40), subject: 'fix(#5): watchdog del request MCP' },
      { sha: 'c'.repeat(40), subject: 'docs: README sin links externos' },
      { sha: 'd'.repeat(40), subject: 'merge(#11): tools PL/SQL' },
      { sha: 'e'.repeat(40), subject: 'sin prefijo convencional' },
    ],
    'zademy/lu-query',
  );
  assert.ok(notes.startsWith('## ⭐ New Features'));
  assert.ok(notes.includes('## 🔀 Merges'));
  assert.ok(notes.includes('## 📝 Others'));
  assert.ok(notes.includes('## 📔 Documentation'));
  assert.ok(notes.includes('docs: README sin links externos'));
  assert.ok(!notes.includes('🧪 Tests')); // secciones sin commits no aparecen
  assert.ok(notes.includes('[#4](https://github.com/zademy/lu-query/issues/4)'));
  assert.ok(
    notes.includes('([aaaaaaa](https://github.com/zademy/lu-query/commit/' + 'a'.repeat(40) + '))'),
  );
  console.info('self-test OK');
}

function main() {
  const repo =
    process.env.GITHUB_REPOSITORY ??
    execFileSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8' })
      .trim()
      .replace(/^.*github\.com[:/]/, '')
      .replace(/\.git$/, '');
  let lastTag = '';
  try {
    lastTag = execFileSync('git', ['describe', '--tags', '--abbrev=0'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // sin tags previos: notas sobre toda la historia
  }
  const range = lastTag ? [`${lastTag}..HEAD`] : [];
  process.stdout.write(buildReleaseNotes(gitLog(range), repo) + '\n');
}

if (process.argv.includes('--self-test')) selfTest();
else if (process.argv[1]?.endsWith('release-notes.mjs')) main();
