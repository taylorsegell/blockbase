import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { AdapterError, executeSourceAdapter, readAdapterManifest } from '../dist/index.js';

const manifest = { schemaVersion: '1', id: 'fixture', name: 'Fixture adapter', version: '1.0.0', capabilities: { network: 'none' } };
const request = { schemaVersion: '1', operation: 'acquire', locator: '/tmp/source' };
const envelope = { schemaVersion: '1', sourceType: 'adapter', files: [{ path: 'Card.tsx', content: 'export default 1;', contentHash: 'sha256:fixture' }], assets: [], provenance: { sourceType: 'adapter', locator: '/tmp/source', adapterId: 'fixture' } };

async function fixture(script) {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-adapter-'));
  const manifestPath = join(root, 'adapter.json');
  const scriptPath = join(root, 'adapter.mjs');
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(scriptPath, script);
  return { manifestPath, scriptPath, root };
}

test('adapter manifest and stdin/stdout execution are versioned and noise-free', async () => {
  const item = await fixture(`process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify(envelope))}));`);
  assert.deepEqual(await readAdapterManifest(item.manifestPath), manifest);
  const result = await executeSourceAdapter({ manifestPath: item.manifestPath, command: process.execPath, args: [item.scriptPath], request });
  assert.deepEqual(result.envelope, envelope);
  assert.deepEqual(result.adapter, { id: 'fixture', version: '1.0.0' });
  assert.equal(result.network, 'none');
});

test('network, path, version, malformed output, nonzero exit, and timeout refuse stably', async () => {
  const item = await fixture('process.stdin.resume(); process.stdin.on(\'end\', () => process.stdout.write(\'not json\'));');
  await assert.rejects(() => executeSourceAdapter({ manifestPath: item.manifestPath, command: process.execPath, args: [item.scriptPath], request: { ...request, fetch: true } }), (error) => error instanceof AdapterError && error.code === 'ADAPTER_NETWORK_DENIED');
  await assert.rejects(() => executeSourceAdapter({ manifestPath: item.manifestPath, command: process.execPath, args: [item.scriptPath], request: { ...request, allowRoot: '/tmp/allowed', locator: '/tmp/outside' } }), (error) => error.code === 'ADAPTER_PATH_ESCAPE');
  await assert.rejects(() => executeSourceAdapter({ manifestPath: item.manifestPath, command: process.execPath, args: [item.scriptPath], request: { ...request, schemaVersion: '2' } }), (error) => error.code === 'ADAPTER_INCOMPATIBLE_VERSION');
  await assert.rejects(() => executeSourceAdapter({ manifestPath: item.manifestPath, command: process.execPath, args: [item.scriptPath], request }), (error) => error.code === 'ADAPTER_MALFORMED_OUTPUT');
  const failing = await fixture('process.stdin.resume(); process.stdin.on(\'end\', () => process.exit(3));');
  await assert.rejects(() => executeSourceAdapter({ manifestPath: failing.manifestPath, command: process.execPath, args: [failing.scriptPath], request }), (error) => error.code === 'ADAPTER_EXIT_FAILED');
  const hanging = await fixture('setInterval(() => {}, 1000);');
  await assert.rejects(() => executeSourceAdapter({ manifestPath: hanging.manifestPath, command: process.execPath, args: [hanging.scriptPath], request, timeoutMs: 20 }), (error) => error.code === 'ADAPTER_TIMEOUT');
});
