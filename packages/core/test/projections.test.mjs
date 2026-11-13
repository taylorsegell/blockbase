import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  applyLegacyMigration,
  checkPreviewProjectionDrift,
  generatePreviewProjections,
  inspectComponent,
  projectionJson,
  rebuildIndex,
  searchComponents,
  writePreviewProjections,
} from '../dist/index.js';

const legacy = resolve(import.meta.dirname, '../../../tests/fixtures/legacy-catalog/valid');

test('manifest projections are deterministic, drift checked, and preserve preview facets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-projection-'));
  const catalog = join(root, 'catalog');
  const collections = join(root, 'collections.yaml');
  await writeFile(collections, 'collections:\n  - id: favorites\n    title: Favorites\n    reserved: true\n    slugs: [arrow, missing]\n');
  await applyLegacyMigration({ sourceRoot: legacy, targetRoot: catalog });
  const outputDir = join(root, 'generated');
  const paths = { registryPath: join(outputDir, 'registry.json'), catalogPath: join(outputDir, 'catalog.json') };
  const first = await writePreviewProjections({ catalogRoot: catalog, collectionsPath: collections, ...paths });
  const registryBytes = await readFile(paths.registryPath, 'utf8');
  const catalogBytes = await readFile(paths.catalogPath, 'utf8');
  assert.equal(first.outputs.registry.counts.entries, 1);
  assert.deepEqual(first.outputs.registry.taxonomy.buckets, ['brick', 'build', 'creation']);
  assert.equal(first.outputs.registry.entries[0].name, 'buttons');
  assert.equal(first.outputs.registry.entries[0].bucket, 'build');
  assert.equal(first.outputs.registry.entries[0].categoryRoute, '/category/buttons');
  assert.deepEqual(first.outputs.registry.entries[0].facetInputs.tags, ['button']);
  assert.deepEqual(first.outputs.registry.dataAccounting.collections.unresolvedSlugs, ['missing']);
  assert.deepEqual(first.outputs.registry, first.outputs.catalog);
  assert.deepEqual(await generatePreviewProjections({ catalogRoot: catalog, collectionsPath: collections }), first.outputs);
  assert.deepEqual(await checkPreviewProjectionDrift({ catalogRoot: catalog, collectionsPath: collections, ...paths }), { registry: false, catalog: false });
  await writeFile(paths.catalogPath, `${catalogBytes} `);
  await assert.rejects(() => checkPreviewProjectionDrift({ catalogRoot: catalog, collectionsPath: collections, ...paths }), /drift detected/);
  await writePreviewProjections({ catalogRoot: catalog, collectionsPath: collections, ...paths });
  assert.equal(await readFile(paths.registryPath, 'utf8'), registryBytes);
  assert.equal(await readFile(paths.catalogPath, 'utf8'), catalogBytes);
  await rm(root, { recursive: true, force: true });
});

test('migrated manifests drive rebuild, search, inspect, adaptation, and validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-projection-integration-'));
  const catalog = join(root, 'catalog');
  await applyLegacyMigration({ sourceRoot: legacy, targetRoot: catalog });
  const rebuilt = await rebuildIndex({ catalogRoot: catalog });
  assert.equal(rebuilt.componentCount, 1);
  const projection = await generatePreviewProjections({ catalogRoot: catalog });
  const entry = projection.registry.entries[0];
  const search = await searchComponents(catalog, 'arrow');
  assert.equal(search.results[0].componentId, entry.componentId);
  const inspected = await inspectComponent(catalog, entry.componentId);
  assert.equal(entry.path, 'buttons/arrow');
  assert.equal(entry.packagePath, 'components/buttons/arrow');
  await rm(root, { recursive: true, force: true });
});

test('projection generation fails on undeclared catalog path collisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-projection-collision-'));
  const catalog = join(root, 'catalog');
  await applyLegacyMigration({ sourceRoot: legacy, targetRoot: catalog });
  const original = join(catalog, 'components', 'buttons', 'arrow');
  const first = join(catalog, 'components', 'empty-states', 'dino-404');
  const second = join(catalog, 'components', 'empty-states', 'snowboarder-404');
  await cp(original, first, { recursive: true });
  await cp(original, second, { recursive: true });
  for (const [path, componentId, slug] of [[first, 'cmp_empty_states_dino_404', 'dino-404'], [second, 'cmp_empty_states_snowboarder_404', 'snowboarder-404']]) {
    const manifestPath = join(path, 'component.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.componentId = componentId;
    manifest.namespace = 'empty-states';
    manifest.slug = slug;
    await writeFile(manifestPath, projectionJson(manifest));
  }
  const reportPath = join(catalog, 'migration-report.json');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  report.entries.push(
    { identity: 'empty-states/dino-404', target: { componentId: 'cmp_empty_states_dino_404' }, source: { name: 'empty-states', bucket: 'creation', slug: 'dino-404', path: 'empty-states/dino-404', exported: 'Arrow' } },
    { identity: 'empty-states/snowboarder-404', target: { componentId: 'cmp_empty_states_snowboarder_404' }, source: { name: 'empty-states', bucket: 'creation', slug: 'snowboarder-404', path: 'empty-states/dino-404', exported: 'Arrow' } },
  );
  await writeFile(reportPath, JSON.stringify(report));
  await rebuildIndex({ catalogRoot: catalog });
  await assert.rejects(() => generatePreviewProjections({ catalogRoot: catalog }), /catalog path collision/);
  await rm(root, { recursive: true, force: true });
});
