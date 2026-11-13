import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { importSource, importStdin } from '../dist/import/index.js';
import { InboxError, addInboxPaste, addInboxPath, importInboxItem, listInbox, showInboxItem } from '../dist/inbox/index.js';
import { OrganizeError, addCollectionSlug, addTag, createCollection, deleteCollection, listFamilies, listTags, removeTag, reorderCollectionSlug, setFamily } from '../dist/organize/index.js';

const fixture = resolve(import.meta.dirname, '../../../tests/fixtures/sources/normalization/static-tailwind/StaticCard.tsx');

async function catalogWithCard() {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-library-'));
  const imported = await importSource(fixture, { catalogRoot: root, namespace: 'local', slug: 'static-card', displayName: 'Static Card' });
  return { root, imported };
}

test('inbox stores a paste untouched and imports it later', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-inbox-'));
  try {
    const content = 'export function Parked() { return null; }\n';
    const parked = await addInboxPaste({ catalogRoot: root, content, label: 'Parked', entryPoint: 'Parked.tsx', now: new Date('2026-10-17T12:00:00.000Z') });
    assert.equal(await readFile(join(parked.payloadPath, 'Parked.tsx'), 'utf8'), content);
    assert.equal((await listInbox(root)).length, 1);
    const imported = await importInboxItem(root, parked.id, { namespace: 'local', slug: 'parked', displayName: 'Parked' });
    assert.equal(imported.discarded, true);
    assert.equal(imported.imported.manifest.slug, 'parked');
    await assert.rejects(() => showInboxItem(root, parked.id), (error) => error instanceof InboxError && error.code === 'INBOX_NOT_FOUND');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('inbox copies a path from outside the catalog and refuses a catalog path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-inbox-path-'));
  try {
    const parked = await addInboxPath({ catalogRoot: root, sourcePath: fixture });
    assert.equal(await readFile(join(parked.payloadPath, 'StaticCard.tsx'), 'utf8'), await readFile(fixture, 'utf8'));
    await assert.rejects(() => addInboxPath({ catalogRoot: root, sourcePath: root }), (error) => error instanceof InboxError && error.code === 'INBOX_INVALID_PATH');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('family, tags, and collections update the catalog and refuse unknown families', async () => {
  const { root, imported } = await catalogWithCard();
  try {
    const id = imported.manifest.componentId;
    await assert.rejects(() => setFamily(root, id, 'cards'), (error) => error instanceof OrganizeError && error.code === 'ORGANIZE_UNKNOWN_FAMILY');
    const assigned = await setFamily(root, id, 'cards', { create: true, name: 'Cards' });
    assert.equal(assigned.created, true);
    assert.equal(assigned.component.category, 'cards');
    const families = await listFamilies(root);
    assert.deepEqual(families.families, [{ name: 'Cards', slug: 'cards' }]);
    assert.deepEqual(families.unassigned, []);

    const tagged = await addTag(root, 'static-card', 'Featured');
    assert.deepEqual(tagged.tags, ['featured']);
    assert.deepEqual((await listTags(root, id)).components[0].tags, ['featured']);
    assert.deepEqual((await removeTag(root, id, 'featured')).tags, []);

    await createCollection(root, 'ideas', 'Ideas');
    const added = await addCollectionSlug(root, 'ideas', 'static-card');
    const ideas = added.collections.find((collection) => collection.id === 'ideas');
    assert.deepEqual(ideas.slugs, ['static-card']);
    const reordered = await reorderCollectionSlug(root, 'ideas', 'static-card', 0);
    assert.deepEqual(reordered.collections.find((collection) => collection.id === 'ideas').slugs, ['static-card']);
    await assert.rejects(() => deleteCollection(root, 'favorites'), (error) => error instanceof OrganizeError && error.code === 'ORGANIZE_RESERVED_COLLECTION');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('family set with an unknown component leaves taxonomy.json untouched', async () => {
  const { root } = await catalogWithCard();
  try {
    await assert.rejects(() => setFamily(root, 'missing-card', 'cards', { create: true }), (error) => error instanceof OrganizeError && error.code === 'ORGANIZE_NOT_FOUND');
    await assert.rejects(() => readFile(join(root, 'taxonomy.json'), 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tag writes keep metadata entries for slugs shared across namespaces', async () => {
  const { root, imported } = await catalogWithCard();
  try {
    await importSource(fixture, { catalogRoot: root, namespace: 'other', slug: 'static-card', displayName: 'Static Card' });
    await importSource(fixture, { catalogRoot: root, namespace: 'local', slug: 'solo', displayName: 'Solo' });
    await writeFile(join(root, 'metadata.json'), JSON.stringify({ schemaVersion: '1', metadataVersion: 1, tagsBySlug: { 'static-card': ['kept'] }, collections: [] }));
    await addTag(root, 'solo', 'fresh');
    const metadata = JSON.parse(await readFile(join(root, 'metadata.json'), 'utf8'));
    assert.deepEqual(metadata.tagsBySlug['static-card'], ['kept']);
    assert.deepEqual(metadata.tagsBySlug.solo, ['fresh']);
    assert.equal(imported.manifest.slug, 'static-card');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('inbox refuses a nested entry point before reserving a directory and skips empty directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-inbox-clean-'));
  try {
    await assert.rejects(() => addInboxPaste({ catalogRoot: root, content: 'x', entryPoint: 'nested/Card.tsx' }), (error) => error instanceof InboxError && error.code === 'INBOX_INVALID_PATH');
    await assert.rejects(() => readdir(join(root, 'inbox')), { code: 'ENOENT' });
    await mkdir(join(root, 'inbox', 'orphan'), { recursive: true });
    assert.deepEqual(await listInbox(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('collection reorder moves and clamps a slug', async () => {
  const { root } = await catalogWithCard();
  try {
    await importSource(fixture, { catalogRoot: root, namespace: 'local', slug: 'second', displayName: 'Second' });
    await importSource(fixture, { catalogRoot: root, namespace: 'local', slug: 'third', displayName: 'Third' });
    await createCollection(root, 'ideas', 'Ideas');
    for (const slug of ['static-card', 'second', 'third']) await addCollectionSlug(root, 'ideas', slug);
    const find = (result) => result.collections.find((collection) => collection.id === 'ideas').slugs;
    assert.deepEqual(find(await reorderCollectionSlug(root, 'ideas', 'third', 1)), ['static-card', 'third', 'second']);
    assert.deepEqual(find(await reorderCollectionSlug(root, 'ideas', 'static-card', 99)), ['third', 'second', 'static-card']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('deleting favorites is refused', async () => {
  const { root } = await catalogWithCard();
  try {
    await assert.rejects(() => deleteCollection(root, 'favorites'), (error) => error instanceof OrganizeError && error.code === 'ORGANIZE_RESERVED_COLLECTION');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an ambiguous slug is refused with ORGANIZE_AMBIGUOUS', async () => {
  const { root } = await catalogWithCard();
  try {
    await importSource(fixture, { catalogRoot: root, namespace: 'other', slug: 'static-card', displayName: 'Static Card' });
    await assert.rejects(() => addTag(root, 'static-card', 'x'), (error) => error instanceof OrganizeError && error.code === 'ORGANIZE_AMBIGUOUS');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('import records demo-file and remote-url warnings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-warnings-'));
  const source = await mkdtemp(join(tmpdir(), 'blockbase-warnings-src-'));
  try {
    const pasted = await importStdin('export const Hero = () => <img src="https://example.com/a.png" />;\n', { catalogRoot: root, entryPoint: 'Hero.tsx', slug: 'hero', displayName: 'Hero' });
    assert.ok(pasted.manifest.quality.warnings.includes('remote-url:Hero.tsx'));
    await writeFile(join(source, 'Card.tsx'), 'export const Card = () => null;\n');
    await writeFile(join(source, 'demo.tsx'), 'export const Demo = () => null;\n');
    const dir = await importSource(source, { catalogRoot: root, entryPoint: 'Card.tsx', slug: 'card', displayName: 'Card' });
    assert.ok(dir.manifest.quality.warnings.includes('demo-file:demo.tsx'));
    assert.ok(!dir.manifest.quality.warnings.some((warning) => warning.startsWith('remote-url:')));
    const icon = await importStdin('export const Icon = () => <svg xmlns="http://www.w3.org/2000/svg" xmlnsXlink="http://www.w3.org/1999/xlink" />;\n', { catalogRoot: root, entryPoint: 'Icon.tsx', slug: 'icon', displayName: 'Icon' });
    assert.deepEqual(icon.manifest.quality.warnings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test('inbox removes the reserved directory and reports INBOX_COPY_FAILED when a copy fails', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-inbox-fail-'));
  const source = await mkdtemp(join(tmpdir(), 'blockbase-inbox-fail-src-'));
  const locked = join(source, 'Locked.tsx');
  try {
    await writeFile(locked, 'export const Locked = () => null;\n');
    await chmod(locked, 0o000);
    await assert.rejects(() => addInboxPath({ catalogRoot: root, sourcePath: source }), (error) => error instanceof InboxError && error.code === 'INBOX_COPY_FAILED' && typeof error.details.cause === 'string' && error.details.cause.length > 0);
    assert.deepEqual(await readdir(join(root, 'inbox')), []);
  } finally {
    await chmod(locked, 0o644).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});
