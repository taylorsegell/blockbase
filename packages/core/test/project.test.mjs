import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { ProjectInspectionError, inspectProject } from '../dist/index.js';

const fixtures = resolve(import.meta.dirname, '../../../tests/fixtures/destinations');

test('fixture A and B produce distinct evidence-backed React profiles', async () => {
  const [a, b] = await Promise.all([
    inspectProject(join(fixtures, 'fixture-a')),
    inspectProject(join(fixtures, 'fixture-b')),
  ]);
  assert.equal(a.framework.name, 'vite');
  assert.deepEqual(a.styling.systems, ['css', 'tailwind']);
  assert.equal(a.conventions.componentDirectory, 'src/components');
  assert.equal(a.conventions.importAlias, '@/');
  assert.equal(a.tokens.values['--color-surface'], '#ffffff');
  assert.equal(a.evidence.some((item) => item.fact.includes('Class helper detected: clsx')), true);
  assert.equal(b.framework.name, 'next');
  assert.deepEqual(b.styling.systems, ['css']);
  assert.equal(b.conventions.componentDirectory, 'app/ui');
  assert.equal(b.conventions.importAlias, '~/');
  assert.equal(b.tokens.values['--surface-page'], '#f8fafc');
  assert.equal(b.evidence.some((item) => item.fact.includes('Class helper detected: classnames')), true);
  assert.notDeepEqual(a.dependencies, b.dependencies);
});

test('inspection is deterministic, bounded to allowlisted reads, and does not write', async () => {
  const root = join(fixtures, 'fixture-a');
  const before = await readdir(root);
  const first = await inspectProject(root, { maxComponentSamples: 1 });
  const second = await inspectProject(root, { maxComponentSamples: 1 });
  assert.deepEqual(first, second);
  assert.equal(first.evidence.some((item) => item.path === 'package.json'), true);
  assert.equal(first.evidence.some((item) => item.path === 'src/components/Card.tsx'), true);
  assert.equal(first.evidence.some((item) => item.path.includes('node_modules') || item.path === 'catalog.yaml'), false);
  assert.deepEqual(await readdir(root), before);
});

test('same-mode token conflicts identify definitions and project override resolves them', async () => {
  const root = join(tmpdir(), `blockbase-project-conflict-${Date.now()}`);
  await mkdir(join(root, 'src', 'components'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', dependencies: { react: '18.0.0', vite: '5.0.0' } }));
  await writeFile(join(root, 'src', 'index.css'), ':root { --surface: white; }\n');
  await writeFile(join(root, 'src', 'globals.css'), ':root { --surface: black; }\n');
  const profile = await inspectProject(root);
  assert.equal(profile.conflicts.length, 1);
  assert.match(profile.conflicts[0], /src\/index\.css.*src\/globals\.css/);
  await mkdir(join(root, '.blockbase'));
  await writeFile(join(root, '.blockbase', 'project.json'), JSON.stringify({ tokens: { values: { '--surface': 'var(--surface-page)' } } }));
  const overridden = await inspectProject(root);
  assert.deepEqual(overridden.conflicts, []);
  assert.equal(overridden.tokens.values['--surface'], 'var(--surface-page)');
  assert.equal(overridden.evidence.some((item) => item.path === '.blockbase/project.json' && item.source === 'override'), true);
  assert.equal(JSON.parse(await readFile(join(root, '.blockbase', 'project.json'), 'utf8')).tokens.values['--surface'], 'var(--surface-page)');
});

test('unsupported framework has a stable code', async () => {
  const root = join(tmpdir(), `blockbase-project-unsupported-${Date.now()}`);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }));
  await assert.rejects(() => inspectProject(root), (error) => error instanceof ProjectInspectionError && error.code === 'PROJECT_UNSUPPORTED_FRAMEWORK');
});
