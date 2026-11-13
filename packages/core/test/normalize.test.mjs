import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import * as ts from 'typescript';
import { normalizeSource, readLocalSource, sha256 } from '../dist/index.js';

const fixtureRoot = resolve(import.meta.dirname, '../../../tests/fixtures/sources/normalization');

async function normalizeFixture(name) {
  const entries = await readdir(join(fixtureRoot, name));
  const entryPoint = entries.find((entry) => /\.(?:tsx|jsx)$/.test(entry));
  const source = await readLocalSource(join(fixtureRoot, name), entryPoint ? { entryPoint } : undefined);
  return { source, result: normalizeSource(source.envelope) };
}

test('static Tailwind and finite conditional branches map to canonical roles', async () => {
  const { result } = await normalizeFixture('static-tailwind');
  assert.equal(result.status, 'safe');
  assert.ok(result.tokenContract.tokens.some((token) => token.name === 'color.surface.elevated'));
  assert.ok(result.tokenContract.tokens.some((token) => token.name === 'space.4'));
  assert.equal(result.residuals.length, 0);

  const conditional = await normalizeFixture('conditional-branches');
  assert.equal(conditional.result.status, 'safe');
  assert.ok(conditional.result.occurrences.filter((entry) => entry.kind === 'tailwind').length >= 4);
  assert.match(conditional.result.normalizedFiles[0].content, /active \?/);
});

test('arbitrary literals remain visible as residuals with exact evidence', async () => {
  const { result } = await normalizeFixture('arbitrary-literals');
  assert.equal(result.status, 'needs-review');
  assert.equal(result.report.status, 'partial');
  assert.ok(result.residuals.length >= 3);
  const color = result.residuals.find((entry) => entry.source === '#102030');
  assert.ok(color);
  assert.equal(color.fallbackValue, '#102030');
  assert.equal(color.fallback, '#102030');
  assert.equal(color.line, 2);
  assert.ok(color.column > 0);
  assert.equal(color.confidence, 0.35);
});

test('plain CSS, CSS Modules, and static inline styles preserve source and classify variables', async () => {
  const plain = await normalizeFixture('plain-css');
  assert.equal(plain.result.status, 'needs-review');
  assert.ok(plain.result.occurrences.some((entry) => entry.kind === 'css' && entry.tokenName === 'color.surface.default'));
  assert.ok(plain.result.occurrences.some((entry) => entry.tokenName === 'space.4'));
  assert.ok(plain.result.residuals.some((entry) => entry.path.endsWith('Card.css')));

  const modules = await normalizeFixture('css-modules');
  assert.equal(modules.result.status, 'needs-review');
  assert.ok(modules.result.occurrences.some((entry) => entry.kind === 'css-module'));

  const inline = await normalizeFixture('inline-static');
  assert.equal(inline.result.status, 'needs-review');
  assert.ok(inline.result.occurrences.some((entry) => entry.kind === 'inline-style' && entry.tokenName === 'color.surface.default'));
  assert.ok(inline.result.residuals.some((entry) => entry.source === '#102030'));
});

test('local helper imports resolve and third-party imports are recorded without execution', async () => {
  const helper = await normalizeFixture('local-helpers');
  assert.equal(helper.result.status, 'safe');
  assert.equal(helper.result.dependencyContract.dependencies[0].path, 'helper.ts');
  assert.equal(helper.result.dependencyContract.dependencies[0].status, 'resolved');
  assert.ok(helper.result.tokenContract.tokens.some((token) => token.name === 'color.surface.default'));

  const thirdParty = await normalizeFixture('third-party-import');
  assert.equal(thirdParty.result.status, 'safe');
  assert.deepEqual(thirdParty.result.dependencyContract.dependencies.map((entry) => [entry.packageName, entry.status]), [['clsx', 'external']]);
});

test('missing local imports are partial and dynamic styles are unsupported', async () => {
  const partial = await normalizeFixture('partial-decomposition');
  assert.equal(partial.result.status, 'needs-review');
  assert.equal(partial.result.report.status, 'partial');
  assert.equal(partial.result.residuals.filter((entry) => entry.kind === 'unresolved-import').length, 1);
  assert.match(partial.result.residuals[0].reason, /immutable source envelope/);

  const dynamic = await normalizeFixture('unsupported-dynamic');
  assert.equal(dynamic.result.status, 'unsupported');
  assert.equal(dynamic.result.report.status, 'unsupported');
  assert.ok(dynamic.result.residuals.some((entry) => entry.kind === 'unsupported-syntax'));
});

test('normalization is byte-deterministic and leaves immutable source bytes unchanged', async () => {
  const { source, result: first } = await normalizeFixture('static-tailwind');
  const before = source.envelope.files.map((file) => [file.path, file.content, file.contentHash]);
  const second = normalizeSource(source.envelope);
  assert.deepEqual(second, first);
  assert.deepEqual(source.envelope.files.map((file) => [file.path, file.content, file.contentHash]), before);
  for (const file of first.normalizedFiles) assert.equal(file.content, before.find(([path]) => path === file.path)[1]);
  assert.equal(await readFile(join(fixtureRoot, 'static-tailwind/StaticCard.tsx'), 'utf8'), before.find(([path]) => path.endsWith('.tsx'))[1]);
});

test('normalized React fixture output remains compilable TypeScript syntax', async () => {
  for (const name of ['static-tailwind', 'conditional-branches', 'inline-static', 'local-helpers', 'third-party-import']) {
    const { result } = await normalizeFixture(name);
    for (const file of result.normalizedFiles.filter((entry) => /\.(?:tsx|jsx|ts|js)$/.test(entry.path))) {
      const output = ts.transpileModule(file.content, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, reportDiagnostics: true });
      assert.deepEqual(output.diagnostics ?? [], [], `${name}/${file.path} should compile`);
    }
  }
});

test('path-alias imports are local records, never third-party, while @scope/pkg stays third-party', () => {
  const file = (path, content) => ({ path, content, contentHash: sha256(content) });
  const result = normalizeSource({
    schemaVersion: '1',
    sourceType: 'directory',
    files: [
      file('index.tsx', "import a from '@/backgrounds';\nimport b from '~/lib/utils';\nimport c from '#ui/button';\nimport d from '@scope/pkg/sub';\n"),
      file('backgrounds/index.ts', 'export default 1;\n'),
      file('ui/button.tsx', 'export default 1;\n'),
      file('tsconfig.json', '{ "compilerOptions": { "paths": { "#ui/*": ["./ui/*"] } } }'),
    ],
    assets: [],
    provenance: { sourceType: 'directory', locator: 'synthetic' },
  });
  const bySpecifier = Object.fromEntries(result.dependencyContract.dependencies.map((record) => [record.specifier, record]));
  assert.equal(bySpecifier['@/backgrounds'].kind, 'local');
  assert.equal(bySpecifier['@/backgrounds'].path, 'backgrounds/index.ts');
  assert.equal(bySpecifier['#ui/button'].path, 'ui/button.tsx');
  assert.equal(bySpecifier['~/lib/utils'].status, 'missing');
  assert.equal(bySpecifier['@scope/pkg/sub'].kind, 'third-party');
  assert.equal(bySpecifier['@scope/pkg/sub'].packageName, '@scope/pkg');
});

test('theme utilities outside the semantic subset are reported once', () => {
  const content = 'export function Panel() {\n  return <div className="bg-white/10 text-neutral-400">Panel</div>;\n}\n';
  const result = normalizeSource({
    schemaVersion: '1',
    sourceType: 'directory',
    files: [{ path: 'Panel.tsx', content, contentHash: sha256(content) }],
    assets: [],
    entryPoint: 'Panel.tsx',
    provenance: { sourceType: 'directory', locator: 'synthetic' },
  });
  for (const utility of ['bg-white/10', 'text-neutral-400']) {
    const matches = result.residuals.filter((entry) => entry.source === utility);
    assert.equal(matches.length, 1, `${utility} reported ${matches.length} times`);
  }
  const positions = result.residuals.map((entry) => `${entry.path}:${entry.line}:${entry.column}:${entry.source}`);
  assert.equal(new Set(positions).size, positions.length);
});
