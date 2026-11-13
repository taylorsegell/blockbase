import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, symlink, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  ImportError,
  RevisionStore,
  canonicalizeSourceEnvelope,
  importEnvelope,
  importSource,
  readLocalSource,
  readStdinSource,
  sha256,
} from '../dist/index.js';

const manifestPath = resolve(import.meta.dirname, '../../contracts/fixtures/v1/component-manifest.json');

async function fixtureManifest() {
  return JSON.parse(await readFile(manifestPath, 'utf8'));
}

test('file, directory, and stdin adapters canonicalize equivalent React content identically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-import-equivalent-'));
  const sourceDir = join(root, 'source');
  await mkdir(sourceDir);
  const content = 'export function Card() { return <div>Card</div>; }\n';
  const file = join(root, 'Card.tsx');
  await writeFile(file, content);
  await writeFile(join(sourceDir, 'Card.tsx'), content);
  const direct = await readLocalSource(file);
  const directory = await readLocalSource(sourceDir);
  const stdin = readStdinSource(content, { entryPoint: 'Card.tsx' });
  assert.deepEqual(direct.envelope.files, directory.envelope.files);
  assert.deepEqual(direct.envelope.files, stdin.envelope.files);
  assert.equal((await importSource(file, { catalogRoot: join(root, 'catalog-a') })).revisionId, (await importSource('-', { catalogRoot: join(root, 'catalog-b'), stdin: content, entryPoint: 'Card.tsx' })).revisionId);
  assert.equal(direct.envelope.files[0].contentHash, sha256(Buffer.from(content)));
});

test('import commits immutable originals with deterministic hashes and no execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-import-commit-'));
  const source = join(root, 'source');
  const catalog = join(root, 'catalog');
  const marker = join(root, 'executed.txt');
  await mkdir(source);
  await writeFile(join(source, 'index.tsx'), 'export function Card() { return <div />; }\n');
  await writeFile(join(source, 'package.json'), JSON.stringify({ scripts: { preinstall: `echo bad > ${marker}` } }));
  const result = await importSource(source, { catalogRoot: catalog, namespace: 'tests', slug: 'card' });
  assert.match(result.revisionId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(await readFile(join(result.revisionPath, 'original/index.tsx'), 'utf8'), 'export function Card() { return <div />; }\n');
  assert.equal(await readFile(join(result.revisionPath, 'original/package.json'), 'utf8'), JSON.stringify({ scripts: { preinstall: `echo bad > ${marker}` } }));
  await assert.rejects(() => stat(marker));
  const again = await importSource(source, { catalogRoot: catalog, namespace: 'tests', slug: 'card' });
  assert.equal(again.revisionId, result.revisionId);
  assert.equal(await readFile(join(result.componentPath, 'component.json'), 'utf8').then((value) => JSON.parse(value).currentRevision), result.revisionId);
});

test('invalid paths, entry points, symlinks, hashes, and frameworks have stable rejection codes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-import-reject-'));
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'Card.tsx'), 'export function Card() { return null; }\n');
  await assert.rejects(() => importSource(join(root, 'missing.tsx'), { catalogRoot: join(root, 'catalog') }), (error) => error instanceof ImportError && error.code === 'IMPORT_SOURCE_NOT_FOUND');
  await assert.rejects(() => readLocalSource(source, { entryPoint: '../Card.tsx' }), (error) => error instanceof ImportError && error.code === 'IMPORT_PATH_TRAVERSAL');
  await assert.rejects(() => readLocalSource(source, { entryPoint: 'Missing.tsx' }), (error) => error instanceof ImportError && error.code === 'IMPORT_ENTRYPOINT_NOT_FOUND');
  const outside = join(root, 'outside.tsx');
  await writeFile(outside, 'export function Outside() { return null; }\n');
  await symlink(outside, join(source, 'escape.tsx'));
  await assert.rejects(() => readLocalSource(source), (error) => error instanceof ImportError && error.code === 'IMPORT_SYMLINK_ESCAPE');
  assert.throws(() => canonicalizeSourceEnvelope({ schemaVersion: '1', sourceType: 'file', files: [{ path: '../Card.tsx', content: 'x', contentHash: sha256('x') }], assets: [], provenance: { sourceType: 'file', locator: 'x' } }), (error) => error instanceof ImportError && error.code === 'IMPORT_PATH_TRAVERSAL');
  const manifest = await fixtureManifest();
  manifest.framework = 'vue';
  await assert.rejects(() => importSource(join(root, 'source/Card.tsx'), { catalogRoot: join(root, 'catalog'), manifest }), (error) => error instanceof ImportError && error.code === 'IMPORT_UNSUPPORTED_FRAMEWORK');
});

test('failure after atomic revision rename leaves the prior complete revision visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-import-atomic-'));
  const source = join(root, 'source');
  const catalog = join(root, 'catalog');
  await mkdir(source);
  await writeFile(join(source, 'index.tsx'), 'export function Card() { return <div>one</div>; }\n');
  const first = await importSource(source, { catalogRoot: catalog, namespace: 'tests', slug: 'atomic' });
  await writeFile(join(source, 'index.tsx'), 'export function Card() { return <div>two</div>; }\n');
  await assert.rejects(() => importSource(source, { catalogRoot: catalog, namespace: 'tests', slug: 'atomic', onCommitStep: (step) => { if (step === 'revision-renamed') throw new Error('injected'); } }), (error) => error instanceof ImportError && error.code === 'IMPORT_COMMIT_FAILED');
  const current = JSON.parse(await readFile(join(first.componentPath, 'component.json'), 'utf8'));
  assert.equal(current.currentRevision, first.revisionId);
  assert.equal(await readFile(join(first.revisionPath, 'original/index.tsx'), 'utf8'), 'export function Card() { return <div>one</div>; }\n');
  const revisions = await import('node:fs/promises').then(({ readdir }) => readdir(join(first.componentPath, 'revisions')));
  assert.equal(revisions.length, 2);
});

test('envelope import consumes a v1 manifest and writes source provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-import-envelope-'));
  const manifest = await fixtureManifest();
  const content = 'export function Card() { return <div />; }\n';
  const source = {
    schemaVersion: '1', sourceType: 'file', files: [{ path: 'Card.tsx', content, contentHash: sha256(content) }], assets: [], entryPoint: 'Card.tsx', provenance: { sourceType: 'file', locator: 'fixture/Card.tsx' },
  };
  const result = await importEnvelope(source, { catalogRoot: join(root, 'catalog'), manifest });
  assert.equal(result.manifest.currentRevision, result.revisionId);
  assert.equal(result.manifest.provenance.locator, 'fixture/Card.tsx');
});
