import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  IMPORT_ERROR_CODES,
  ImportError,
  InboxError,
  addInboxPaste,
  importInboxItem,
  importPaste,
  listInbox,
  showInboxItem,
} from '../dist/index.js';

const fixture = (name) => readFile(resolve(import.meta.dirname, 'fixtures/twentyfirst', name), 'utf8');
const tempCatalog = async () => join(await mkdtemp(join(tmpdir(), 'blockbase-inbox-paste-')), 'catalog');
const now = new Date('2026-11-04T12:00:00.000Z');

test('a plain inbox paste serializes exactly as before and carries no from key', async () => {
  const catalogRoot = await tempCatalog();
  const parked = await addInboxPaste({ catalogRoot, content: 'export function Parked() { return null; }\n', label: 'Parked', entryPoint: 'Parked.tsx', now });
  const expected = `{\n  "addedAt": "2026-11-04T12:00:00.000Z",\n  "entryPoint": "Parked.tsx",\n  "id": "${parked.id}",\n  "kind": "paste",\n  "label": "Parked",\n  "originalPath": null,\n  "schemaVersion": "1"\n}\n`;
  assert.equal(await readFile(join(catalogRoot, 'inbox', parked.id, 'item.json'), 'utf8'), expected);
  const keys = ['schemaVersion', 'id', 'kind', 'label', 'addedAt', 'originalPath', 'entryPoint', 'payloadPath'];
  assert.deepEqual(Object.keys(parked), keys);
  assert.deepEqual(Object.keys(await showInboxItem(catalogRoot, parked.id)), keys);
  const [listed] = await listInbox(catalogRoot);
  assert.deepEqual(Object.keys(listed), keys);
  assert.equal('from' in listed, false);
  assert.equal(JSON.stringify(listed), JSON.stringify(parked));
});

test('a 21st paste is parked untouched as paste.txt and shows from 21st', async () => {
  const catalogRoot = await tempCatalog();
  const paste = await fixture('current-format.txt');
  const parked = await addInboxPaste({ catalogRoot, content: paste, from: '21st', now });
  assert.equal(parked.from, '21st');
  assert.equal(parked.entryPoint, null);
  assert.equal(parked.label, '21st paste');
  assert.deepEqual(await readdir(parked.payloadPath), ['paste.txt']);
  assert.equal(await readFile(join(parked.payloadPath, 'paste.txt'), 'utf8'), paste);
  const record = JSON.parse(await readFile(join(catalogRoot, 'inbox', parked.id, 'item.json'), 'utf8'));
  assert.equal(record.from, '21st');
  assert.equal((await showInboxItem(catalogRoot, parked.id)).from, '21st');
  assert.equal((await listInbox(catalogRoot))[0].from, '21st');
  const labelled = await addInboxPaste({ catalogRoot, content: paste, from: '21st', label: 'Skyline', now });
  assert.equal(labelled.label, 'Skyline');
});

test('an unreadable 21st paste is rejected at add time and nothing is parked', async () => {
  const catalogRoot = await tempCatalog();
  const content = await fixture('unreadable-prose.txt');
  await assert.rejects(
    () => addInboxPaste({ catalogRoot, content, from: '21st', now }),
    (error) => error instanceof ImportError && error.code === IMPORT_ERROR_CODES.pasteUnreadable,
  );
  assert.deepEqual(await listInbox(catalogRoot), []);
  const entries = await readdir(join(catalogRoot, 'inbox')).catch(() => []);
  assert.deepEqual(entries, []);
});

test('inbox import of a 21st paste matches a live import and reports paste and demo', async () => {
  const live = await importPaste(await fixture('current-format.txt'), { catalogRoot: await tempCatalog() });
  const catalogRoot = await tempCatalog();
  const parked = await addInboxPaste({ catalogRoot, content: await fixture('current-format.txt'), from: '21st', now });
  const result = await importInboxItem(catalogRoot, parked.id, {});
  assert.equal(result.discarded, true);
  assert.equal(result.imported.revisionId, live.revisionId);
  assert.equal(result.imported.manifest.slug, 'skyline-card');
  assert.equal(result.imported.reading.format, 'filename-fences');
  assert.equal(result.imported.demo.installed, true);
  assert.deepEqual(result.imported.demo.rewrites, [{ from: '@/components/ui/skyline-card', to: '@block' }]);
  assert.equal(await readFile(result.imported.rawPastePath, 'utf8'), await fixture('current-format.txt'));
  await assert.rejects(() => showInboxItem(catalogRoot, parked.id), (error) => error instanceof InboxError && error.code === 'INBOX_NOT_FOUND');
});

test('inbox import of a 21st paste applies provenance extras and reports suspicions', async () => {
  const catalogRoot = await tempCatalog();
  const parked = await addInboxPaste({ catalogRoot, content: await fixture('suspect-truncated.txt'), from: '21st', now });
  const result = await importInboxItem(catalogRoot, parked.id, { extras: { license: 'MIT', author: 'Example Author', sourceUrl: 'https://example.invalid/x', tags: ['hero'] } });
  assert.equal(result.imported.manifest.provenance.license, 'MIT');
  assert.equal(result.imported.manifest.provenance.author, 'Example Author');
  assert.equal(result.imported.envelope.provenance.locator, 'https://example.invalid/x');
  assert.ok(result.imported.manifest.tags.includes('hero'));
  assert.ok(result.imported.reading.suspicions.length > 0);
  assert.ok(result.imported.warnings.some((warning) => warning.startsWith('paste-suspect:')));
});

test('inbox import of an unnamed 21st paste needs a name, and keeps the item parked', async () => {
  const catalogRoot = await tempCatalog();
  const parked = await addInboxPaste({ catalogRoot, content: await fixture('bare-fenced.txt'), from: '21st', now });
  await assert.rejects(() => importInboxItem(catalogRoot, parked.id, {}), (error) => error instanceof ImportError && error.code === IMPORT_ERROR_CODES.pasteNameRequired);
  assert.equal((await showInboxItem(catalogRoot, parked.id)).from, '21st');
  const result = await importInboxItem(catalogRoot, parked.id, { displayName: 'Bare Card' });
  assert.equal(result.discarded, true);
  assert.equal(result.imported.manifest.slug, 'bare-card');
});

test('inbox import of a plain item applies provenance extras', async () => {
  const catalogRoot = await tempCatalog();
  const parked = await addInboxPaste({ catalogRoot, content: 'export function Parked() { return null; }\n', entryPoint: 'Parked.tsx', now });
  const result = await importInboxItem(catalogRoot, parked.id, { slug: 'parked', extras: { license: 'MIT' } });
  assert.equal(result.imported.manifest.provenance.license, 'MIT');
  assert.equal('reading' in result.imported, false);
});
