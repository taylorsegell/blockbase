import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  ALLOWED_BUCKETS,
  CatalogConflictError,
  CatalogNotFoundError,
  assertCatalogTaxonomy,
  parseTaxonomyCsv,
  readLegacyCatalog,
  readLegacyCatalogOrThrow,
  defaultCatalogRoot,
  resolveCatalog,
  validateCatalogTaxonomy,
} from '../dist/index.js';

const fixtureRoot = resolve(import.meta.dirname, '../../../tests/fixtures/legacy-catalog');

test('catalog resolution honors explicit, environment, then platform default precedence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-resolution-'));
  const explicit = join(root, 'explicit');
  const environment = join(root, 'environment');
  mkdirSync(explicit, { recursive: true });
  mkdirSync(environment, { recursive: true });
  await writeFile(join(explicit, 'catalog.yaml'), 'blocks: []\n');
  await writeFile(join(environment, 'catalog.yaml'), 'blocks: []\n');
  const result = resolveCatalog({ catalog: explicit, env: { BLOCKBASE_HOME: environment }, platform: 'linux', homeDir: root, cwd: root });
  assert.equal(result.source, 'explicit');
  assert.equal(result.catalogPath, join(explicit, 'catalog.yaml'));
  assert.equal(result.checkedLocations[0].selected, true);
  assert.equal(result.checkedLocations[1].exists, true);
});

test('missing catalog reports every candidate and does not create one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-missing-'));
  const result = resolveCatalog({ catalog: join(root, 'explicit'), env: { BLOCKBASE_HOME: join(root, 'home') }, platform: 'linux', homeDir: root, cwd: root });
  assert.equal(result.found, false);
  assert.equal(result.checkedLocations.length, 3);
  assert.ok(result.checkedLocations.every((location) => !location.exists));
  assert.ok(!existsSync(join(root, 'explicit', 'catalog.yaml')));
  assert.throws(() => readLegacyCatalogOrThrow({ catalog: join(root, 'explicit'), env: { BLOCKBASE_HOME: join(root, 'home') }, platform: 'linux', homeDir: root, cwd: root }), CatalogNotFoundError);
});

test('BLOCKBASE_HOME pointing at a missing catalog does not fall back to ~/.blocks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-env-authoritative-'));
  mkdirSync(join(root, '.blocks'), { recursive: true });
  await writeFile(join(root, '.blocks', 'catalog.yaml'), 'blocks: []\n');
  const result = resolveCatalog({ env: { BLOCKBASE_HOME: join(root, 'nope') }, platform: 'linux', homeDir: root, cwd: root });
  assert.equal(result.found, false);
  assert.equal(result.catalogPath, null);
  assert.equal(result.winningSource, null);
  const environment = result.checkedLocations.find((location) => location.source === 'environment');
  const fallback = result.checkedLocations.find((location) => location.source === 'platform-default');
  assert.equal(environment.exists, false);
  assert.equal(fallback.exists, true);
  assert.equal(fallback.selected, false);
});

test('explicit catalog pointing at a missing path does not fall back to BLOCKBASE_HOME', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-explicit-authoritative-'));
  const environment = join(root, 'environment');
  mkdirSync(environment, { recursive: true });
  await writeFile(join(environment, 'catalog.yaml'), 'blocks: []\n');
  const result = resolveCatalog({ catalog: join(root, 'nope'), env: { BLOCKBASE_HOME: environment }, platform: 'linux', homeDir: root, cwd: root });
  assert.equal(result.found, false);
  assert.equal(result.catalogPath, null);
  assert.equal(result.winningSource, null);
  const explicit = result.checkedLocations.find((location) => location.source === 'explicit');
  const env = result.checkedLocations.find((location) => location.source === 'environment');
  assert.equal(explicit.exists, false);
  assert.equal(env.exists, true);
  assert.equal(env.selected, false);
});

test('catalog resolution selects environment over default and default when nothing is configured', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-precedence-'));
  const environment = join(root, 'environment');
  mkdirSync(environment, { recursive: true });
  mkdirSync(join(root, '.blocks'), { recursive: true });
  await writeFile(join(environment, 'catalog.yaml'), 'blocks: []\n');
  await writeFile(join(root, '.blocks', 'catalog.yaml'), 'blocks: []\n');
  const fromEnv = resolveCatalog({ env: { BLOCKBASE_HOME: environment }, platform: 'linux', homeDir: root, cwd: root });
  assert.equal(fromEnv.winningSource, 'environment');
  assert.equal(fromEnv.catalogPath, join(environment, 'catalog.yaml'));
  const fromDefault = resolveCatalog({ env: {}, platform: 'linux', homeDir: root, cwd: root });
  assert.equal(fromDefault.winningSource, 'platform-default');
  assert.equal(fromDefault.catalogPath, join(root, '.blocks', 'catalog.yaml'));
});

test('platform default is ~/.blocks regardless of platform or env', () => {
  assert.equal(defaultCatalogRoot('darwin', {}, '/Users/tester'), '/Users/tester/.blocks');
  assert.equal(defaultCatalogRoot('linux', {}, '/home/tester'), '/home/tester/.blocks');
  assert.equal(defaultCatalogRoot('linux', { XDG_DATA_HOME: '/tmp/xdg' }, '/home/tester'), '/home/tester/.blocks');
  assert.equal(defaultCatalogRoot('win32', { LOCALAPPDATA: 'C:/Users/tester/AppData/Local' }, 'C:/Users/tester'), 'C:/Users/tester/.blocks');
});

test('catalog resolution recognizes a migrated (index.sqlite) catalog root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-migrated-'));
  const migrated = join(root, 'migrated');
  mkdirSync(migrated, { recursive: true });
  await writeFile(join(migrated, 'index.sqlite'), '');
  const result = resolveCatalog({ catalog: migrated, platform: 'linux', homeDir: root, cwd: root });
  assert.equal(result.found, true);
  assert.equal(result.catalogPath, join(migrated, 'index.sqlite'));
  assert.equal(result.rootPath, migrated);
  assert.equal(result.source, 'explicit');
});

test('a legacy catalog.yaml still wins when a location somehow has both', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-both-'));
  const both = join(root, 'both');
  mkdirSync(both, { recursive: true });
  await writeFile(join(both, 'catalog.yaml'), 'blocks: []\n');
  await writeFile(join(both, 'index.sqlite'), '');
  const result = resolveCatalog({ catalog: both, platform: 'linux', homeDir: root, cwd: root });
  assert.equal(result.catalogPath, join(both, 'catalog.yaml'));
});

test('an explicit path directly to index.sqlite is used as-is', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-explicit-sqlite-'));
  const migrated = join(root, 'migrated');
  mkdirSync(migrated, { recursive: true });
  await writeFile(join(migrated, 'index.sqlite'), '');
  const result = resolveCatalog({ catalog: join(migrated, 'index.sqlite'), platform: 'linux', homeDir: root, cwd: root });
  assert.equal(result.found, true);
  assert.equal(result.catalogPath, join(migrated, 'index.sqlite'));
});

test('a catalog directory named catalog resolves to its index', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-named-catalog-'));
  const named = join(root, 'catalog');
  mkdirSync(named, { recursive: true });
  await writeFile(join(named, 'index.sqlite'), '');
  const result = resolveCatalog({ env: { BLOCKBASE_HOME: named }, platform: 'linux', homeDir: root, cwd: root });
  assert.equal(result.found, true);
  assert.equal(result.catalogPath, join(named, 'index.sqlite'));
  assert.equal(result.rootPath, named);
  assert.equal(result.source, 'environment');
});

test('core taxonomy preserves the live contract and shared-path exception', () => {
  assert.deepEqual(ALLOWED_BUCKETS, ['brick', 'build', 'creation']);
  assert.deepEqual(parseTaxonomyCsv('Name,Slug\nMaps,maps\n'), [{ name: 'Maps', slug: 'maps' }]);
  assert.doesNotThrow(() => assertCatalogTaxonomy({
    catalogYaml: 'blocks:\n  - name: empty-states\n    bucket: brick\n    slug: dino-404\n    path: empty-states/dino-404\n  - name: empty-states\n    bucket: brick\n    slug: snowboarder-404\n    path: empty-states/dino-404\n',
    taxonomyCsv: 'Name,Slug\nEmpty States,empty-states\n',
  }));
  const diagnostics = validateCatalogTaxonomy({
    catalogYaml: 'blocks:\n  - name: maps\n    bucket: set\n    slug: globe\n    path: maps/wrong\n',
    taxonomyCsv: 'Name,Slug\nMaps,maps\nCards,cards\n',
  });
  assert.deepEqual(new Set(diagnostics.map((item) => item.code)), new Set(['taxonomy.invalid_bucket', 'catalog.noncanonical_path', 'taxonomy.unused_family']));
  assert.throws(() => assertCatalogTaxonomy({ catalogYaml: 'blocks: []\n', taxonomyCsv: 'Name,Slug\nMaps,maps\n' }), CatalogConflictError);
});

test('legacy reader reports fixture evidence without mutation', async () => {
  const before = await readFile(join(fixtureRoot, 'invalid/catalog.yaml'), 'utf8');
  const result = readLegacyCatalog({ rootPath: join(fixtureRoot, 'invalid'), catalog: join(fixtureRoot, 'invalid/catalog.yaml'), taxonomyPath: join(fixtureRoot, 'invalid/taxonomy.csv'), registryPath: join(fixtureRoot, 'invalid/registry.tsx') });
  const codes = new Set(result.diagnostics.map((item) => item.code));
  assert.ok(codes.has('catalog.path_traversal'));
  assert.ok(codes.has('catalog.duplicate_identity'));
  assert.ok(codes.has('catalog.shared_path'));
  assert.ok(codes.has('taxonomy.unused_family'));
  assert.ok(result.diagnostics.every((item) => item.evidence?.file));
  assert.equal(await readFile(join(fixtureRoot, 'invalid/catalog.yaml'), 'utf8'), before);
});

test('legacy reader returns deterministic inventory and hashes for a valid fixture', () => {
  const result = readLegacyCatalog({ rootPath: join(fixtureRoot, 'valid'), catalog: join(fixtureRoot, 'valid/catalog.yaml'), taxonomyPath: join(fixtureRoot, 'valid/taxonomy.csv'), registryPath: null });
  assert.equal(result.entryCount, 1);
  assert.equal(result.uniquePathCount, 1);
  assert.equal(result.diagnostics.length, 0);
  assert.match(result.catalogHash ?? '', /^[a-f0-9]{64}$/);
  assert.match(result.corpusHash ?? '', /^[a-f0-9]{64}$/);
});

test('legacy reader emits a stable invalid-manifest diagnostic with file evidence', () => {
  const root = join(fixtureRoot, 'invalid-yaml');
  const result = readLegacyCatalog({ rootPath: root });
  assert.equal(result.counts.invalidManifests, 1);
  assert.equal(result.diagnostics.filter((item) => item.code === 'catalog.metadata_invalid_yaml').length, 1);
  assert.match(result.diagnostics.find((item) => item.code === 'catalog.metadata_invalid_yaml')?.evidence?.file ?? '', /meta\.yaml$/);
});
