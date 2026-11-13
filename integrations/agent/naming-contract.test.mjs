import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');

test('public integration surfaces use the Blockbase naming contract with no aliases', async () => {
  const script = resolve(repositoryRoot, 'scripts/check-blockbase-naming.mjs');
  const result = spawnSync(process.execPath, [script], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'passed');
  assert.ok(report.scannedFiles.length > 10);
  assert.deepEqual(report.hits, []);

  // The pre-Blockbase preview app is not part of this repository, so no legacy identifiers remain.
  assert.deepEqual(report.intentionalLegacyInput, []);
  const projectOverride = await readFile(resolve(repositoryRoot, 'packages/core/src/project/inspect.ts'), 'utf8');
  assert.match(projectOverride, /\.blockbase\/project\.json/);
});
