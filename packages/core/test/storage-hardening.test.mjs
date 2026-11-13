import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  RevisionLockError,
  StaleManifestError,
  importEnvelope,
  recoverRevisionStore,
  sha256,
} from '../dist/index.js';

function envelope(content) {
  return {
    schemaVersion: '1',
    sourceType: 'file',
    files: [{ path: 'Card.tsx', content, contentHash: sha256(content) }],
    assets: [],
    entryPoint: 'Card.tsx',
    provenance: { sourceType: 'file', locator: 'fixture/Card.tsx' },
  };
}

test('optimistic revision and metadata versions reject stale writers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-store-stale-'));
  const catalogRoot = join(root, 'catalog');
  const first = await importEnvelope(envelope('export const card = 1;\n'), { catalogRoot, namespace: 'tests', slug: 'card' });
  const second = await importEnvelope(envelope('export const card = 2;\n'), {
    catalogRoot,
    namespace: 'tests',
    slug: 'card',
    expectedRevision: first.revisionId,
  });
  assert.notEqual(second.revisionId, first.revisionId);
  assert.equal(second.manifest.manifestVersion, 2);
  await assert.rejects(
    () => importEnvelope(envelope('export const card = 3;\n'), { catalogRoot, namespace: 'tests', slug: 'card', expectedRevision: first.revisionId }),
    (error) => error instanceof StaleManifestError && error.code === 'STORE_STALE_MANIFEST',
  );
  assert.equal(JSON.parse(await readFile(join(second.componentPath, 'component.json'), 'utf8')).currentRevision, second.revisionId);
});

test('a held component lock returns a typed stable conflict', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-store-lock-'));
  const catalogRoot = join(root, 'catalog');
  const first = await importEnvelope(envelope('export const card = 1;\n'), { catalogRoot, namespace: 'tests', slug: 'card' });
  const lockPath = `${first.componentPath}.lock`;
  await writeFile(lockPath, '{}');
  try {
    await assert.rejects(
      () => importEnvelope(envelope('export const card = 2;\n'), { catalogRoot, namespace: 'tests', slug: 'card' }),
      (error) => error instanceof RevisionLockError && error.code === 'STORE_LOCKED',
    );
  } finally {
    await rm(lockPath, { force: true });
  }
});

test('recovery removes staging, temporary manifests, and locks without touching authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-store-recovery-'));
  const catalogRoot = join(root, 'catalog');
  const first = await importEnvelope(envelope('export const card = 1;\n'), { catalogRoot, namespace: 'tests', slug: 'card' });
  const revisionsPath = join(first.componentPath, 'revisions');
  const revisionStaging = join(revisionsPath, '.staging-crashed');
  const packageStaging = join(catalogRoot, 'components', '.staging-crashed');
  const temporaryManifest = join(first.componentPath, 'component.json.tmp-crashed');
  await mkdir(join(revisionStaging, 'original'), { recursive: true });
  await mkdir(packageStaging, { recursive: true });
  await writeFile(temporaryManifest, '{}');
  await writeFile(`${first.componentPath}.lock`, '{}');
  const result = await recoverRevisionStore(catalogRoot);
  assert.equal(result.removed.length, 4);
  await assert.rejects(() => stat(revisionStaging));
  await assert.rejects(() => stat(packageStaging));
  await assert.rejects(() => stat(temporaryManifest));
  await assert.rejects(() => stat(`${first.componentPath}.lock`));
  assert.equal(await readFile(join(first.revisionPath, 'original/Card.tsx'), 'utf8'), 'export const card = 1;\n');
  assert.equal(JSON.parse(await readFile(join(first.componentPath, 'component.json'), 'utf8')).currentRevision, first.revisionId);
});
