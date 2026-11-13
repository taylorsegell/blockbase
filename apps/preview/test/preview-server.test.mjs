import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { importPaste, importSource } from '@blockbase/core';
import { startPreviewServer } from '../dist/server/index.js';

const here = dirname(fileURLToPath(import.meta.url));
let dir;
let catalogRoot;
let server;
let base;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function json(path, init) {
  const res = await fetch(base + path, init);
  return { res, body: await res.json() };
}

async function until(check, label, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function importCard(slug, name) {
  const file = join(dir, `${name}.tsx`);
  await writeFile(file, `export function ${name}() { return <div className="p-4">${name}</div>; }\nexport default ${name};\n`);
  return importSource(file, { catalogRoot, namespace: 'fixture', slug, displayName: name });
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'blockbase-preview-test-'));
  catalogRoot = join(dir, 'catalog');
  await importCard('first-card', 'FirstCard');
  server = await startPreviewServer({ catalogRoot, port: await freePort() });
  base = server.url.replace(/\/$/, '');
});

after(async () => {
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('health reports the catalog root, url, and component count as JSON', async () => {
  const { res, body } = await json('/api/health');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assert.equal(body.schemaVersion, '1');
  assert.equal(body.catalogRoot, catalogRoot);
  assert.equal(body.url, server.url);
  assert.equal(body.count, 1);
});

test('catalog lists entries with entry point and revision', async () => {
  const { body } = await json('/api/catalog');
  assert.equal(body.entries.length, 1);
  const [entry] = body.entries;
  assert.equal(entry.slug, 'first-card');
  assert.equal(entry.displayName, 'FirstCard');
  assert.equal(entry.entryPoint, 'FirstCard.tsx');
  assert.equal(entry.bucket, null);
  assert.match(entry.revisionId, /^sha256:/);
  assert.ok(Array.isArray(body.families));
});

test('virtual module exposes a loader per entry', async () => {
  const res = await fetch(`${base}/@id/__x00__virtual:blockbase-catalog`);
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.match(text, /export const loaders/);
  assert.match(text, /cmp_fixture_first-card/);
  assert.match(text, /\/@fs\//);
});

test('tag edits go through core and change the manifest, not metadata.json', async () => {
  const { body: before } = await json('/api/catalog');
  const componentId = before.entries[0].componentId;
  const manifestPath = join(catalogRoot, 'components', 'fixture', 'first-card', 'component.json');
  const manifestBefore = await readFile(manifestPath, 'utf8');
  const { res, body } = await json('/api/tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ componentId, tags: ['alpha', 'beta'] }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(body.tagsBySlug[componentId], ['alpha', 'beta']);
  assert.deepEqual(body.tagsBySlug['first-card'], ['alpha', 'beta']);
  const manifestAfter = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.notEqual(JSON.stringify(manifestAfter), manifestBefore);
  assert.deepEqual([...manifestAfter.tags].sort(), ['alpha', 'beta']);

  // Removing a tag is a diff too.
  const removed = await json('/api/tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ componentId, tags: ['beta'] }),
  });
  assert.deepEqual(removed.body.tagsBySlug[componentId], ['beta']);
  assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')).tags, ['beta']);

  // The preview server never writes metadata.json itself; core's own sync may. Assert the manifest is the source.
  const catalog = await json('/api/catalog');
  assert.deepEqual(catalog.body.entries[0].tags, ['beta']);
});

test('collections endpoint maps core errors to JSON status codes', async () => {
  const post = (payload) =>
    json('/api/collections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const created = await post({ op: 'create', id: 'picks', title: 'Picks' });
  assert.equal(created.res.status, 200);
  assert.ok(created.body.collections.some((collection) => collection.id === 'picks'));
  const duplicate = await post({ op: 'create', id: 'picks', title: 'Picks' });
  assert.equal(duplicate.res.status, 409);
  assert.equal(duplicate.body.code, 'ORGANIZE_DUPLICATE_COLLECTION');
  const missing = await post({ op: 'add', id: 'picks', slug: 'nope' });
  assert.equal(missing.res.status, 404);
  const bad = await post({ op: 'wat', id: 'picks' });
  assert.equal(bad.res.status, 400);
  const added = await post({ op: 'add', id: 'picks', slug: 'first-card' });
  assert.deepEqual(added.body.collections.find((collection) => collection.id === 'picks').slugs, ['first-card']);
  const state = await json('/api/state');
  assert.ok(state.body.collections.some((collection) => collection.id === 'picks'));
  assert.equal(typeof state.body.metadataVersion, 'number');
});

test('should return 404 NOT_FOUND for the removed handoff route', async () => {
  const { res, body } = await json('/api/handoff', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ componentId: 'cmp_fixture_first-card' }),
  });
  assert.equal(res.status, 404);
  assert.equal(body.code, 'NOT_FOUND');
});

test('/api/* is served before the HTML fallback', async () => {
  const res = await fetch(`${base}/api/nope`);
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  const body = await res.json();
  assert.equal(body.code, 'NOT_FOUND');
  const missing = await json('/api/components/cmp_missing');
  assert.equal(missing.res.status, 404);
  const html = await fetch(`${base}/`);
  assert.match(await html.text(), /<div id="root">/);
});

test('a new component.json refreshes the catalog and the virtual module', async () => {
  assert.equal((await json('/api/catalog')).body.entries.length, 1);
  await importCard('second-card', 'SecondCard');
  await until(async () => (await json('/api/catalog')).body.entries.length === 2, 'catalog count 2');
  const text = await until(async () => {
    const res = await fetch(`${base}/@id/__x00__virtual:blockbase-catalog`);
    const body = await res.text();
    return body.includes('cmp_fixture_second-card') ? body : null;
  }, 'virtual module reload');
  assert.match(text, /second-card/);
  assert.equal((await json('/api/health')).body.count, 2);
});

test('a demo.tsx beside component.json is served as the preview and imports the block through @block', async () => {
  const demoPath = join(catalogRoot, 'components', 'fixture', 'first-card', 'demo.tsx');
  await writeFile(demoPath, `import { FirstCard } from '@block';\nexport default function Demo() { return <FirstCard />; }\n`);
  const text = await until(async () => {
    const res = await fetch(`${base}/@id/__x00__virtual:blockbase-catalog`);
    const body = await res.text();
    return /export const demos = \{\n\s+"cmp_fixture_first-card"/.test(body) ? body : null;
  }, 'demo in virtual module');
  assert.match(text, /export const loaders/);
  const entry = (await json('/api/catalog')).body.entries.find((item) => item.componentId === 'cmp_fixture_first-card');
  assert.equal(entry.hasDemo, true);
  const demo = await fetch(`${base}/@fs${demoPath}`);
  assert.equal(demo.status, 200);
  assert.match(await demo.text(), /\/revisions\/[0-9a-f]+\/original\//);
});

test('an imported 21st.dev paste shows its demo on the catalog page and the demo resolves to the block', async () => {
  const pastePath = join(here, '..', '..', '..', 'packages', 'core', 'test', 'fixtures', 'twentyfirst', 'current-format.txt');
  const imported = await importPaste(await readFile(pastePath, 'utf8'), { catalogRoot, namespace: 'fixture' });
  assert.equal(imported.demo.installed, true);
  const componentId = imported.manifest.componentId;
  const entry = await until(async () => {
    const found = (await json('/api/catalog')).body.entries.find((item) => item.componentId === componentId);
    return found?.hasDemo ? found : null;
  }, 'pasted block listed with a demo');
  assert.equal(entry.slug, 'skyline-card');
  assert.equal(entry.hasDemo, true);
  await until(async () => {
    const res = await fetch(`${base}/@id/__x00__virtual:blockbase-catalog`);
    const body = await res.text();
    return body.includes(JSON.stringify(componentId)) && /export const demos/.test(body) ? body : null;
  }, 'pasted demo in virtual module');
  const demo = await fetch(`${base}/@fs${imported.demo.path}`);
  assert.equal(demo.status, 200);
  assert.match(await demo.text(), /\/revisions\/[0-9a-f]+\/original\//);
});

test('src/server never imports from components/', async () => {
  const serverDir = join(here, '..', 'src', 'server');
  const files = (await readdir(serverDir)).filter((name) => name.endsWith('.ts'));
  assert.ok(files.length > 0);
  for (const name of files) {
    const text = await readFile(join(serverDir, name), 'utf8');
    for (const match of text.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)) {
      assert.doesNotMatch(match[1], /(^|\/)components(\/|$)/, `${name} imports ${match[1]}`);
    }
  }
  await stat(join(here, '..', 'dist', 'server', 'index.js'));
});

test('a busy port rejects with EADDRINUSE and leaves no server running', async () => {
  const started = Date.now();
  await assert.rejects(
    () => startPreviewServer({ catalogRoot, port: server.port }),
    (error) => error.code === 'EADDRINUSE',
  );
  assert.ok(Date.now() - started < 10_000);
});
