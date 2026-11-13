import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  AdaptationError,
  applyAdaptation,
  createApplyPlan,
  importEnvelope,
  prepareComponentAdaptation,
  rebuildIndex,
  RevisionStore,
  sha256,
} from '../dist/index.js';

// Exercises the real end-to-end `prepareComponentAdaptation`/`createApplyPlan`/`applyAdaptation`
// path against a real temporary catalog (populated through the same `importEnvelope`/
// `RevisionStore` machinery real imports use) and a real project fixture on disk — this file did
// not exist before task 5.3; adaptation had no direct core-level regression coverage at all
// (only indirect coverage through mocked MCP-layer tests), which is exactly the kind of gap the
// repo's own atlas flags as having let a real bug (`IMPORT_INVALID_ENVELOPE`) go unnoticed
// against real data for a long time.

const projectFixture = resolve(import.meta.dirname, '../../../tests/fixtures/destinations/fixture-a');
// Real, non-trivial React source: static Tailwind utility classes that genuinely exercise token
// mapping (high- and low-confidence roles), not a placeholder like "export default 1".
const sourceContent = 'export function StaticCard() {\n  return <article className="rounded-lg bg-card p-4 text-foreground shadow-sm">Card</article>;\n}\n';

async function fixtureManifest() {
  return JSON.parse(await readFile(new URL('../../contracts/fixtures/v1/component-manifest.json', import.meta.url), 'utf8'));
}

async function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

async function freshProject() {
  const root = await tempDir('blockbase-adapt-project-');
  await cp(projectFixture, root, { recursive: true });
  return root;
}

async function importStaticCard(catalogRoot) {
  const manifest = await fixtureManifest();
  Object.assign(manifest, { componentId: 'cmp_test_static_card', namespace: 'test', slug: 'static-card', displayName: 'Static Card' });
  return importEnvelope({
    schemaVersion: '1',
    sourceType: 'directory',
    files: [{ path: 'StaticCard.tsx', content: sourceContent, contentHash: sha256(sourceContent) }],
    assets: [],
    entryPoint: 'StaticCard.tsx',
    provenance: { sourceType: 'directory', locator: 'fixtures/static-tailwind' },
  }, { catalogRoot, manifest });
}

test('prepareComponentAdaptation is deterministic and dry-run; applyAdaptation writes only after the explicit boundary', async () => {
  const catalogRootDir = await tempDir('blockbase-adapt-catalog-');
  const catalogRoot = join(catalogRootDir, 'catalog');
  const imported = await importStaticCard(catalogRoot);
  await rebuildIndex({ catalogRoot });
  const projectPath = await freshProject();

  const bundle = await prepareComponentAdaptation(imported.manifest.componentId, { catalogRoot, projectPath });
  assert.equal(bundle.componentId, imported.manifest.componentId);
  assert.equal(bundle.revisionId, imported.revisionId);
  const mainFile = bundle.files.find((file) => file.path.endsWith('StaticCard.tsx'));
  assert.ok(mainFile, 'the entry file is present in the bundle');
  assert.equal(mainFile.operation, 'create');
  // Real token mapping ran: the destination has fixture-a's --color-surface, so the `bg-card`
  // utility (role color.surface.elevated) was rewritten to it; there is no destination token
  // matching space/radius/shadow roles, so those stay low-confidence with warnings.
  assert.ok(mainFile.content.includes('bg-[var(--color-surface)]'), mainFile.content);
  assert.ok(bundle.tokenMappings.some((mapping) => mapping.confidence === 'high' && mapping.destinationExpression === 'var(--color-surface)'));
  assert.ok(bundle.tokenMappings.some((mapping) => mapping.confidence === 'low'));
  assert.ok(bundle.warnings.length > 0);
  assert.equal(bundle.risk, 'medium');

  // Dry-run: prepare (and its own optional staging) never writes into the destination project.
  await assert.rejects(() => readFile(join(projectPath, mainFile.path), 'utf8'));
  const plan = await createApplyPlan(bundle);
  assert.deepEqual(plan.blocked, []);
  await assert.rejects(() => readFile(join(projectPath, mainFile.path), 'utf8'));

  // Determinism: re-preparing the identical component/project yields an identical bundle id.
  const again = await prepareComponentAdaptation(imported.manifest.componentId, { catalogRoot, projectPath });
  assert.equal(again.bundleId, bundle.bundleId);

  // Only the explicit apply call writes.
  const applied = await applyAdaptation(bundle, { catalogRoot });
  assert.deepEqual(applied.blocked, []);
  assert.equal(await readFile(join(projectPath, mainFile.path), 'utf8'), mainFile.content);

  await rm(catalogRootDir, { recursive: true, force: true });
  await rm(projectPath, { recursive: true, force: true });
});

test('ADAPT_PROJECT_CONFLICT blocks adaptation before any catalog lookup completes', async () => {
  const catalogRootDir = await tempDir('blockbase-adapt-catalog-');
  const catalogRoot = join(catalogRootDir, 'catalog');
  const imported = await importStaticCard(catalogRoot);
  await rebuildIndex({ catalogRoot });
  const projectPath = await tempDir('blockbase-adapt-conflict-project-');
  await mkdir(join(projectPath, 'src', 'components'), { recursive: true });
  await writeFile(join(projectPath, 'package.json'), JSON.stringify({ type: 'module', dependencies: { react: '18.0.0', vite: '5.0.0' } }));
  await writeFile(join(projectPath, 'src', 'index.css'), ':root { --surface: white; }\n');
  await writeFile(join(projectPath, 'src', 'globals.css'), ':root { --surface: black; }\n');

  await assert.rejects(
    () => prepareComponentAdaptation(imported.manifest.componentId, { catalogRoot, projectPath }),
    (error) => error instanceof AdaptationError && error.code === 'ADAPT_PROJECT_CONFLICT',
  );

  await rm(catalogRootDir, { recursive: true, force: true });
  await rm(projectPath, { recursive: true, force: true });
});

test('a stale search index is diagnosed as ADAPT_INDEX_STALE, and an explicitly requested non-current revision as ADAPT_STALE_REVISION', async () => {
  const catalogRootDir = await tempDir('blockbase-adapt-catalog-');
  const catalogRoot = join(catalogRootDir, 'catalog');
  const imported = await importStaticCard(catalogRoot);
  await rebuildIndex({ catalogRoot });
  const revisionA = imported.revisionId;

  // Commit a second revision to the same component WITHOUT rebuilding the index, so the index's
  // cached currentRevision (A) genuinely lags the fresh on-disk component.json (B).
  const updatedContent = sourceContent.replace('Card', 'Updated Card');
  // importEnvelope now rebuilds the index itself, so commit through the store to keep the index stale.
  const importedB = await new RevisionStore({ catalogRoot }).commit({
    schemaVersion: '1',
    sourceType: 'directory',
    files: [{ path: 'StaticCard.tsx', content: updatedContent, contentHash: sha256(updatedContent) }],
    assets: [],
    entryPoint: 'StaticCard.tsx',
    provenance: { sourceType: 'directory', locator: 'fixtures/static-tailwind' },
  }, imported.manifest);
  assert.notEqual(importedB.revisionId, revisionA);

  const projectPath = await freshProject();

  await assert.rejects(
    () => prepareComponentAdaptation(imported.manifest.componentId, { catalogRoot, projectPath }),
    (error) => error instanceof AdaptationError && error.code === 'ADAPT_INDEX_STALE' && error.details.indexed === revisionA && error.details.current === importedB.revisionId,
  );

  await assert.rejects(
    () => prepareComponentAdaptation(imported.manifest.componentId, { catalogRoot, projectPath, revision: revisionA }),
    (error) => error instanceof AdaptationError && error.code === 'ADAPT_STALE_REVISION' && error.details.requested === revisionA && error.details.current === importedB.revisionId,
  );

  await rm(catalogRootDir, { recursive: true, force: true });
  await rm(projectPath, { recursive: true, force: true });
});

test('a destination file that changes after preparation blocks apply as ADAPT_TARGET_CHANGED, and nothing is written', async () => {
  const catalogRootDir = await tempDir('blockbase-adapt-catalog-');
  const catalogRoot = join(catalogRootDir, 'catalog');
  const imported = await importStaticCard(catalogRoot);
  await rebuildIndex({ catalogRoot });
  const projectPath = await freshProject();
  const bundle = await prepareComponentAdaptation(imported.manifest.componentId, { catalogRoot, projectPath });
  const target = bundle.files[0];

  await mkdir(dirname(join(projectPath, target.path)), { recursive: true });
  await writeFile(join(projectPath, target.path), 'interfering edit\n');

  const plan = await createApplyPlan(bundle);
  assert.ok(plan.blocked.some((entry) => entry.startsWith(target.path)));
  await assert.rejects(
    () => applyAdaptation(bundle, { catalogRoot }),
    (error) => error instanceof AdaptationError && error.code === 'ADAPT_TARGET_CHANGED',
  );
  assert.equal(await readFile(join(projectPath, target.path), 'utf8'), 'interfering edit\n');

  await rm(catalogRootDir, { recursive: true, force: true });
  await rm(projectPath, { recursive: true, force: true });
});

test('applyAdaptation independently rechecks the catalog and refuses a bundle whose revision is no longer current', async () => {
  const catalogRootDir = await tempDir('blockbase-adapt-catalog-');
  const catalogRoot = join(catalogRootDir, 'catalog');
  const imported = await importStaticCard(catalogRoot);
  await rebuildIndex({ catalogRoot });
  const projectPath = await freshProject();
  const bundle = await prepareComponentAdaptation(imported.manifest.componentId, { catalogRoot, projectPath });

  const updatedContent = sourceContent.replace('Card', 'Newer Card');
  // importEnvelope now rebuilds the index itself, so commit through the store to keep the index stale.
  const importedB = await new RevisionStore({ catalogRoot }).commit({
    schemaVersion: '1',
    sourceType: 'directory',
    files: [{ path: 'StaticCard.tsx', content: updatedContent, contentHash: sha256(updatedContent) }],
    assets: [],
    entryPoint: 'StaticCard.tsx',
    provenance: { sourceType: 'directory', locator: 'fixtures/static-tailwind' },
  }, imported.manifest);

  await assert.rejects(
    () => applyAdaptation(bundle, { catalogRoot }),
    (error) => error instanceof AdaptationError && error.code === 'ADAPT_STALE_REVISION' && error.details.bundleRevision === bundle.revisionId && error.details.currentRevision === importedB.revisionId,
  );
  const mainPath = bundle.files.find((file) => file.path.endsWith('StaticCard.tsx')).path;
  await assert.rejects(() => readFile(join(projectPath, mainPath), 'utf8'));

  await rm(catalogRootDir, { recursive: true, force: true });
  await rm(projectPath, { recursive: true, force: true });
});

test('prepareComponentAdaptation refuses to run without a catalogRoot or catalogSource', async () => {
  const projectPath = await freshProject();
  await assert.rejects(
    () => prepareComponentAdaptation('cmp_missing', { projectPath }),
    (error) => error instanceof AdaptationError && error.code === 'ADAPT_MISSING_CATALOG_SOURCE',
  );
  await rm(projectPath, { recursive: true, force: true });
});

async function importGenericBlock(catalogRoot, slug, label) {
  const manifest = await fixtureManifest();
  Object.assign(manifest, { componentId: `cmp_test_${slug.replace(/-/g, '_')}`, namespace: 'test', slug, displayName: label });
  const component = `export function ${label.replace(/\s+/g, '')}() {\n  return <div className="rounded-lg bg-card p-4">${label}</div>;\n}\n`;
  const index = `export * from './component';\n`;
  const files = [
    ['component.tsx', component],
    ['index.ts', index],
    ['meta.yaml', `slug: ${slug}\n`],
    ['BLOCK.md', `# ${label}\n`],
  ].map(([path, content]) => ({ path, content, contentHash: sha256(content) }));
  return importEnvelope({ schemaVersion: '1', sourceType: 'directory', files, assets: [], entryPoint: 'component.tsx', provenance: { sourceType: 'directory', locator: `fixtures/${slug}` } }, { catalogRoot, manifest });
}

test('should write two different blocks to the same project with no shared paths and no meta.yaml or BLOCK.md', async () => {
  const catalogRootDir = await tempDir('blockbase-adapt-catalog-');
  const catalogRoot = join(catalogRootDir, 'catalog');
  const first = await importGenericBlock(catalogRoot, 'halftone-flow', 'Halftone Flow');
  const second = await importGenericBlock(catalogRoot, 'grid-glow', 'Grid Glow');
  await rebuildIndex({ catalogRoot });
  const projectPath = await freshProject();

  const a = await prepareComponentAdaptation(first.manifest.componentId, { catalogRoot, projectPath });
  const b = await prepareComponentAdaptation(second.manifest.componentId, { catalogRoot, projectPath });
  const pathsA = a.files.map((file) => file.path);
  const pathsB = b.files.map((file) => file.path);
  assert.deepEqual(pathsA.filter((path) => pathsB.includes(path)), [], `shared paths: ${pathsA} / ${pathsB}`);
  for (const path of [...pathsA, ...pathsB]) assert.ok(!/(^|\/)(meta\.ya?ml|BLOCK\.md)$/.test(path), `catalog metadata written: ${path}`);
  assert.ok(pathsA.every((path) => path.startsWith('src/components/halftone-flow/')), pathsA.join(','));
  assert.ok(pathsB.every((path) => path.startsWith('src/components/grid-glow/')), pathsB.join(','));
  assert.ok(pathsA.includes('src/components/halftone-flow/HalftoneFlow.tsx'), pathsA.join(','));
  assert.ok(!pathsA.some((path) => path.endsWith('/component.tsx')));
  const indexA = a.files.find((file) => file.path.endsWith('/index.ts'));
  assert.ok(indexA.content.includes(`'./HalftoneFlow'`), indexA.content);
  assert.equal(a.placement.directory, 'src/components/halftone-flow');

  await applyAdaptation(a, { catalogRoot });
  await applyAdaptation(b, { catalogRoot });
  assert.ok((await readFile(join(projectPath, 'src/components/halftone-flow/HalftoneFlow.tsx'), 'utf8')).includes('HalftoneFlow'));
  assert.ok((await readFile(join(projectPath, 'src/components/grid-glow/GridGlow.tsx'), 'utf8')).includes('GridGlow'));
});

test('should rewrite @/, ~/ and tsconfig-paths imports and never list them as dependencies, while keeping @scope/pkg as a dependency', async () => {
  const catalogRootDir = await tempDir('blockbase-adapt-catalog-');
  const catalogRoot = join(catalogRootDir, 'catalog');
  const projectPath = await freshProject();
  // Stand-in for the halftone-flow shape (ARK-425): an index.tsx entry that reaches its sibling
  // files through source path aliases, plus real scoped and unscoped npm packages.
  const files = {
    'index.tsx': [
      "import { Canvas } from '@react-three/fiber';",
      "import { motion } from 'motion/react';",
      "import { Shader } from '@/backgrounds/shader';",
      "import { cn } from '~/lib/utils';",
      "import { Button } from '#ui/button';",
      'export function HalftoneFlow() {',
      '  return <Canvas><Shader /><motion.div className={cn()}><Button /></motion.div></Canvas>;',
      '}',
      '',
    ].join('\n'),
    'backgrounds/shader.tsx': 'export function Shader() {\n  return null;\n}\n',
    'ui/button.tsx': 'export function Button() {\n  return null;\n}\n',
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'], '#ui/*': ['./ui/*'] } } }),
  };
  try {
    const manifest = await fixtureManifest();
    Object.assign(manifest, { componentId: 'cmp_test_halftone_flow', namespace: 'test', slug: 'halftone-flow', displayName: 'Halftone Flow' });
    await importEnvelope({
      schemaVersion: '1',
      sourceType: 'directory',
      files: Object.entries(files).map(([path, content]) => ({ path, content, contentHash: sha256(content) })),
      assets: [],
      entryPoint: 'index.tsx',
      provenance: { sourceType: 'directory', locator: 'fixtures/halftone-flow-standin' },
    }, { catalogRoot, manifest });
    await rebuildIndex({ catalogRoot });
    const bundle = await prepareComponentAdaptation('cmp_test_halftone_flow', { catalogRoot, projectPath });

    const added = bundle.dependencyDelta.add.map((dependency) => dependency.name);
    assert.deepEqual(added.filter((name) => name.startsWith('@/') || name.startsWith('~') || name.startsWith('#')), []);
    assert.ok(added.includes('@react-three/fiber'), 'scoped npm packages stay dependencies');
    assert.ok(added.includes('motion'), 'unscoped npm packages stay dependencies');

    const entry = bundle.files.find((file) => file.path.endsWith('/index.tsx'));
    assert.ok(entry, 'entry file is placed');
    assert.match(entry.content, /from '\.\/backgrounds\/shader'/);
    assert.match(entry.content, /from '\.\/ui\/button'/);
    // Missing alias target: re-pointed at the destination alias, still never an npm dependency.
    assert.match(entry.content, /from '@\/lib\/utils'/);
    assert.ok(bundle.residuals.some((residual) => residual.includes('~/lib/utils')), 'missing alias target is surfaced as a residual');

    assert.notEqual(bundle.placement.importPath, '@/index');
    // The import path must resolve through the destination alias (@/* -> src/*) to the placed entry.
    const resolvedEntry = bundle.placement.importPath.replace(/^@\//, 'src/');
    assert.ok(bundle.files.some((file) => file.path === `${resolvedEntry}/index.tsx` || file.path === `${resolvedEntry}.tsx`), `importPath ${bundle.placement.importPath} resolves to a placed file`);
  } finally {
    await rm(catalogRootDir, { recursive: true, force: true });
    await rm(projectPath, { recursive: true, force: true });
  }
});

async function prepareInline(slug, content, { manifestDependencies = [], projectDependencies } = {}) {
  const catalogRootDir = await tempDir('blockbase-adapt-catalog-');
  const catalogRoot = join(catalogRootDir, 'catalog');
  const projectPath = await freshProject();
  try {
    if (projectDependencies) {
      const packagePath = join(projectPath, 'package.json');
      const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
      Object.assign(pkg.dependencies, projectDependencies);
      await writeFile(packagePath, JSON.stringify(pkg));
    }
    const manifest = await fixtureManifest();
    Object.assign(manifest, { componentId: `cmp_test_${slug.replaceAll('-', '_')}`, namespace: 'test', slug, displayName: slug, dependencies: manifestDependencies });
    await importEnvelope({
      schemaVersion: '1',
      sourceType: 'directory',
      files: [{ path: 'Widget.tsx', content, contentHash: sha256(content) }],
      assets: [],
      entryPoint: 'Widget.tsx',
      provenance: { sourceType: 'directory', locator: `fixtures/${slug}` },
    }, { catalogRoot, manifest });
    await rebuildIndex({ catalogRoot });
    return await prepareComponentAdaptation(manifest.componentId, { catalogRoot, projectPath });
  } finally {
    await rm(catalogRootDir, { recursive: true, force: true });
    await rm(projectPath, { recursive: true, force: true });
  }
}

const widget = (className) => `export function Widget() {\n  return <div${className ? ` className="${className}"` : ''}>Widget</div>;\n}\n`;

test('should give low risk with zero residuals and no conflict', async () => {
  const bundle = await prepareInline('risk-low', widget());
  assert.deepEqual(bundle.residuals, []);
  assert.deepEqual(bundle.dependencyDelta.conflicts, []);
  assert.equal(bundle.risk, 'low');
});

test('should give medium risk for exactly one residual', async () => {
  const bundle = await prepareInline('risk-one', widget('bg-[#102030]'));
  assert.equal(bundle.residuals.length, 1, bundle.residuals.join('\n'));
  assert.equal(bundle.risk, 'medium');
});

test('should give high risk for two residuals', async () => {
  const bundle = await prepareInline('risk-two', widget('bg-[#102030] text-[#405060]'));
  assert.equal(bundle.residuals.length, 2, bundle.residuals.join('\n'));
  assert.equal(bundle.risk, 'high');
});

test('should give high risk for a dependency conflict with zero residuals', async () => {
  const bundle = await prepareInline('risk-conflict', widget(), {
    manifestDependencies: [{ name: 'react', range: '18.3.1', kind: 'runtime' }],
    projectDependencies: { react: '18.0.0' },
  });
  assert.deepEqual(bundle.residuals, []);
  assert.ok(bundle.dependencyDelta.conflicts.length > 0);
  assert.equal(bundle.risk, 'high');
});
