import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  IMPORT_ERROR_CODES,
  ImportError,
  applyExtras,
  catalogHistoryHealth,
  diagnoseIndex,
  importPaste,
  importSource,
  importSourceWithExtras,
  parseTwentyFirstPaste,
  prepareDemo,
  rebuildIndex,
  recoverRevisionStore,
  undoCatalogChanges,
} from '../dist/index.js';

const fixture = (name) => readFile(resolve(import.meta.dirname, 'fixtures/twentyfirst', name), 'utf8');
const tempCatalog = async () => join(await mkdtemp(join(tmpdir(), 'blockbase-paste-')), 'catalog');

test('current-format paste imports the component as the block and keeps the demo out of it', async () => {
  const catalogRoot = await tempCatalog();
  const imported = await importPaste(await fixture('current-format.txt'), { catalogRoot });
  assert.deepEqual(imported.envelope.files.map((file) => file.path), ['skyline-card.tsx']);
  assert.equal(imported.envelope.entryPoint, 'skyline-card.tsx');
  assert.equal(imported.envelope.sourceType, 'paste');
  assert.deepEqual(imported.envelope.provenance, { sourceType: 'paste', locator: '<paste>' });
  assert.equal(imported.manifest.slug, 'skyline-card');
  assert.equal(imported.manifest.provenance.sourceType, 'paste');
  assert.equal(imported.reading.format, 'filename-fences');
  const stored = await readdir(join(imported.revisionPath, 'original'), { recursive: true });
  assert.deepEqual(stored, ['skyline-card.tsx']);
  const component = imported.reading.files.find((file) => file.role === 'component');
  assert.equal(await readFile(join(imported.revisionPath, 'original', 'skyline-card.tsx'), 'utf8'), component.content);
});

test('bare code without a name throws IMPORT_PASTE_NAME_REQUIRED and imports nothing', async () => {
  const catalogRoot = await tempCatalog();
  await assert.rejects(importPaste(await fixture('bare-fenced.txt'), { catalogRoot }), (error) => error instanceof ImportError && error.code === IMPORT_ERROR_CODES.pasteNameRequired);
  assert.equal(existsSync(join(catalogRoot, 'components')), false);
});

test('bare code with a name is stored under the slug of that name', async () => {
  const catalogRoot = await tempCatalog();
  const imported = await importPaste(await fixture('bare-unfenced.txt'), { catalogRoot, displayName: 'Soft Tag' });
  assert.deepEqual(imported.envelope.files.map((file) => file.path), ['soft-tag.tsx']);
  assert.equal(imported.envelope.entryPoint, 'soft-tag.tsx');
  assert.equal(imported.manifest.slug, 'soft-tag');
  const slugged = await importPaste(await fixture('bare-fenced.txt'), { catalogRoot, displayName: 'Glow', slug: 'glow-button' });
  assert.deepEqual(slugged.envelope.files.map((file) => file.path), ['glow-button.tsx']);
});

test('unreadable paste throws IMPORT_PASTE_UNREADABLE and imports nothing', async () => {
  const catalogRoot = await tempCatalog();
  await assert.rejects(importPaste(await fixture('unreadable-prose.txt'), { catalogRoot, displayName: 'Twin' }), (error) => error instanceof ImportError && error.code === IMPORT_ERROR_CODES.pasteUnreadable && error.details.reasons.includes('format:no-code-found'));
  assert.equal(existsSync(join(catalogRoot, 'components')), false);
});

// ---- P2: demo, raw paste, provenance, dependencies, warnings ----

const packageDir = (catalogRoot, slug, namespace = 'local') => join(catalogRoot, 'components', namespace, slug);
// History starts on the first write into an existing catalog folder, so undo tests create it first.
const existingCatalog = async () => {
  const catalogRoot = await tempCatalog();
  mkdirSync(catalogRoot, { recursive: true });
  return catalogRoot;
};
const withoutDemo = (text) => text.replace(/\ndemo\.tsx\n[\s\S]*?(?=```)/, '\n');

/** What `catalog validate`, `doctor` and `catalog rebuild` check on a migrated catalog. */
async function assertCatalogHealthy(catalogRoot, { clean = true } = {}) {
  await rebuildIndex({ catalogRoot });
  const status = await diagnoseIndex({ catalogRoot });
  assert.equal(status.healthy, true, `index health: ${status.cause ?? status.classification}`);
  const history = await catalogHistoryHealth(catalogRoot);
  if (clean && history.enabled) assert.deepEqual(history.uncommittedPaths, []);
}

test('current-format paste yields component and demo as separate files', async () => {
  const catalogRoot = await tempCatalog();
  const text = await fixture('current-format.txt');
  const imported = await importPaste(text, { catalogRoot });
  const pkg = packageDir(catalogRoot, 'skyline-card');
  assert.equal(imported.componentPath, pkg);
  assert.equal(imported.demo.installed, true);
  assert.equal(imported.demo.path, join(pkg, 'demo.tsx'));
  assert.deepEqual(imported.demo.rewrites, [{ from: '@/components/ui/skyline-card', to: '@block' }]);
  assert.deepEqual(imported.demo.warnings, []);
  const demo = imported.reading.files.find((file) => file.role === 'demo');
  assert.equal(await readFile(join(pkg, 'demo.tsx'), 'utf8'), demo.content.replace('"@/components/ui/skyline-card"', '"@block"'));
  assert.deepEqual((await readdir(join(imported.revisionPath, 'original'))).sort(), ['skyline-card.tsx']);
});

test('old-marker paste yields the same files as the current format', async () => {
  const current = await importPaste(await fixture('current-format.txt'), { catalogRoot: await tempCatalog() });
  const markers = await importPaste(await fixture('old-markers.txt'), { catalogRoot: await tempCatalog(), displayName: 'Skyline Card' });
  assert.equal(markers.revisionId, current.revisionId);
  assert.equal(await readFile(markers.demo.path, 'utf8'), await readFile(current.demo.path, 'utf8'));
  assert.deepEqual(markers.demo.rewrites, current.demo.rewrites);
});

test('npm packages come from the install list and import lines with subpaths collapsed', async () => {
  const imported = await importPaste(await fixture('current-format.txt'), { catalogRoot: await tempCatalog() });
  assert.deepEqual(imported.manifest.dependencies, [{ name: 'gsap', range: '3.12.5', kind: 'runtime' }]);
  const unlisted = await importPaste('<!-- SYNTHETIC FIXTURE -->\n```tsx\nwave-row.tsx\nimport * as React from "react"\nimport { motion } from "framer-motion"\nimport clsx from "clsx/lite"\nexport function WaveRow() {\n  return <motion.div className={clsx("a")} />;\n}\n```\n', { catalogRoot: await tempCatalog() });
  assert.deepEqual(unlisted.manifest.dependencies, [{ name: 'framer-motion', range: '*', kind: 'runtime' }, { name: 'clsx', range: '*', kind: 'runtime' }]);
});

test('author hint, source options and absent license are recorded', async () => {
  const hinted = await importPaste(await fixture('author-built-using.txt'), { catalogRoot: await tempCatalog() });
  assert.equal(hinted.reading.authorHint, 'Example Studio');
  assert.equal(hinted.manifest.provenance.author, 'Example Studio');
  assert.equal(hinted.manifest.provenance.license, 'unknown');
  assert.equal(hinted.manifest.provenance.attributionStatus, 'known');

  const explicit = await importPaste(await fixture('author-built-using.txt'), {
    catalogRoot: await tempCatalog(),
    extras: { sourceType: 'url', sourceUrl: 'https://example.invalid/r/ribbon-note', license: 'MIT', author: 'Someone Else', tags: ['card', 'promo', 'card'] },
  });
  assert.equal(explicit.manifest.provenance.author, 'Someone Else');
  assert.equal(explicit.manifest.provenance.license, 'MIT');
  assert.equal(explicit.manifest.provenance.sourceType, 'url');
  assert.equal(explicit.manifest.provenance.locator, 'https://example.invalid/r/ribbon-note');
  assert.deepEqual(explicit.envelope.provenance, { sourceType: 'url', locator: 'https://example.invalid/r/ribbon-note' });
  assert.deepEqual(explicit.manifest.tags, ['card', 'promo']);
  assert.equal(explicit.revisionId, hinted.revisionId, 'source details never change the revision identity');

  const bare = await importPaste(await fixture('no-demo.txt'), { catalogRoot: await tempCatalog() });
  assert.equal(bare.manifest.provenance.license, 'unknown');
  assert.equal(bare.manifest.provenance.attributionStatus, 'unknown');
  assert.equal('author' in bare.manifest.provenance, false);
  assert.equal(bare.demo.installed, false);

  await assert.rejects(importPaste(await fixture('no-demo.txt'), { catalogRoot: await tempCatalog(), extras: { sourceType: 'website' } }), (error) => error instanceof ImportError && error.code === IMPORT_ERROR_CODES.invalidEnvelope);
});

test('shadcn and remote asset warnings appear and no new dependency kind is used', async () => {
  const imported = await importPaste(await fixture('with-shadcn-and-remote.txt'), { catalogRoot: await tempCatalog() });
  for (const warning of ['shadcn-missing:@/components/ui/button', 'alias-unresolved:@/lib/utils', 'remote-url:promo-banner.tsx']) {
    assert.ok(imported.warnings.includes(warning), warning);
    assert.ok(imported.manifest.quality.warnings.includes(warning), warning);
  }
  assert.ok(imported.manifest.dependencies.every((dependency) => dependency.kind === 'runtime'));
  assert.deepEqual(imported.demo.rewrites, [{ from: '@/components/ui/promo-banner', to: '@block' }]);
});

test('suspicions become paste-suspect warnings and the paste still imports', async () => {
  const imported = await importPaste(await fixture('suspect-truncated.txt'), { catalogRoot: await tempCatalog(), displayName: 'Suspect' });
  assert.ok(imported.reading.suspicions.length > 0);
  for (const suspicion of imported.reading.suspicions) assert.ok(imported.warnings.includes(`paste-suspect:${suspicion.file}:${suspicion.reason}`));
});

test('use client is preserved in the stored component', async () => {
  const imported = await importPaste(await fixture('current-format.txt'), { catalogRoot: await tempCatalog() });
  const stored = await readFile(join(imported.revisionPath, 'original', 'skyline-card.tsx'), 'utf8');
  assert.equal(stored.split('\n')[0], '"use client"');
});

test('raw paste is stored once and re-reading gives the same files', async () => {
  const text = await fixture('current-format.txt');
  const imported = await importPaste(text, { catalogRoot: await tempCatalog() });
  assert.equal(imported.rawPastePath, join(imported.componentPath, 'source-paste.txt'));
  const stored = await readFile(imported.rawPastePath, 'utf8');
  assert.equal(stored, text);
  assert.deepEqual(parseTwentyFirstPaste(stored), imported.reading);
  const revisionFiles = await readdir(imported.revisionPath, { recursive: true });
  assert.equal(revisionFiles.some((name) => name.includes('source-paste') || name.endsWith('demo.tsx')), false);
});

test('demo and raw paste stay outside the revision: identity equals a plain file import', async () => {
  const imported = await importPaste(await fixture('current-format.txt'), { catalogRoot: await tempCatalog() });
  const component = imported.reading.files.find((file) => file.role === 'component');
  const dir = await mkdtemp(join(tmpdir(), 'blockbase-paste-file-'));
  await writeFile(join(dir, 'skyline-card.tsx'), component.content);
  const plain = await importSource(join(dir, 'skyline-card.tsx'), { catalogRoot: await tempCatalog() });
  assert.equal(plain.revisionId, imported.revisionId);
});

test('re-import with a demo overwrites it; a paste without a demo keeps the old one', async () => {
  const catalogRoot = await tempCatalog();
  const text = await fixture('current-format.txt');
  const first = await importPaste(text, { catalogRoot });
  await importPaste(text.replace('title="Demo"', 'title="Again"'), { catalogRoot });
  assert.match(await readFile(first.demo.path, 'utf8'), /title="Again"/);
  const noDemo = withoutDemo(text.replace('title="Demo"', 'title="Again"'));
  assert.equal(parseTwentyFirstPaste(noDemo).files.some((file) => file.role === 'demo'), false);
  const third = await importPaste(noDemo, { catalogRoot });
  assert.equal(third.demo.installed, false);
  assert.match(await readFile(first.demo.path, 'utf8'), /title="Again"/);
  assert.equal(await readFile(third.rawPastePath, 'utf8'), noDemo);
});

test('history undo removes block, demo and raw paste together', async () => {
  const catalogRoot = await existingCatalog();
  const imported = await importPaste(await fixture('current-format.txt'), { catalogRoot });
  assert.equal((await catalogHistoryHealth(catalogRoot)).enabled, true, 'history needs git on PATH');
  await undoCatalogChanges(catalogRoot);
  assert.equal(existsSync(join(imported.componentPath, 'component.json')), false);
  assert.equal(existsSync(join(imported.componentPath, 'demo.tsx')), false);
  assert.equal(existsSync(join(imported.componentPath, 'source-paste.txt')), false);
  assert.equal(existsSync(imported.revisionPath), false);
});

test('catalog validate, doctor and rebuild accept demo.tsx and source-paste.txt', async () => {
  const catalogRoot = await tempCatalog();
  await importPaste(await fixture('current-format.txt'), { catalogRoot });
  await assertCatalogHealthy(catalogRoot);
});

test('prepareDemo rewrites only entry specifiers and keeps every other byte', () => {
  const demo = 'import Card, { Part } from "./card"\nimport { Part as P2 } from \'@/components/card\'\nimport "../card"\nimport { helper } from "./helper"\nimport x from "@/lib/missing"\nimport y from "lodash"\nexport default function Demo() { return <Card />; }\n';
  const prepared = prepareDemo(demo, ['card', 'helper'], 'card');
  assert.equal(prepared.content, 'import Card, { Part } from "@block"\nimport { Part as P2 } from \'@block\'\nimport "@block"\nimport { helper } from "./helper"\nimport x from "@/lib/missing"\nimport y from "lodash"\nexport default function Demo() { return <Card />; }\n');
  assert.deepEqual(prepared.rewrites, [{ from: './card', to: '@block' }, { from: '@/components/card', to: '@block' }, { from: '../card', to: '@block' }]);
  assert.deepEqual(prepared.warnings, ['demo-import-nonentry:./helper', 'demo-import-unresolved:@/lib/missing']);

  const lonely = prepareDemo('import { Other } from "@/components/ui/other"\nexport function Demo() {}\n', ['card'], 'card');
  assert.deepEqual(lonely.rewrites, []);
  assert.deepEqual(lonely.warnings, ['demo-no-block-import', 'demo-no-default-export', 'demo-import-unresolved:@/components/ui/other']);
});

test('applyExtras: tags union, base dependencies win, explicit license wins', () => {
  const base = {
    tags: ['a'],
    dependencies: [{ name: 'gsap', range: '^2.0.0', kind: 'peer' }],
    provenance: { sourceType: 'paste', locator: '<paste>', license: 'Apache-2.0', attributionStatus: 'unknown' },
    quality: { warnings: ['w1'] },
  };
  const merged = applyExtras(base, { dependencies: [{ name: 'gsap', range: '3.0.0' }, { name: 'swiper', range: '*' }], tags: ['b', 'a'], warnings: ['w1', 'w2'] }, { tags: ['c', 'b'], license: 'MIT' });
  assert.deepEqual(merged.tags, ['a', 'b', 'c']);
  assert.deepEqual(merged.dependencies, [{ name: 'gsap', range: '^2.0.0', kind: 'peer' }, { name: 'swiper', range: '*', kind: 'runtime' }]);
  assert.equal(merged.provenance.license, 'MIT');
  assert.equal(merged.provenance.attributionStatus, 'known');
  assert.deepEqual(merged.quality.warnings, ['w1', 'w2']);
  const kept = applyExtras(base, {}, {});
  assert.equal(kept.provenance.license, 'Apache-2.0');
  assert.equal(kept.provenance.attributionStatus, 'unknown');
});

test('importSourceWithExtras installs a folder demo outside the revision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blockbase-paste-dir-'));
  await writeFile(join(dir, 'index.tsx'), 'export default function Tile() { return <div />; }\n');
  await writeFile(join(dir, 'demo.tsx'), 'import Tile from "./index"\nexport default function Demo() { return <Tile />; }\n');
  const catalogRoot = await tempCatalog();
  const imported = await importSourceWithExtras(dir, { catalogRoot, displayName: 'Tile', extras: { demoFile: 'demo.tsx', sourceUrl: 'https://example.invalid/tile', license: 'MIT' } });
  assert.deepEqual(imported.envelope.files.map((file) => file.path), ['index.tsx']);
  assert.equal(await readFile(join(imported.componentPath, 'demo.tsx'), 'utf8'), 'import Tile from "@block"\nexport default function Demo() { return <Tile />; }\n');
  assert.deepEqual(imported.demo.rewrites, [{ from: './index', to: '@block' }]);
  assert.equal(imported.manifest.provenance.locator, 'https://example.invalid/tile');
  assert.equal(imported.manifest.provenance.sourceType, 'directory');
  assert.equal(imported.manifest.provenance.license, 'MIT');

  const solo = await mkdtemp(join(tmpdir(), 'blockbase-paste-solo-'));
  await writeFile(join(solo, 'index.tsx'), 'export default function Tile() { return <div />; }\n');
  const plain = await importSource(solo, { catalogRoot: await tempCatalog(), displayName: 'Tile' });
  assert.equal(plain.revisionId, imported.revisionId);
  await assertCatalogHealthy(catalogRoot);

  const invalid = (error) => error instanceof ImportError && error.code === IMPORT_ERROR_CODES.invalidPath && typeof error.details.demo === 'string';
  await assert.rejects(importSourceWithExtras(dir, { catalogRoot: await tempCatalog(), extras: { demoFile: 'missing.tsx' } }), invalid);
  await assert.rejects(importSourceWithExtras(dir, { catalogRoot: await tempCatalog(), entryPoint: 'demo.tsx', extras: { demoFile: 'demo.tsx' } }), invalid);
  await assert.rejects(importSourceWithExtras(join(dir, 'index.tsx'), { catalogRoot: await tempCatalog(), extras: { demoFile: 'index.tsx' } }), invalid);
});

// Failure injection (PD-2): a directory named like the target makes the rename fail deterministically.
const failingAt = (catalogRoot, slug, step, name, also) => ({
  catalogRoot,
  onCommitStep: (current) => {
    if (current !== step) return;
    const pkg = packageDir(catalogRoot, slug);
    mkdirSync(join(pkg, name));
    also?.(pkg);
  },
});

for (const name of ['demo.tsx', 'source-paste.txt']) {
  test(`fresh package: a failed ${name} write removes the package and reports stage demo`, async () => {
    const catalogRoot = await tempCatalog();
    await assert.rejects(importPaste(await fixture('current-format.txt'), failingAt(catalogRoot, 'skyline-card', 'package-renamed', name)), (error) => error instanceof ImportError && error.code === IMPORT_ERROR_CODES.commitFailed && error.details.stage === 'demo' && error.details.committed === undefined);
    assert.equal(existsSync(packageDir(catalogRoot, 'skyline-card')), false);
  });
}

test('existing package: a failed demo write keeps the new revision and reports committed', async () => {
  const catalogRoot = await tempCatalog();
  const text = await fixture('current-format.txt');
  const first = await importPaste(withoutDemo(text), { catalogRoot });
  const changed = text.replace('keeps a', 'still keeps a');
  await assert.rejects(importPaste(changed, failingAt(catalogRoot, 'skyline-card', 'manifest-written', 'demo.tsx')), (error) => error instanceof ImportError && error.code === IMPORT_ERROR_CODES.commitFailed && error.details.stage === 'demo' && error.details.committed === true);
  const pkg = packageDir(catalogRoot, 'skyline-card');
  const manifest = JSON.parse(readFileSync(join(pkg, 'component.json'), 'utf8'));
  assert.notEqual(manifest.currentRevision, first.revisionId);
  assert.equal(existsSync(join(pkg, 'revisions', manifest.currentRevision.slice('sha256:'.length))), true);
  rmSync(join(pkg, 'demo.tsx'), { recursive: true });
  await assertCatalogHealthy(catalogRoot, { clean: false });
});

test('fresh package taken over by another import is left in place and reported committed', async () => {
  const catalogRoot = await tempCatalog();
  const options = failingAt(catalogRoot, 'skyline-card', 'package-renamed', 'demo.tsx', (pkg) => {
    const manifest = JSON.parse(readFileSync(join(pkg, 'component.json'), 'utf8'));
    writeFileSync(join(pkg, 'component.json'), JSON.stringify({ ...manifest, currentRevision: `sha256:${'0'.repeat(64)}` }));
  });
  await assert.rejects(importPaste(await fixture('current-format.txt'), options), (error) => error instanceof ImportError && error.details.stage === 'demo' && error.details.committed === true);
  assert.equal(existsSync(join(packageDir(catalogRoot, 'skyline-card'), 'component.json')), true);
});

test('leftover temp files beside component.json do not break validate, doctor, rebuild or undo', async () => {
  const catalogRoot = await existingCatalog();
  const imported = await importPaste(await fixture('current-format.txt'), { catalogRoot });
  await writeFile(join(imported.componentPath, 'demo.tsx.tmp-x'), 'partial');
  await writeFile(join(imported.componentPath, 'source-paste.txt.tmp-x'), 'partial');
  await assertCatalogHealthy(catalogRoot);
  await undoCatalogChanges(catalogRoot);
  assert.equal(existsSync(join(imported.componentPath, 'component.json')), false);
  await assertCatalogHealthy(catalogRoot);
});

test('recover removes temp files beside component.json and nothing else', async () => {
  const catalogRoot = await tempCatalog();
  const imported = await importPaste(await fixture('current-format.txt'), { catalogRoot });
  for (const name of ['demo.tsx.tmp-a', 'source-paste.txt.tmp-b', 'notes.md.tmp-c']) await writeFile(join(imported.componentPath, name), 'partial');
  const result = await recoverRevisionStore(catalogRoot);
  assert.deepEqual(result.removed.map((entry) => entry.kind).sort(), ['package-temporary', 'package-temporary', 'package-temporary']);
  assert.deepEqual((await readdir(imported.componentPath)).sort(), ['component.json', 'demo.tsx', 'revisions', 'source-paste.txt']);
});
