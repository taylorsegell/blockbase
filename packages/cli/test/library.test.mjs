import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { executeLibrary } from '../dist/library.js';

const executable = resolve(import.meta.dirname, '../dist/index.js');
const fixture = resolve(import.meta.dirname, '../../../tests/fixtures/sources/normalization/static-tailwind/StaticCard.tsx');

function invoke(args, input) {
  const result = spawnSync(process.execPath, [executable, ...args], { encoding: 'utf8', input });
  return { ...result, json: result.stdout.trim() ? JSON.parse(result.stdout) : null };
}

test('inbox, family, and tag commands return JSON envelopes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-cli-library-'));
  const catalog = ['--catalog', root, '--json'];
  const parked = invoke(['inbox', 'add', '--path', fixture, '--name', 'Static Card', ...catalog]);
  assert.equal(parked.status, 0, parked.stderr);
  assert.equal(parked.json.operation, 'inbox.add');
  assert.equal(parked.json.data.kind, 'path');
  const paste = 'export function Pasted() { return null; }\n';
  const pasted = invoke(['inbox', 'add', '-', '--entry-point', 'Pasted.tsx', ...catalog], paste);
  assert.equal(pasted.status, 0, pasted.stderr);
  assert.equal(await readFile(join(pasted.json.data.payloadPath, 'Pasted.tsx'), 'utf8'), paste);

  const imported = invoke(['inbox', 'import', parked.json.data.id, '--namespace', 'local', '--slug', 'static-card', '--name', 'Static Card', ...catalog]);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.json.data.discarded, true);
  const componentId = imported.json.data.manifest.componentId;

  const missingFamily = invoke(['family', 'set', componentId, '--family', 'cards', ...catalog]);
  assert.equal(missingFamily.status, 4);
  assert.equal(missingFamily.json.error.code, 'ORGANIZE_UNKNOWN_FAMILY');
  const family = invoke(['family', 'set', componentId, '--family', 'cards', '--create', '--name', 'Cards', ...catalog]);
  assert.equal(family.status, 0, family.stderr);
  assert.equal(family.json.data.component.category, 'cards');

  const tag = invoke(['tag', 'add', 'static-card', '--tag', 'Featured', ...catalog]);
  assert.equal(tag.status, 0, tag.stderr);
  assert.deepEqual(tag.json.data.tags, ['featured']);
  const tags = invoke(['tag', 'list', ...catalog]);
  assert.equal(tags.json.data.components.length, 1);

  const collection = invoke(['collection', 'create', '--id', 'ideas', '--title', 'Ideas', ...catalog]);
  assert.equal(collection.status, 0, collection.stderr);
  assert.ok(collection.json.data.collections.some((entry) => entry.id === 'ideas'));
});

test('a missing argument exits with usage code and ORGANIZE_INVALID_ARGUMENT', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-cli-library-'));
  const { exitCode, envelope } = await executeLibrary({ operation: 'tag.add', catalogRoot: root, source: 'static-card', create: false });
  assert.equal(exitCode, 2);
  assert.equal(envelope.error.code, 'ORGANIZE_INVALID_ARGUMENT');
});

test('history commands list, undo, and restore catalog changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-cli-history-'));
  const catalog = ['--catalog', root, '--json'];
  assert.equal(invoke(['import', fixture, '--namespace', 'local', '--slug', 'static-card', ...catalog]).status, 0);
  assert.equal(invoke(['tag', 'add', 'static-card', '--tag', 'hero', ...catalog]).status, 0);

  const listed = invoke(['history', 'list', 'static-card', '--limit', '5', ...catalog]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.json.operation, 'history.list');
  assert.deepEqual(listed.json.data.entries.map((entry) => entry.operation), ['tag.add', 'import']);

  const undone = invoke(['history', 'undo', ...catalog]);
  assert.equal(undone.status, 0, undone.stderr);
  assert.equal(undone.json.data.undone[0].operation, 'tag.add');
  assert.deepEqual(invoke(['tag', 'list', 'static-card', ...catalog]).json.data.components[0].tags, []);

  const importCommit = listed.json.data.entries[1].shortCommit;
  assert.equal(invoke(['history', 'restore', 'static-card', ...catalog]).status, 2);
  const restored = invoke(['history', 'restore', 'static-card', '--to', importCommit, ...catalog]);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(restored.json.data.component, 'local/static-card');

  const tooFar = invoke(['history', 'undo', '--steps', '99', ...catalog]);
  assert.equal(tooFar.status, 5);
  assert.equal(tooFar.json.error.code, 'HISTORY_NOTHING_TO_UNDO');
  assert.equal(invoke(['history', 'undo', '--steps', '1', '--to', importCommit, ...catalog]).status, 2);
});

test('catalog list returns every component with category, tags, description, bucket, and collections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-cli-list-'));
  const catalog = ['--catalog', root, '--json'];
  const empty = invoke(['catalog', 'list', ...catalog]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.json.operation, 'catalog.list');
  assert.deepEqual(empty.json.data.components, []);

  const parked = invoke(['inbox', 'add', '--path', fixture, '--name', 'Static Card', ...catalog]);
  const imported = invoke(['inbox', 'import', parked.json.data.id, '--namespace', 'local', '--slug', 'static-card', '--name', 'Static Card', ...catalog]);
  assert.equal(imported.status, 0, imported.stderr);
  invoke(['collection', 'add', 'favorites', 'static-card', ...catalog]);

  const listed = invoke(['catalog', 'list', ...catalog]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.json.ok, true);
  const [component] = listed.json.data.components;
  assert.equal(component.slug, 'static-card');
  assert.equal(component.displayName, 'Static Card');
  assert.equal(typeof component.description, 'string');
  assert.equal(typeof component.category, 'string');
  assert.ok(Array.isArray(component.tags));
  assert.equal(component.bucket, null);
  assert.ok(Array.isArray(listed.json.data.collections));

  const extra = invoke(['catalog', 'list', 'extra', ...catalog]);
  assert.equal(extra.status, 2);
});
