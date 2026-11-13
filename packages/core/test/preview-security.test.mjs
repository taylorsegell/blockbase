import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  PREVIEW_CSP,
  PREVIEW_DEPENDENCY_ALLOWLIST,
  PREVIEW_IFRAME_SANDBOX,
  inspectPreviewDependencies,
  preparePreview,
  startPreviewSession,
} from '../dist/index.js';
import { sha256 } from '../dist/index.js';

function envelope(content, path = 'Component.tsx') {
  return {
    schemaVersion: '1', sourceType: 'stdin',
    files: [{ path, content, contentHash: sha256(content) }], assets: [], entryPoint: path,
    provenance: { sourceType: 'stdin', locator: '<fixture>' },
  };
}

test('dependency policy is explicit and refuses network, builtin, and unallowlisted packages', () => {
  const report = inspectPreviewDependencies(envelope("import React from 'react'; import x from 'left-pad'; import fs from 'node:fs'; import './local.css';\n"));
  assert.deepEqual(PREVIEW_DEPENDENCY_ALLOWLIST, ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime']);
  assert.equal(report.allowed, false);
  assert.deepEqual(report.dependencies, ['left-pad', 'react']);
  assert.equal(report.findings.find((finding) => finding.specifier === './local.css').allowed, true);
  assert.equal(report.findings.find((finding) => finding.specifier === 'node:fs').kind, 'builtin');
});

test('preparation writes canonical bytes in a disposable root and executes no package scripts', async () => {
  const marker = join(await mkdtemp(join(tmpdir(), 'blockbase-preview-fixture-')), 'executed');
  const source = envelope(`import 'react';\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'bad');\n`);
  const result = await preparePreview(source);
  assert.equal(result.status, 'refused');
  assert.equal(result.refusal.code, 'dependency-not-allowlisted');
  await assert.rejects(() => lstat(marker));
});

test('path traversal and root symlink escapes fail closed without touching the target', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'blockbase-preview-outside-'));
  const rootParent = await mkdtemp(join(tmpdir(), 'blockbase-preview-root-'));
  const link = join(rootParent, 'link');
  await symlink(outside, link);
  const result = await preparePreview(envelope('export default 1;'), { rootPath: link });
  assert.equal(result.status, 'refused');
  assert.equal(result.refusal.code, 'symlink-escape');
  await assert.rejects(() => lstat(join(outside, 'Component.tsx')));
  const traversal = await preparePreview(envelope('export default 1;', '../escape.tsx'));
  assert.equal(traversal.status, 'refused');
  assert.ok(['invalid-request', 'path-escape'].includes(traversal.refusal.code));
});

test('session serves a sandboxed iframe with restrictive CSP and removes its temporary root', async () => {
  const session = await startPreviewSession({ source: envelope('export default 1;'), renderedHtml: '<!doctype html><html><body>fixture</body></html>' });
  assert.equal(session.status, 'running');
  assert.match(session.url, /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/$/);
  assert.equal(session.url.includes('..'), false);
  const document = await (await fetch(session.url)).text();
  assert.match(document, /sandbox="allow-scripts"/);
  assert.doesNotMatch(document, /allow-same-origin|allow-popups|allow-top-navigation/);
  assert.match(document, /connect-src &#39;none&#39;|connect-src 'none'/);
  assert.match(PREVIEW_CSP, /connect-src 'none'/);
  assert.equal(PREVIEW_IFRAME_SANDBOX, 'allow-scripts');
  const root = session.rootPath;
  const closed = await session.close();
  assert.equal(closed.status, 'stopped');
  await assert.rejects(() => lstat(root));
});

test('non-allowlisted build commands and timeout return typed refusal JSON', async () => {
  const unsupported = await startPreviewSession({ source: envelope('export default 1;'), build: { command: 'npm', args: ['run', 'build'] } });
  assert.equal(unsupported.status, 'refused');
  assert.equal(unsupported.refusal.code, 'unsupported-build-plugin');
  const timeout = await startPreviewSession({ source: envelope('export default 1;'), build: { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 1000)'] }, timeoutMs: 20 }, { allowedBuildCommands: [dirname(process.execPath), 'node'] });
  assert.equal(timeout.status, 'refused');
  assert.equal(timeout.refusal.code, 'timeout');
});

test('trusted UI source remains independent of catalog component packages', async () => {
  const root = resolve(import.meta.dirname, '../../../apps/preview/src');
  for (const name of [
    'server/index.ts', 'server/vite-plugin-blockbase-catalog.ts', 'App.tsx',
    'render/GenericBlock.tsx', 'library/api.ts', 'library/types.ts', 'library/useLibrary.ts',
  ]) {
    const source = await readFile(join(root, name), 'utf8');
    assert.doesNotMatch(source, /(?:cards\/course-design-cards|inputs\/filter-token-bar|preview\/src\/registry|legacy-catalog|registry\.tsx)/);
  }
});
