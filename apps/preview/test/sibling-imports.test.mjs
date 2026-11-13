import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { importSource } from '@blockbase/core';
import { startPreviewServer } from '../dist/server/index.js';

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

async function importFile(namespace, slug, name, content) {
  const file = join(dir, `${name}.tsx`);
  await writeFile(file, content);
  return importSource(file, { catalogRoot, namespace, slug, displayName: name });
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'blockbase-preview-sibling-'));
  catalogRoot = join(dir, 'catalog');
  await importFile('shared', 'pill', 'Pill', 'export function Pill() { return <span>pill</span>; }\n');
  await importFile(
    'cards',
    'uses-pill',
    'UsesPill',
    "import { Pill } from '../../shared/pill';\nexport function UsesPill() { return <div><Pill /></div>; }\n",
  );
  await importFile(
    'cards',
    'uses-missing',
    'UsesMissing',
    "import { Nope } from '../../shared/not-in-catalog';\nexport function UsesMissing() { return <Nope />; }\n",
  );
  const disc = join(dir, 'disc');
  await mkdir(disc);
  await writeFile(
    join(disc, 'Player.tsx'),
    "export const src = new URL('./mark.svg', import.meta.url).href;\nexport function Player() { return <img src={src} alt=\"\" />; }\n",
  );
  await writeFile(join(disc, 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg" data-disc="1"></svg>\n');
  await importSource(disc, { catalogRoot, namespace: 'buttons', slug: 'disc', displayName: 'Player' });
  server = await startPreviewServer({ catalogRoot, port: await freePort() });
  base = server.url.replace(/\/$/, '');
});

after(async () => {
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

function moduleUrl(entry) {
  const hex = entry.revisionId.replace('sha256:', '');
  return `/@fs${catalogRoot}/components/${entry.namespace}/${entry.slug}/revisions/${hex}/original/${entry.entryPoint}`;
}

test('legacy sibling import resolves to the target component current revision', async () => {
  const { entries } = await (await fetch(`${base}/api/catalog`)).json();
  const user = entries.find((entry) => entry.slug === 'uses-pill');
  const pill = entries.find((entry) => entry.slug === 'pill');
  const res = await fetch(base + moduleUrl(user));
  const code = await res.text();
  assert.equal(res.status, 200, code.slice(0, 400));
  const hex = pill.revisionId.replace('sha256:', '');
  assert.match(code, new RegExp(`/shared/pill/revisions/${hex}/original/Pill\\.tsx`));
});

test('a relative asset url is served from the revision assets directory', async () => {
  const { entries } = await (await fetch(`${base}/api/catalog`)).json();
  const disc = entries.find((entry) => entry.slug === 'disc');
  const hex = disc.revisionId.replace('sha256:', '');
  const url = `/@fs${catalogRoot}/components/buttons/disc/revisions/${hex}/original/mark.svg`;
  const res = await fetch(base + url);
  const body = await res.text();
  assert.equal(res.status, 200, body.slice(0, 200));
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
  assert.match(body, /data-disc="1"/);
});

test('a sibling that is not in the catalog keeps the normal Vite error', async () => {
  const { entries } = await (await fetch(`${base}/api/catalog`)).json();
  const user = entries.find((entry) => entry.slug === 'uses-missing');
  const res = await fetch(base + moduleUrl(user));
  assert.notEqual(res.status, 200);
});

test('write routes refuse cross-site simple requests', async () => {
  const body = JSON.stringify({ componentId: 'cmp_shared_pill', tags: [] });
  const plain = await fetch(`${base}/api/tags`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body });
  assert.equal(plain.status, 415);
  const foreign = await fetch(`${base}/api/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body,
  });
  assert.equal(foreign.status, 403);
  const same = await fetch(`${base}/api/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ componentId: 'cmp_shared_pill', tags: ['ok'] }),
  });
  assert.equal(same.status, 200);
});
