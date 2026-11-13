import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { importPaste, prepareComponentAdaptation, rebuildIndex } from '../dist/index.js';

const projectFixture = resolve(import.meta.dirname, '../../../tests/fixtures/destinations/fixture-a');

// SYNTHETIC FIXTURE: written for Blockbase tests, not copied from 21st.dev.
const pasteText = [
  '```tsx',
  'demo-card.tsx',
  'import { gsap } from "gsap"',
  'import { Swiper } from "swiper/react"',
  'export function DemoCard() {',
  '  gsap.to(".demo-card", { opacity: 1 });',
  '  return <Swiper className="demo-card" />;',
  '}',
  '```',
  '',
  'Install NPM dependencies:',
  '```bash',
  'gsap@1.2.3',
  'swiper',
  '```',
  '',
].join('\n');

async function project(extraDependencies) {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-adapt-paste-project-'));
  await cp(projectFixture, root, { recursive: true });
  const manifestPath = join(root, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.dependencies = { ...manifest.dependencies, ...extraDependencies };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return root;
}

test('adapt reads recorded dependencies from an imported block', async () => {
  const catalogRoot = join(await mkdtemp(join(tmpdir(), 'blockbase-adapt-paste-')), 'catalog');
  const imported = await importPaste(pasteText, { catalogRoot, namespace: 'test', slug: 'demo-card', displayName: 'Demo Card' });
  await rebuildIndex({ catalogRoot });
  assert.deepEqual(imported.manifest.dependencies, [{ name: 'gsap', range: '1.2.3', kind: 'runtime' }, { name: 'swiper', range: '*', kind: 'runtime' }]);

  const pinned = await prepareComponentAdaptation(imported.manifest.componentId, { catalogRoot, projectPath: await project({ gsap: '3.0.0', swiper: '2.0.0' }) });
  assert.deepEqual(pinned.dependencyDelta.conflicts, ['gsap: destination 3.0.0 does not satisfy source 1.2.3']);

  const bare = await prepareComponentAdaptation(imported.manifest.componentId, { catalogRoot, projectPath: await project({}) });
  const added = Object.fromEntries(bare.dependencyDelta.add.map((item) => [item.name, item.range]));
  assert.equal(added.gsap, '1.2.3');
  assert.equal(added.swiper, '*');
  assert.deepEqual(bare.dependencyDelta.conflicts, []);
});
