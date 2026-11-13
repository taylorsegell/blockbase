#!/usr/bin/env node

import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { normalizeSource, rebuildIndex } from '../../packages/core/dist/index.js';

const integrationRoot = resolve(import.meta.dirname);
const repositoryRoot = resolve(integrationRoot, '../..');
const cli = join(repositoryRoot, 'packages/cli/dist/index.js');
const source = join(repositoryRoot, 'tests/fixtures/sources/normalization/static-tailwind');

function invoke(executable, args) {
  const result = spawnSync(process.execPath, [executable, ...args, '--json'], {
    cwd: repositoryRoot,
    env: { ...process.env },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

const root = await mkdtemp(join(tmpdir(), 'blockbase-cutover-'));
const catalog = join(root, 'catalog');
const home = join(root, 'agent-home');
const executable = join(home, 'bin', 'blockbase');
try {
  const install = invoke(cli, ['agent', 'install', '--provider', 'codex', '--scope', 'global', '--home', home]);
  const check = invoke(executable, ['agent', 'check', '--provider', 'codex', '--scope', 'global', '--home', home]);
  const capture = invoke(executable, ['import', source, '--catalog', catalog, '--namespace', 'capture-fixture', '--slug', 'static-card']);
  const normalization = normalizeSource(capture.data.envelope);
  const rebuilt = await rebuildIndex({ catalogRoot: catalog });
  const rebuild = invoke(executable, ['catalog', 'rebuild', '--catalog', catalog]);
  const original = await readFile(join(capture.data.revisionPath, 'original', 'StaticCard.tsx'), 'utf8');
  const expected = await readFile(join(source, 'StaticCard.tsx'), 'utf8');
  assert.equal(original, expected);
  await access(rebuilt.indexPath);
  const report = {
    schemaVersion: '1',
    mode: 'dry-run',
    installation: { install: install.operation, check: check.operation, verified: true },
    capture: {
      operation: capture.operation,
      revisionId: capture.data.revisionId,
      normalization: normalization.report.status,
      originalBytesPreserved: true,
      packagePath: capture.data.packagePath,
      indexPath: rebuilt.indexPath,
      indexEntries: rebuilt.componentCount,
      rebuildEntries: rebuild.data.componentCount,
    },
    externalWorkflow: {
      status: 'preserved',
      action: 'not-run',
      note: 'The dry run never removes the external organizer skill or user data.',
    },
    retirement: { status: 'not-run', reason: 'Retirement requires an explicit user decision after verification.' },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
