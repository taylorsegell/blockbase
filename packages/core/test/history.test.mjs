import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { importSource } from '../dist/import/index.js';
import { addInboxPath, discardInboxItem, listInbox } from '../dist/inbox/index.js';
import { addTag, createCollection, addCollectionSlug, listCollections, listTags } from '../dist/organize/index.js';
import { applyLegacyMigration } from '../dist/migrations/index.js';
import { ThemeRegistry, starterTheme } from '../dist/themes/index.js';
import { HistoryError, catalogHistoryHealth, listCatalogHistory, restoreCatalogComponent, undoCatalogChanges } from '../dist/store/history/index.js';

const fixture = resolve(import.meta.dirname, '../../../tests/fixtures/sources/normalization/static-tailwind/StaticCard.tsx');

async function catalogWithCard() {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-history-'));
  const imported = await importSource(fixture, { catalogRoot: root, namespace: 'local', slug: 'static-card', displayName: 'Static Card' });
  return { root, imported };
}

const exists = (path) => stat(path).then(() => true, () => false);
const manifestOf = async (root) => JSON.parse(await readFile(join(root, 'components/local/static-card/component.json'), 'utf8'));

test('the first catalog write creates the repository and every operation is one commit', async () => {
  const { root } = await catalogWithCard();
  try {
    assert.equal(await exists(join(root, '.git')), true);
    assert.match(await readFile(join(root, '.gitignore'), 'utf8'), /index\.sqlite/);
    process.env.BLOCKBASE_ACTOR = 'mcp:test-agent';
    try {
      await addTag(root, 'static-card', 'hero');
    } finally {
      delete process.env.BLOCKBASE_ACTOR;
    }
    const { entries } = await listCatalogHistory(root);
    assert.deepEqual(entries.map((entry) => entry.operation), ['tag.add', 'import', 'history.start']);
    assert.equal(entries[0].summary, 'tag add hero → local/static-card');
    assert.equal(entries[0].actor, 'mcp:test-agent');
    assert.deepEqual(entries[0].components, ['local/static-card']);
    assert.ok(entries[0].files.includes('metadata.json'));
    const tracked = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' });
    assert.doesNotMatch(tracked, /index\.sqlite/);
    assert.deepEqual((await catalogHistoryHealth(root)).uncommittedPaths, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('undo reverses the last change as a new commit and advances the manifest version', async () => {
  const { root } = await catalogWithCard();
  try {
    await addTag(root, 'static-card', 'hero');
    const taggedVersion = (await manifestOf(root)).manifestVersion;
    const undo = await undoCatalogChanges(root);
    assert.equal(undo.undone.length, 1);
    assert.equal(undo.undone[0].operation, 'tag.add');
    assert.deepEqual((await listTags(root, 'static-card')).components[0].tags, []);
    assert.ok((await manifestOf(root)).manifestVersion > taggedVersion);
    const { entries } = await listCatalogHistory(root);
    assert.equal(entries[0].operation, 'history.undo');
    assert.equal(entries.length, 4);
    // The undo is itself undoable.
    await undoCatalogChanges(root);
    assert.deepEqual((await listTags(root, 'static-card')).components[0].tags, ['hero']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('undo of an import removes the component and refuses to go past the start', async () => {
  const { root } = await catalogWithCard();
  try {
    await undoCatalogChanges(root);
    assert.equal(await exists(join(root, 'components/local/static-card')), false);
    await assert.rejects(() => undoCatalogChanges(root, { steps: 5 }), (error) => error instanceof HistoryError && error.code === 'HISTORY_NOTHING_TO_UNDO');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('restore puts one component back without touching collections', async () => {
  const { root, imported } = await catalogWithCard();
  try {
    const start = (await listCatalogHistory(root)).entries[0].commit;
    await addTag(root, 'static-card', 'hero');
    await createCollection(root, 'picks', 'Picks');
    await addCollectionSlug(root, 'picks', 'static-card');
    const restored = await restoreCatalogComponent(root, imported.manifest.componentId, start);
    assert.equal(restored.removed, false);
    assert.equal(restored.component, 'local/static-card');
    assert.deepEqual((await listTags(root, 'static-card')).components[0].tags, []);
    const picks = (await listCollections(root)).collections.find((collection) => collection.id === 'picks');
    assert.deepEqual(picks.slugs, ['static-card']);
    const componentHistory = await listCatalogHistory(root, { component: 'static-card' });
    assert.deepEqual(componentHistory.entries.map((entry) => entry.operation), ['history.restore', 'tag.add', 'import']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('changes made outside Blockbase get their own commit before the next operation', async () => {
  const { root } = await catalogWithCard();
  try {
    await writeFile(join(root, 'notes.md'), 'hand edit\n');
    await addTag(root, 'static-card', 'hero');
    const { entries } = await listCatalogHistory(root);
    assert.deepEqual(entries.slice(0, 2).map((entry) => entry.operation), ['tag.add', 'external']);
    assert.deepEqual(entries[1].files, ['notes.md']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a discarded inbox item can be brought back, and a nested repository is not copied', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-history-inbox-'));
  const source = await mkdtemp(join(tmpdir(), 'blockbase-history-source-'));
  try {
    await writeFile(join(source, 'Card.tsx'), 'export function Card() { return null; }\n');
    execFileSync('git', ['init', '--quiet', source]);
    const parked = await addInboxPath({ catalogRoot: root, sourcePath: source });
    assert.equal(await exists(join(parked.payloadPath, '.git')), false);
    await discardInboxItem(root, parked.id);
    assert.equal((await listInbox(root)).length, 0);
    await undoCatalogChanges(root);
    assert.deepEqual((await listInbox(root)).map((item) => item.id), [parked.id]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test('BLOCKBASE_HISTORY=off skips the repository and history calls say why', async () => {
  process.env.BLOCKBASE_HISTORY = 'off';
  try {
    const { root } = await catalogWithCard();
    try {
      assert.equal(await exists(join(root, '.git')), false);
      assert.equal((await catalogHistoryHealth(root)).reason, 'disabled');
      await assert.rejects(() => listCatalogHistory(root), (error) => error instanceof HistoryError && error.code === 'HISTORY_UNAVAILABLE');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    delete process.env.BLOCKBASE_HISTORY;
  }
});

test('rollback refuses while a component write holds its lock', async () => {
  const { root } = await catalogWithCard();
  try {
    await addTag(root, 'static-card', 'hero');
    await mkdir(join(root, 'components/local'), { recursive: true });
    await writeFile(join(root, 'components/local/static-card.lock'), '{}');
    await assert.rejects(() => undoCatalogChanges(root), (error) => error instanceof HistoryError && error.code === 'HISTORY_BUSY');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('should record theme.add and catalog.migrate as history operations and undo the theme alone', async () => {
  const { root } = await catalogWithCard();
  const target = join(await mkdtemp(join(tmpdir(), 'blockbase-history-migrate-')), 'catalog');
  try {
    await new ThemeRegistry({ catalogRoot: root }).register(starterTheme('demo', 'Demo'));
    const { entries } = await listCatalogHistory(root);
    assert.deepEqual(entries.map((entry) => entry.operation), ['theme.add', 'import', 'history.start']);
    assert.equal(entries[0].summary, 'theme add demo');
    const undo = await undoCatalogChanges(root);
    assert.equal(undo.undone[0].operation, 'theme.add');
    assert.equal(await exists(join(root, 'themes/demo')), false);
    assert.equal(await exists(join(root, 'components/local/static-card/component.json')), true);

    const migrated = await applyLegacyMigration({ sourceRoot: resolve(import.meta.dirname, '../../../tests/fixtures/legacy-catalog/valid'), targetRoot: target }, 'apply');
    const migration = (await listCatalogHistory(target)).entries;
    assert.deepEqual(migration.map((entry) => entry.operation), ['catalog.migrate', 'history.start']);
    assert.match(migration[0].summary, /mig_[0-9a-f]{24}/);
    assert.equal(migration[0].summary, `catalog migrate ${migrated.migrationId} ${migrated.status} (${migrated.audit.filter((item) => item.action === 'committed').length} committed, ${migrated.blocked.length} blocked)`);
    assert.deepEqual((await catalogHistoryHealth(target)).uncommittedPaths, []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dirname(target), { recursive: true, force: true });
  }
});
