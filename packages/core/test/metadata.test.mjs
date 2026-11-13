import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { stableStringify } from '@blockbase/contracts';
import {
  MetadataConflictError,
  exportCatalogMetadata,
  initialCatalogMetadata,
  metadataPathFor,
  readCatalogMetadata,
  updateCatalogMetadata,
} from '../dist/index.js';

test('catalog metadata is normalized, durable, reversible, and rejects stale writers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-metadata-'));
  const known = new Set(['card', 'panel']);
  const initial = initialCatalogMetadata({ card: [' Featured ', 'featured'], panel: [] }, [{ id: 'favorites', title: 'Favorites', reserved: true, slugs: ['card'] }], known);
  assert.deepEqual(initial.tagsBySlug.card, ['featured']);
  const first = await updateCatalogMetadata(root, initial, { tagsBySlug: { card: ['New', 'new'], panel: ['beta'] }, expectedVersion: 0 }, known);
  assert.equal(first.metadataVersion, 1);
  assert.deepEqual(first.tagsBySlug, { card: ['new'], panel: ['beta'] });
  await assert.rejects(() => updateCatalogMetadata(root, first, { expectedVersion: 0, tagsBySlug: first.tagsBySlug }, known), (error) => error instanceof MetadataConflictError && error.code === 'METADATA_CONFLICT');
  const loaded = await readCatalogMetadata(root, initial);
  assert.deepEqual(loaded, first);
  const exported = await exportCatalogMetadata(root, initial);
  assert.equal(exported.path, metadataPathFor(root));
  assert.match(exported.hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(await readFile(exported.path, 'utf8'), stableStringify(exported.metadata));
});

test('metadata collection updates reserve Favorites and drop unknown slugs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-metadata-'));
  const known = new Set(['card']);
  const initial = initialCatalogMetadata({ card: [] }, [], known);
  const next = await updateCatalogMetadata(root, initial, { collections: [{ id: 'ideas', title: 'Ideas', reserved: false, slugs: ['card', 'missing'] }] }, known);
  assert.deepEqual(next.collections, [
    { id: 'favorites', title: 'Favorites', reserved: true, slugs: [] },
    { id: 'ideas', title: 'Ideas', reserved: false, slugs: ['card'] },
  ]);
});

test('concurrent metadata writers serialize and preserve one committed version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-metadata-'));
  const known = new Set(['card']);
  const initial = initialCatalogMetadata({ card: [] }, [], known);
  const results = await Promise.allSettled([
    updateCatalogMetadata(root, initial, { expectedVersion: 0, tagsBySlug: { card: ['first'] } }, known),
    updateCatalogMetadata(root, initial, { expectedVersion: 0, tagsBySlug: { card: ['second'] } }, known),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.code === 'METADATA_CONFLICT').length, 1);
  assert.equal((await readCatalogMetadata(root, initial)).metadataVersion, 1);
});
