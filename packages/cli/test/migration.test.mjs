import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseCliErrorEnvelope, parseCliSuccessEnvelope } from '@blockbase/contracts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '../..');
const executable = resolve(packageRoot, 'dist/index.js');
const fixtures = resolve(packageRoot, '../../tests/fixtures/legacy-catalog');

function invoke(args, options = {}) {
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd: options.cwd ?? packageRoot,
    env: { ...process.env, BLOCKBASE_HOME: options.blockbaseHome ?? join(packageRoot, 'missing-home') },
    encoding: 'utf8',
  });
  return { ...result, json: args.includes('--json') && result.stdout.trim() ? JSON.parse(result.stdout) : null };
}

// Acceptance criterion 6: apply must be impossible to mistake for dry-run in
// CLI arguments and output. These tests exercise the actual parsed-arg
// validation path (line ~377 of packages/cli/src/index.ts), not just read it.

test('catalog migrate rejects when neither --dry-run nor --apply is given (no silent default)', () => {
  const result = invoke(['catalog', 'migrate', '--catalog', join(fixtures, 'valid'), '--target', '/tmp/unused', '--json']);
  assert.equal(result.status, 2);
  const envelope = parseCliErrorEnvelope(result.json);
  assert.equal(envelope.error.code, 'INVALID_ARGUMENTS');
  assert.match(envelope.error.message, /exactly one of --dry-run or --apply/);
});

test('catalog migrate rejects when both --dry-run and --apply are given', () => {
  const result = invoke(['catalog', 'migrate', '--catalog', join(fixtures, 'valid'), '--target', '/tmp/unused', '--dry-run', '--apply', '--json']);
  assert.equal(result.status, 2);
  const envelope = parseCliErrorEnvelope(result.json);
  assert.equal(envelope.error.code, 'INVALID_ARGUMENTS');
  assert.match(envelope.error.message, /exactly one of --dry-run or --apply/);
});

test('catalog migrate --resume rejects an additional --dry-run or --apply flag', async () => {
  const target = await mkdtemp('/tmp/blockbase-cli-migration-resume-');
  const withDryRun = invoke(['catalog', 'migrate', '--catalog', join(fixtures, 'valid'), '--target', target, '--resume', join(target, 'missing-report.json'), '--dry-run', '--json']);
  assert.equal(withDryRun.status, 2);
  assert.equal(parseCliErrorEnvelope(withDryRun.json).error.code, 'INVALID_ARGUMENTS');
  const withApply = invoke(['catalog', 'migrate', '--catalog', join(fixtures, 'valid'), '--target', target, '--resume', join(target, 'missing-report.json'), '--apply', '--json']);
  assert.equal(withApply.status, 2);
  assert.equal(parseCliErrorEnvelope(withApply.json).error.code, 'INVALID_ARGUMENTS');
});

test('dry-run and apply produce distinguishable JSON mode and human-readable stdout text', async () => {
  const source = join(fixtures, 'valid');
  const dryTarget = await mkdtemp('/tmp/blockbase-cli-migration-dry-');
  const applyTarget = await mkdtemp('/tmp/blockbase-cli-migration-apply-');

  const dry = invoke(['catalog', 'migrate', '--catalog', source, '--target', dryTarget, '--dry-run', '--json']);
  assert.equal(dry.status, 0);
  const dryEnvelope = parseCliSuccessEnvelope(dry.json);
  assert.equal(dryEnvelope.data.mode, 'plan');
  assert.equal(dryEnvelope.data.status, undefined, 'plan mode must not report an apply-shaped status field');

  const dryHuman = invoke(['catalog', 'migrate', '--catalog', source, '--target', dryTarget, '--dry-run']);
  assert.match(dryHuman.stdout, /Catalog migration: plan\b/);
  assert.doesNotMatch(dryHuman.stdout, /Catalog migration: apply\b/);

  const apply = invoke(['catalog', 'migrate', '--catalog', source, '--target', applyTarget, '--apply', '--json']);
  assert.equal(apply.status, 0);
  const applyEnvelope = parseCliSuccessEnvelope(apply.json);
  assert.equal(applyEnvelope.data.mode, 'apply');
  assert.equal(applyEnvelope.data.status, 'complete');

  const applyHuman = invoke(['catalog', 'migrate', '--catalog', source, '--target', applyTarget, '--apply']);
  assert.match(applyHuman.stdout, /Catalog migration: apply \(complete\)/);
  assert.doesNotMatch(applyHuman.stdout, /Catalog migration: plan\b/);

  // The dry-run target must remain untouched by the dry run itself (only the
  // second, --apply-targeted directory may contain migrated packages).
  assert.deepEqual(await readdir(dryTarget), []);
  const applyEntries = await readdir(applyTarget);
  assert.ok(applyEntries.length > 0, 'apply must actually write to its own target');
});

