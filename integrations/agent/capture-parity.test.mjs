import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { ALLOWED_BUCKETS, assertCatalogTaxonomy, normalizeSource, rebuildIndex } from '../../packages/core/dist/index.js';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const executable = resolve(repositoryRoot, 'packages/cli/dist/index.js');
const fixture = resolve(repositoryRoot, 'tests/fixtures/sources/normalization/static-tailwind/StaticCard.tsx');

function invoke(args, input) {
  const result = spawnSync(process.execPath, [executable, ...args, '--json'], {
    cwd: repositoryRoot,
    env: { ...process.env },
    input,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('blockbase-capture has file, directory, and stdin parity with immutable reports and indexes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-capture-parity-'));
  try {
    const content = await readFile(fixture, 'utf8');
    const fileCatalog = join(root, 'file-catalog');
    const file = invoke(['import', fixture, '--catalog', fileCatalog, '--namespace', 'capture', '--slug', 'static-card'], undefined);
    const sourceDir = join(root, 'source');
    await mkdir(sourceDir);
    await writeFile(join(sourceDir, 'StaticCard.tsx'), content);
    const directoryCatalog = join(root, 'directory-catalog');
    const directory = invoke(['import', sourceDir, '--catalog', directoryCatalog, '--namespace', 'capture', '--slug', 'static-card'], undefined);
    const stdinCatalog = join(root, 'stdin-catalog');
    const stdin = invoke(['import', '-', '--entry-point', 'StaticCard.tsx', '--catalog', stdinCatalog, '--namespace', 'capture', '--slug', 'static-card'], content);

    for (const result of [file, directory, stdin]) {
      assert.equal(result.operation, 'import');
      const normalization = normalizeSource(result.data.envelope);
      const index = await rebuildIndex({ catalogRoot: result.data.componentPath.split('/components/')[0] });
      assert.equal(normalization.report.status, 'complete');
      assert.equal(normalization.report.outcome, 'safe');
      assert.equal(index.componentCount, 1);
      await access(join(result.data.packagePath, 'component.json'));
      assert.equal(await readFile(join(result.data.revisionPath, 'original', 'StaticCard.tsx'), 'utf8'), content);
    }
    assert.equal(file.data.revisionId, directory.data.revisionId);
    assert.equal(file.data.revisionId, stdin.data.revisionId);
    const search = invoke(['search', 'StaticCard', '--catalog', fileCatalog], undefined);
    assert.equal(search.data.selection.status, 'selected');
    assert.equal(search.data.selection.selectedComponentId, file.data.manifest.componentId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('capture preserves assets, does not execute package scripts, and reports unsupported syntax', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-capture-safety-'));
  try {
    const source = join(root, 'source');
    const catalog = join(root, 'catalog');
    const marker = join(root, 'executed');
    await mkdir(source);
    await writeFile(join(source, 'index.tsx'), 'export function Dynamic() { return <div style={{ color: theme.color }} />; }\n');
    await writeFile(join(source, 'icon.svg'), '<svg></svg>');
    await writeFile(join(source, 'package.json'), JSON.stringify({ scripts: { preinstall: `touch ${marker}` } }));
    const result = invoke(['import', source, '--catalog', catalog, '--namespace', 'capture', '--slug', 'dynamic'], undefined);
    const normalization = normalizeSource(result.data.envelope);
    await rebuildIndex({ catalogRoot: catalog });
    assert.equal(normalization.report.outcome, 'unsupported');
    assert.equal(normalization.report.status, 'unsupported');
    assert.ok(normalization.report.residuals.length > 0);
    assert.equal(await readFile(join(result.data.revisionPath, 'assets', 'icon.svg'), 'utf8'), '<svg></svg>');
    await assert.rejects(() => access(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cutover dry run verifies installation and capture without retiring external workflow', () => {
  const script = resolve(import.meta.dirname, 'cutover-dry-run.mjs');
  const result = spawnSync(process.execPath, [script], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.installation.verified, true);
  assert.equal(report.capture.originalBytesPreserved, true);
  assert.equal(report.capture.indexEntries, 1);
  assert.equal(report.externalWorkflow.action, 'not-run');
  assert.equal(report.retirement.status, 'not-run');
});

test('capture filing contract keeps Name,Slug families and excludes set buckets', () => {
  assert.deepEqual(ALLOWED_BUCKETS, ['brick', 'build', 'creation']);
  assert.doesNotThrow(() => assertCatalogTaxonomy({
    taxonomyCsv: 'Name,Slug\nCards,cards\n',
    catalogYaml: 'blocks:\n  - name: cards\n    bucket: build\n    slug: card\n    path: cards/card\n',
  }));
  assert.throws(() => assertCatalogTaxonomy({
    taxonomyCsv: 'Name,Slug\nCards,cards\n',
    catalogYaml: 'blocks:\n  - name: cards\n    bucket: set\n    slug: kit\n    path: cards/kit\n',
  }), /bucket/);
  assert.throws(() => assertCatalogTaxonomy({
    taxonomyCsv: 'Name,Slug\nCards,cards\n',
    catalogYaml: 'blocks:\n  - name: new-family\n    bucket: brick\n    slug: card\n    path: new-family/card\n',
  }), /taxonomy|family|name/i);
});
