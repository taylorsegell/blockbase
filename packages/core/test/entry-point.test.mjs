import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { parseComponentManifest } from '@blockbase/contracts';
import {
  RevisionStore,
  addInboxPaste,
  chooseEntryPoint,
  diagnoseIndex,
  importInboxItem,
  importSource,
  inspectComponent,
  openIndex,
  resolveEntryPoint,
} from '../dist/index.js';

const fixturePath = resolve(import.meta.dirname, '../../contracts/fixtures/v1/component-manifest.json');
const backfillScript = resolve(import.meta.dirname, '../../../scripts/backfill-entry-point.mjs');
const card = 'export function Card() { return <div>Card</div>; }\n';

async function tmp(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

async function indexRowCount(catalogRoot) {
  const index = await openIndex({ catalogRoot });
  try {
    return index.db.prepare('SELECT COUNT(*) AS n FROM components').get().n;
  } finally {
    index.db.close?.();
  }
}

test('stdin paste import persists entryPoint in component.json', async () => {
  const root = await tmp('blockbase-ep-stdin-');
  const result = await importSource('-', { catalogRoot: root, stdin: card, entryPoint: 'Card.tsx', namespace: 'ep', slug: 'card' });
  assert.equal(result.manifest.entryPoint, 'Card.tsx');
  const stored = JSON.parse(await readFile(join(result.componentPath, 'component.json'), 'utf8'));
  assert.equal(stored.entryPoint, 'Card.tsx');
});

test('directory import persists the chosen entryPoint', async () => {
  const root = await tmp('blockbase-ep-dir-');
  const source = join(root, 'src');
  await mkdir(join(source, 'lib'), { recursive: true });
  await writeFile(join(source, 'index.ts'), 'export * from "./lib/a";\n');
  await writeFile(join(source, 'lib/a.tsx'), card);
  const result = await importSource(source, { catalogRoot: join(root, 'catalog'), namespace: 'ep', slug: 'dir' });
  assert.equal(result.manifest.entryPoint, 'index.ts');
});

test('a supplied manifest without entryPoint gets one injected; an explicit one is kept', async () => {
  const root = await tmp('blockbase-ep-manifest-');
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  delete fixture.entryPoint;
  const file = join(root, 'Card.tsx');
  await writeFile(file, card);
  const injected = await importSource(file, { catalogRoot: join(root, 'a'), manifest: fixture });
  assert.equal(injected.manifest.entryPoint, 'Card.tsx');
  const explicit = await importSource(file, { catalogRoot: join(root, 'b'), manifest: { ...fixture, entryPoint: 'Card.tsx' } });
  assert.equal(explicit.manifest.entryPoint, 'Card.tsx');
});

test('manifest validator rejects empty, absolute, and traversing entryPoint values', async () => {
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  assert.doesNotThrow(() => parseComponentManifest({ ...fixture, entryPoint: 'a/index.tsx' }));
  for (const bad of ['', '/abs.tsx', '../x.tsx', 'a/../b.tsx', 3]) {
    assert.throws(() => parseComponentManifest({ ...fixture, entryPoint: bad }), undefined, String(bad));
  }
});

test('import into a brand-new catalog leaves a valid index with no manual rebuild', async () => {
  const root = join(await tmp('blockbase-ep-empty-'), 'does-not-exist-yet');
  const result = await importSource('-', { catalogRoot: root, stdin: card, entryPoint: 'Card.tsx', namespace: 'ep', slug: 'fresh' });
  await stat(join(root, 'index.sqlite'));
  assert.equal(await indexRowCount(root), 1);
  const status = await diagnoseIndex({ catalogRoot: root });
  assert.equal(status.healthy, true);
  const inspection = await inspectComponent(root, result.manifest.componentId);
  assert.equal(inspection.manifest.entryPoint, 'Card.tsx');
});

test('inbox import leaves a current index', async () => {
  const root = await tmp('blockbase-ep-inbox-');
  const item = await addInboxPaste({ catalogRoot: root, content: card, entryPoint: 'Card.tsx', label: 'card' });
  const { imported } = await importInboxItem(root, item.id, { namespace: 'ep', slug: 'inbox' });
  assert.equal(imported.manifest.entryPoint, 'Card.tsx');
  assert.equal(await indexRowCount(root), 1);
  await inspectComponent(root, imported.manifest.componentId);
});

test('resolveEntryPoint honours the persisted value, else the shared heuristic', () => {
  const m = (entryPoint) => ({ entryPoint, displayName: 'X' });
  assert.equal(resolveEntryPoint(m('b.tsx'), ['a.tsx', 'b.tsx']), 'b.tsx');
  // stale persisted value falls back
  assert.equal(resolveEntryPoint(m('gone.tsx'), ['a.tsx', 'index.ts']), 'index.ts');
  assert.equal(resolveEntryPoint(m(undefined), []), undefined);
});

test('chooseEntryPoint covers the importer, legacy, and adapt heuristics', () => {
  // importer: root index order tsx > ts > jsx > js
  assert.equal(chooseEntryPoint(['index.js', 'index.ts', 'a.tsx']), 'index.ts');
  assert.equal(chooseEntryPoint(['index.jsx', 'index.js']), 'index.jsx');
  // importer: nested index beats unrelated files, root beats nested
  assert.equal(chooseEntryPoint(['a.tsx', 'lib/index.tsx']), 'lib/index.tsx');
  assert.equal(chooseEntryPoint(['lib/index.tsx', 'index.js']), 'index.js');
  // importer strict mode: ambiguous multi-file without index is undefined, sole file accepted
  assert.equal(chooseEntryPoint(['a.tsx', 'b.tsx'], { fallback: false }), undefined);
  assert.equal(chooseEntryPoint(['only.tsx'], { fallback: false }), 'only.tsx');
  // legacy/adapt fallback: first tsx/jsx, then ts/js, then first file
  assert.equal(chooseEntryPoint(['b.ts', 'a.tsx', 'c.tsx']), 'a.tsx');
  assert.equal(chooseEntryPoint(['b.js', 'a.ts']), 'a.ts');
  assert.equal(chooseEntryPoint(['z.css', 'a.json']), 'a.json');
  assert.equal(chooseEntryPoint([]), undefined);
});

test('backfill script fills entryPoint from report, then heuristic, and rebuilds the index', async () => {
  const root = await tmp('blockbase-ep-backfill-');
  const store = new RevisionStore({ catalogRoot: root });
  const a = await importSource('-', { catalogRoot: root, stdin: card, entryPoint: 'Card.tsx', namespace: 'bf', slug: 'a' });
  const b = await importSource('-', { catalogRoot: root, stdin: card, entryPoint: 'Card.tsx', namespace: 'bf', slug: 'b' });
  // Strip entryPoint to simulate pre-existing catalog entries.
  for (const [r, slug] of [[a, 'a'], [b, 'b']]) {
    const manifest = await store.readManifest('bf', slug);
    const { entryPoint, ...rest } = manifest;
    const path = join(r.componentPath, 'component.json');
    const raw = JSON.parse(await readFile(path, 'utf8'));
    delete raw.entryPoint;
    await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`);
    assert.equal(rest.entryPoint, undefined);
  }
  await writeFile(join(root, 'migration-report.json'), JSON.stringify({ entries: [{ componentId: a.manifest.componentId, entryPoint: 'Card.tsx' }] }));
  const dry = JSON.parse(execFileSync('node', [backfillScript, '--catalog', root, '--dry-run', '--json'], { encoding: 'utf8' }));
  assert.deepEqual(dry, { updated: 2, skipped: 0, fromReport: 1, fromHeuristic: 1, dryRun: true });
  assert.equal(JSON.parse(await readFile(join(a.componentPath, 'component.json'), 'utf8')).entryPoint, undefined);
  const real = JSON.parse(execFileSync('node', [backfillScript, '--catalog', root, '--json'], { encoding: 'utf8' }));
  assert.deepEqual(real, { updated: 2, skipped: 0, fromReport: 1, fromHeuristic: 1 });
  for (const r of [a, b]) {
    const stored = JSON.parse(await readFile(join(r.componentPath, 'component.json'), 'utf8'));
    assert.equal(stored.entryPoint, 'Card.tsx');
    assert.equal(stored.manifestVersion, 2);
  }
  assert.equal(await indexRowCount(root), 2);
  const again = JSON.parse(execFileSync('node', [backfillScript, '--catalog', root, '--json'], { encoding: 'utf8' }));
  assert.equal(again.updated, 0);
  assert.equal(again.skipped, 2);
});
