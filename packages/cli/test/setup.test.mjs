import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const executable = resolve(import.meta.dirname, '../dist/index.js');

function invoke(args, env = {}) {
  const result = spawnSync(process.execPath, [executable, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { ...result, json: result.stdout.trim() ? JSON.parse(result.stdout) : null };
}

async function scratch() {
  const base = await mkdtemp(join(tmpdir(), 'blockbase-setup-'));
  return { base, root: join(base, 'blocks') };
}

test('setup creates a catalog once and is idempotent', async () => {
  const { root } = await scratch();
  const first = invoke(['setup', '--no-service', '--json'], { BLOCKBASE_HOME: root });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.json.operation, 'setup');
  assert.equal(first.json.data.schemaVersion, '1');
  assert.equal(first.json.data.catalog, 'created');
  assert.equal(first.json.data.service, 'skipped');
  assert.equal(first.json.data.catalogRoot, root);
  assert.equal(first.json.data.url, 'http://127.0.0.1:47821/#home');
  assert.deepEqual(first.json.data.issues, []);
  assert.ok(existsSync(join(root, 'index.sqlite')));
  assert.ok(existsSync(join(root, 'components')));
  const second = invoke(['setup', '--no-service', '--json'], { BLOCKBASE_HOME: root });
  assert.equal(second.status, 0);
  assert.equal(second.json.data.catalog, 'present');
});

test('setup honors --catalog over BLOCKBASE_HOME', async () => {
  const { base, root } = await scratch();
  const other = join(base, 'other');
  const result = invoke(['setup', '--no-service', '--catalog', other, '--json'], { BLOCKBASE_HOME: root });
  assert.equal(result.status, 0);
  assert.equal(result.json.data.catalogRoot, other);
  assert.equal(existsSync(root), false);
});

test('setup reports a legacy catalog and writes nothing', async () => {
  const { root } = await scratch();
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'catalog.yaml'), 'version: 1\n');
  const result = invoke(['setup', '--no-service', '--json'], { BLOCKBASE_HOME: root });
  assert.equal(result.status, 0);
  assert.equal(result.json.data.catalog, 'legacy');
  assert.equal(result.json.data.issues[0].code, 'catalog-legacy');
  assert.equal(result.json.data.issues[0].repair, 'blockbase catalog migrate --json');
  assert.deepEqual(await readdir(root), ['catalog.yaml']);
});

test('setup refuses a directory with unmanaged content and never writes', async () => {
  const { root } = await scratch();
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'notes.txt'), 'mine\n');
  const result = invoke(['setup', '--no-service', '--json'], { BLOCKBASE_HOME: root });
  assert.equal(result.status, 5);
  assert.equal(result.json.error.code, 'SETUP_CATALOG_CONFLICT');
  assert.deepEqual(await readdir(root), ['notes.txt']);
  assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'mine\n');
});

test('setup tolerates .DS_Store, inbox, and an existing components directory', async () => {
  const { root } = await scratch();
  await mkdir(join(root, 'components'), { recursive: true });
  await mkdir(join(root, 'inbox'), { recursive: true });
  await writeFile(join(root, '.DS_Store'), '');
  const result = invoke(['setup', '--no-service', '--json'], { BLOCKBASE_HOME: root });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.data.catalog, 'created');
  assert.ok(existsSync(join(root, 'index.sqlite')));
});

test('setup refuses a components directory that holds no Blockbase components', async () => {
  const { root } = await scratch();
  await mkdir(join(root, 'components', 'Button'), { recursive: true });
  await writeFile(join(root, 'components', 'Button', 'Button.tsx'), 'export {}\n');
  const result = invoke(['setup', '--no-service', '--json'], { BLOCKBASE_HOME: root });
  assert.equal(result.status, 5);
  assert.equal(result.json.error.code, 'SETUP_CATALOG_CONFLICT');
  assert.deepEqual(await readdir(root), ['components']);
});

test('setup rejects flags that do not belong to it', () => {
  assert.equal(invoke(['setup', '--no-setup', '--json']).status, 2);
  assert.equal(invoke(['doctor', '--no-service', '--json']).status, 2);
  assert.equal(invoke(['doctor', '--port', '5000', '--json']).status, 2);
  assert.equal(invoke(['setup', '--port', 'abc', '--json']).status, 2);
});
