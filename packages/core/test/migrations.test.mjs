import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { applyLegacyMigration, planLegacyMigration, resumeLegacyMigration } from '../dist/index.js';

const fixtureRoot = resolve(import.meta.dirname, '../../../tests/fixtures/legacy-catalog');

test('migration plan is read-only and resolves filed-source conflicts explicitly', async () => {
  const source = await mkdtemp(join(tmpdir(), 'blockbase-migration-plan-'));
  const target = join(dirname(source), `${source.split('/').pop()}-target`);
  const component = join(source, 'empty-states', 'dino-404');
  await cp(join(fixtureRoot, 'invalid-yaml', 'buttons', 'malformed'), component, { recursive: true });
  await rm(join(component, 'index.ts'));
  await writeFile(join(source, 'catalog.yaml'), `blocks:\n  - name: empty-states\n    bucket: creation\n    slug: dino-404\n    path: empty-states/dino-404\n    exported: Dino404\n    tags: []\n  - name: empty-states\n    bucket: creation\n    slug: snowboarder-404\n    path: empty-states/dino-404\n    exported: Snowboarder404\n    tags: []\n`);
  await writeFile(join(source, 'taxonomy.csv'), 'Name,Slug\nEmpty States,empty-states\n');
  await writeFile(join(source, 'registry.tsx'), 'export const blocks = [];\n');
  const before = await readFile(join(source, 'catalog.yaml'), 'utf8');
  const plan = await planLegacyMigration({ sourceRoot: source, targetRoot: target, registryPath: join(source, 'registry.tsx') });
  assert.equal(plan.entries.length, 2);
  assert.equal(plan.entries.filter((entry) => entry.conflicts.includes('catalog.missing_index')).length, 2);
  assert.equal(plan.entries.filter((entry) => entry.conflicts.includes('catalog.shared_path_exception')).length, 2);
  assert.equal(plan.entries.filter((entry) => entry.conflicts.includes('catalog.registry_missing')).length, 2);
  assert.ok(plan.entries.every((entry) => entry.provenance.sourceType === 'legacy-filed'));
  assert.ok(plan.entries.every((entry) => entry.provenance.byteIdentityClaim === false));
  assert.equal(plan.structuralChanges.length, 0);
  await assert.rejects(() => stat(target));
  assert.equal(await readFile(join(source, 'catalog.yaml'), 'utf8'), before);
});

test('migration apply is non-destructive, resumable, and idempotent', async () => {
  const source = join(fixtureRoot, 'valid');
  const target = await mkdtemp(join(tmpdir(), 'blockbase-migration-apply-'));
  const sourceCatalog = await readFile(join(source, 'catalog.yaml'), 'utf8');
  const first = await applyLegacyMigration({ sourceRoot: source, targetRoot: target }, 'apply');
  assert.equal(first.status, 'complete');
  assert.equal(first.audit[0].action, 'committed');
  assert.equal(first.idempotent, true);
  const second = await resumeLegacyMigration({ sourceRoot: source, targetRoot: target, reportPath: first.reportPath });
  assert.equal(second.status, 'complete');
  assert.equal(second.audit[0].action, 'already-present');
  assert.equal(second.idempotent, true);
  assert.deepEqual(second.before, second.after);
  assert.equal(await readFile(join(source, 'catalog.yaml'), 'utf8'), sourceCatalog);
});

test('structural audit matches rows by slug across family moves', async () => {
  const source = join(fixtureRoot, 'valid');
  const root = await mkdtemp(join(tmpdir(), 'blockbase-migration-baseline-'));
  const baseline = join(root, 'baseline.yaml');
  await writeFile(baseline, 'blocks:\n  - name: legacy-buttons\n    bucket: brick\n    slug: arrow\n    path: legacy-buttons/arrow\n    exported: Arrow\n    tags: []\n');
  const plan = await planLegacyMigration({ sourceRoot: source, targetRoot: join(root, 'target'), baselineCatalogPath: baseline });
  assert.equal(plan.structuralChanges.length, 1);
  assert.deepEqual(plan.structuralChanges[0].changedFields, ['name', 'bucket', 'path']);
  assert.equal(plan.structuralChanges[0].resolution, 'preserve-current-catalog-row');
});

test('migration apply rejects a target at or inside the source before writing anything', async () => {
  const source = await mkdtemp(join(tmpdir(), 'blockbase-migration-guard-'));
  await cp(join(fixtureRoot, 'valid'), source, { recursive: true });
  const before = (await readdir(source)).sort();
  for (const target of [source, join(source, 'new-target')]) {
    await assert.rejects(() => applyLegacyMigration({ sourceRoot: source, targetRoot: target }, 'apply'), /outside the read-only legacy source root/);
    assert.deepEqual((await readdir(source)).sort(), before);
    await assert.rejects(() => stat(join(source, `${'.'}git`)));
    await assert.rejects(() => stat(join(source, `${'.'}gitignore`)));
    await assert.rejects(() => stat(join(source, 'new-target')));
  }
  await rm(source, { recursive: true, force: true });
});
