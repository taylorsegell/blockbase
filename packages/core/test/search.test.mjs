import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  INDEX_ERROR_CODES,
  INDEX_SCHEMA_VERSION,
  IndexError,
  diagnoseIndex,
  importEnvelope,
  indexPathFor,
  inspectComponent,
  rebuildIndex,
  searchComponents,
  sha256,
} from '../dist/index.js';

async function fixtureManifest() {
  return JSON.parse(await readFile(new URL('../../contracts/fixtures/v1/component-manifest.json', import.meta.url), 'utf8'));
}

async function addComponent(catalogRoot, values) {
  const manifest = await fixtureManifest();
  Object.assign(manifest, values);
  const content = `export function ${values.symbol}(){ return <div>${values.text}</div>; }\n`;
  return importEnvelope({
    schemaVersion: '1', sourceType: 'file', files: [{ path: `${values.symbol}.tsx`, content, contentHash: sha256(content) }], assets: [], entryPoint: `${values.symbol}.tsx`,
    provenance: { sourceType: 'file', locator: `fixture/${values.symbol}.tsx` },
  }, { catalogRoot, manifest });
}

test('rebuild projects committed manifests and reproduces searchable content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-search-rebuild-'));
  const catalog = join(root, 'catalog');
  await addComponent(catalog, { componentId: 'cmp_search_card', namespace: 'tests', slug: 'card', displayName: 'Animated Pricing Card', description: 'Animated pricing card for checkout.', aliases: ['pricing panel'], tags: ['pricing', 'card'], symbol: 'PricingCard', text: 'pricing' });
  const first = await rebuildIndex({ catalogRoot: catalog });
  const before = await searchComponents(catalog, 'animated pricing');
  await rm(indexPathFor(catalog));
  const second = await rebuildIndex({ catalogRoot: catalog });
  const after = await searchComponents(catalog, 'animated pricing');
  assert.equal(second.catalogRevision, first.catalogRevision);
  assert.equal(second.searchableContentHash, first.searchableContentHash);
  assert.deepEqual(after.results, before.results);
  assert.equal(second.componentCount, 1);
  await rm(root, { recursive: true, force: true });
});

test('deletion and schema mismatch are diagnosed and rebuilt without package loss', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-search-repair-'));
  const catalog = join(root, 'catalog');
  const imported = await addComponent(catalog, { componentId: 'cmp_search_repair', namespace: 'tests', slug: 'repair', displayName: 'Repair Card', tags: ['repair', 'card'], favorite: true, symbol: 'RepairCard', text: 'repair' });
  const progress = [];
  await rebuildIndex({ catalogRoot: catalog, onProgress: (event) => progress.push(event) });
  assert.equal((await diagnoseIndex({ catalogRoot: catalog })).classification, 'healthy');
  assert.ok(progress.some((event) => event.phase === 'write' && event.componentId === imported.manifest.componentId));

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(indexPathFor(catalog));
  db.exec('PRAGMA user_version = 999');
  db.close();
  await assert.rejects(() => searchComponents(catalog, 'repair'), (error) => {
    assert.ok(error instanceof IndexError);
    assert.equal(error.code, INDEX_ERROR_CODES.schemaMismatch);
    assert.equal(error.details.classification, 'schema-mismatch');
    assert.equal(error.details.expectedSchemaVersion, INDEX_SCHEMA_VERSION);
    return true;
  });
  assert.equal((await diagnoseIndex({ catalogRoot: catalog })).classification, 'schema-mismatch');

  await rm(indexPathFor(catalog));
  assert.equal((await diagnoseIndex({ catalogRoot: catalog })).classification, 'missing');
  const rebuilt = await rebuildIndex({ catalogRoot: catalog });
  const { openIndex } = await import('../dist/index.js');
  const opened = await openIndex({ catalogRoot: catalog });
  assert.equal(opened.db.prepare('SELECT COUNT(*) AS count FROM components').get().count, 1);
  assert.equal(opened.db.prepare('SELECT COUNT(*) AS count FROM component_tags').get().count, 2);
  assert.equal(opened.db.prepare('SELECT COUNT(*) AS count FROM component_favorites WHERE favorite = 1').get().count, 1);
  assert.equal(opened.db.prepare('SELECT COUNT(*) AS count FROM component_compatibility').get().count, 1);
  opened.close();
  assert.equal(rebuilt.projectionCounts.favorites, 1);
  assert.equal((await searchComponents(catalog, 'repair')).results[0].favorite, true);
  assert.equal(await readFile(join(imported.revisionPath, 'original', 'RepairCard.tsx')).then((value) => value.includes('repair')), true);
  await rm(root, { recursive: true, force: true });
});

test('concurrent readers see only complete old or new projections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-search-concurrency-'));
  const catalog = join(root, 'catalog');
  await addComponent(catalog, { componentId: 'cmp_search_concurrent', namespace: 'tests', slug: 'concurrent', displayName: 'Concurrent Card', symbol: 'ConcurrentCard', text: 'concurrent' });
  await rebuildIndex({ catalogRoot: catalog });
  const searches = Array.from({ length: 12 }, () => searchComponents(catalog, 'concurrent'));
  const rebuilds = Array.from({ length: 3 }, () => rebuildIndex({ catalogRoot: catalog }));
  const results = await Promise.all([...searches, ...rebuilds]);
  for (const result of results.slice(0, searches.length)) {
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].componentId, 'cmp_search_concurrent');
  }
  await rm(root, { recursive: true, force: true });
});

test('exact ID, alias, and revision inspection return manifest evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-search-inspect-'));
  const catalog = join(root, 'catalog');
  const imported = await addComponent(catalog, { componentId: 'cmp_search_inspect', namespace: 'tests', slug: 'inspect', displayName: 'Inspect Card', aliases: ['card alias'], symbol: 'InspectCard', text: 'inspect' });
  await rebuildIndex({ catalogRoot: catalog });
  const byId = await inspectComponent(catalog, imported.manifest.componentId);
  const byAlias = await inspectComponent(catalog, 'card alias', imported.revisionId);
  assert.equal(byId.lookup.matchedBy, 'id');
  assert.equal(byAlias.lookup.matchedBy, 'alias');
  assert.equal(byAlias.revisionId, imported.revisionId);
  assert.ok(byAlias.evidence.some((item) => item.field === 'revision'));
  await rm(root, { recursive: true, force: true });
});

test('ranking is deterministic, compatibility is explicit, and misses do not invent components', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-search-ranking-'));
  const catalog = join(root, 'catalog');
  await addComponent(catalog, { componentId: 'cmp_search_a', namespace: 'tests', slug: 'a', displayName: 'Pricing Card', description: 'An animated pricing card.', tags: ['pricing'], stylingModes: ['css'], symbol: 'PricingCardA', text: 'pricing' });
  await addComponent(catalog, { componentId: 'cmp_search_b', namespace: 'tests', slug: 'b', displayName: 'Pricing Panel', description: 'An animated pricing panel.', tags: ['pricing'], stylingModes: ['tailwind'], symbol: 'PricingPanelB', text: 'pricing' });
  const rebuilt = await rebuildIndex({ catalogRoot: catalog });
  const first = await searchComponents(catalog, 'animated pricing', { confidenceMargin: 0.2, compatibility: { framework: 'react', stylingModes: ['css'] } });
  const second = await searchComponents(catalog, 'animated pricing', { confidenceMargin: 0.2, compatibility: { framework: 'react', stylingModes: ['css'] } });
  assert.deepEqual(first, second);
  assert.equal(first.catalogRevision, rebuilt.catalogRevision);
  assert.equal(first.selection.status, 'needs-selection');
  assert.equal(first.results[0].componentId, 'cmp_search_a');
  assert.ok(first.results[0].compatibility.matched.includes('framework:react'));
  assert.ok(first.results[1].compatibility.conflicts.includes('styling:css'));
  const miss = await searchComponents(catalog, 'nonexistent galaxy widget');
  assert.deepEqual(miss.results, []);
  assert.equal(miss.selection.status, 'miss');
  assert.equal(miss.recoveryActions.length, 3);
  await rm(root, { recursive: true, force: true });
});

test('corrupt index returns a repair action and leaves committed packages intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-search-corrupt-'));
  const catalog = join(root, 'catalog');
  const imported = await addComponent(catalog, { componentId: 'cmp_search_corrupt', namespace: 'tests', slug: 'corrupt', displayName: 'Corrupt Test', symbol: 'CorruptTest', text: 'safe' });
  await rebuildIndex({ catalogRoot: catalog });
  await writeFile(indexPathFor(catalog), 'not a sqlite database');
  await assert.rejects(() => searchComponents(catalog, 'safe'), (error) => {
    assert.ok(error instanceof IndexError);
    assert.equal(error.code, INDEX_ERROR_CODES.corrupt);
    assert.equal(error.details.recoveryAction.id, 'rebuild-index');
    return true;
  });
  assert.equal(await readFile(join(imported.revisionPath, 'original', 'CorruptTest.tsx'), 'utf8').then((value) => value.includes('safe')), true);
  await rm(root, { recursive: true, force: true });
});
