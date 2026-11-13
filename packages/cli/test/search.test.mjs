import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { parseCliErrorEnvelope, parseCliSuccessEnvelope } from '@blockbase/contracts';

const packageRoot = resolve(import.meta.dirname, '..');
const executable = resolve(packageRoot, 'dist/index.js');

function invoke(args) {
  const result = spawnSync(process.execPath, [executable, ...args], { encoding: 'utf8' });
  return { ...result, json: result.stdout.trim() ? JSON.parse(result.stdout) : null };
}

test('CLI rebuild, search, exact inspect, miss, ambiguity, and corrupt-index recovery are schema-valid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-cli-search-'));
  const catalog = join(root, 'catalog');
  const sourceA = join(root, 'a');
  const sourceB = join(root, 'b');
  await mkdir(sourceA);
  await mkdir(sourceB);
  await writeFile(join(sourceA, 'Card.tsx'), 'export function Card(){ return <div>Animated pricing card</div>; }\n');
  await writeFile(join(sourceB, 'Panel.tsx'), 'export function Panel(){ return <div>Animated pricing card</div>; }\n');
  const importedA = invoke(['import', sourceA, '--catalog', catalog, '--namespace', 'tests', '--slug', 'card-a', '--name', 'Pricing Card', '--json']);
  const importedB = invoke(['import', sourceB, '--catalog', catalog, '--namespace', 'tests', '--slug', 'card-b', '--name', 'Pricing Card', '--json']);
  assert.equal(importedA.status, 0);
  assert.equal(importedB.status, 0);
  const manifestA = JSON.parse(importedA.json.data.manifest ? JSON.stringify(importedA.json.data.manifest) : await readFile(join(catalog, 'components/tests/card-a/component.json'), 'utf8'));
  manifestA.aliases = ['pricing alias'];
  await writeFile(join(catalog, 'components/tests/card-a/component.json'), `${JSON.stringify(manifestA, null, 2)}\n`);

  const rebuilt = invoke(['catalog', 'rebuild', '--catalog', catalog, '--json']);
  assert.equal(rebuilt.status, 0);
  const rebuildEnvelope = parseCliSuccessEnvelope(rebuilt.json);
  assert.equal(rebuildEnvelope.data.componentCount, 2);

  const ranked = invoke(['search', 'animated pricing card', '--catalog', catalog, '--confidence-margin', '0.2', '--json']);
  assert.equal(ranked.status, 0);
  assert.equal(ranked.stderr, '');
  const rankedEnvelope = parseCliSuccessEnvelope(ranked.json);
  assert.equal(rankedEnvelope.operation, 'search');
  assert.equal(rankedEnvelope.data.selection.status, 'needs-selection');
  assert.ok(rankedEnvelope.data.results.every((result) => result.evidence.length > 0));

  const inspected = invoke(['inspect', 'pricing alias', '--catalog', catalog, '--json']);
  assert.equal(inspected.status, 0);
  const inspectEnvelope = parseCliSuccessEnvelope(inspected.json);
  assert.equal(inspectEnvelope.data.lookup.matchedBy, 'alias');
  assert.ok(inspectEnvelope.data.evidence.length > 0);

  const miss = invoke(['search', 'missing constellation', '--catalog', catalog, '--json']);
  assert.equal(miss.status, 0);
  assert.deepEqual(parseCliSuccessEnvelope(miss.json).data.results, []);
  assert.equal(parseCliSuccessEnvelope(miss.json).data.recoveryActions.length, 3);

  await writeFile(join(catalog, 'index.sqlite'), 'corrupted');
  const corrupt = invoke(['search', 'card', '--catalog', catalog, '--json']);
  assert.equal(corrupt.status, 7);
  const corruptEnvelope = parseCliErrorEnvelope(corrupt.json);
  assert.equal(corruptEnvelope.error.code, 'INDEX_CORRUPT');
  assert.equal(corruptEnvelope.recoveryActions[0].id, 'rebuild-index');

  const repaired = invoke(['catalog', 'rebuild', '--catalog', catalog, '--json']);
  assert.equal(repaired.status, 0);
  assert.equal(parseCliSuccessEnvelope(repaired.json).data.componentCount, 2);
  const recoveredSearch = invoke(['search', 'animated pricing card', '--catalog', catalog, '--json']);
  assert.equal(recoveredSearch.status, 0);
  assert.equal(parseCliSuccessEnvelope(recoveredSearch.json).data.results.length, 2);

  await rm(join(catalog, 'index.sqlite'));
  const missing = invoke(['search', 'card', '--catalog', catalog, '--json']);
  assert.equal(missing.status, 3);
  assert.equal(parseCliErrorEnvelope(missing.json).error.code, 'INDEX_NOT_FOUND');
  const restored = invoke(['catalog', 'rebuild', '--catalog', catalog, '--json']);
  assert.equal(restored.status, 0);
  await rm(root, { recursive: true, force: true });
});
