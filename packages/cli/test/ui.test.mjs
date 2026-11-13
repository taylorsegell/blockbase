import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const executable = resolve(import.meta.dirname, '../dist/index.js');

function invoke(args, env = {}) {
  const result = spawnSync(process.execPath, [executable, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { ...result, json: result.stdout.trim() ? JSON.parse(result.stdout) : null };
}

// The fake health servers live in this process, so status calls must not block its event loop.
async function invokeAsync(args, env = {}) {
  const child = spawn(process.execPath, [executable, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [status] = await once(child, 'close');
  return { status, stdout, stderr, json: stdout.trim() ? JSON.parse(stdout) : null };
}

async function listen(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: server.address().port, close: () => new Promise((done) => server.close(done)) };
}

async function isolatedHome() {
  const home = await mkdtemp(join(tmpdir(), 'blockbase-ui-home-'));
  return { HOME: home };
}

test('ui status treats a bare non-JSON 200 as not running', async () => {
  const fake = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html>spa fallback</html>');
  });
  try {
    const result = await invokeAsync(['ui', 'status', '--port', String(fake.port), '--json'], await isolatedHome());
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.operation, 'ui.status');
    assert.equal(result.json.data.running, false);
    assert.equal(result.json.data.url, `http://127.0.0.1:${fake.port}/#home`);
    assert.ok(result.json.data.service);
  } finally {
    await fake.close();
  }
});

test('ui status treats JSON without catalogRoot as not running and JSON with it as running', async () => {
  let body = { ok: true };
  const fake = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
  });
  try {
    const env = await isolatedHome();
    assert.equal((await invokeAsync(['ui', 'status', '--port', String(fake.port), '--json'], env)).json.data.running, false);
    body = { catalogRoot: '/tmp/catalog', count: 7 };
    const running = await invokeAsync(['ui', 'status', '--port', String(fake.port), '--json'], env);
    assert.equal(running.json.data.running, true);
    assert.equal(running.json.data.catalogRoot, '/tmp/catalog');
    assert.equal(running.json.data.count, 7);
  } finally {
    await fake.close();
  }
});

test('ui status reports not running when nothing listens', async () => {
  const fake = await listen(() => undefined);
  const port = fake.port;
  await fake.close();
  assert.equal((await invokeAsync(['ui', 'status', '--port', String(port), '--json'], await isolatedHome())).json.data.running, false);
});

test('ui validates its flags', () => {
  for (const port of ['abc', '0', '70000', '1.5']) {
    const result = invoke(['ui', '--port', port, '--json']);
    assert.equal(result.status, 2, `--port ${port}`);
    assert.equal(result.json.error.code, 'INVALID_ARGUMENTS');
  }
  assert.equal(invoke(['ui', '--port']).status, 2);
  assert.equal(invoke(['ui', 'bogus']).status, 2);
  assert.equal(invoke(['search', 'x', '--open']).status, 2);
});

test('ui fails with PREVIEW_NOT_BUILT when the preview server is absent', async () => {
  const catalog = await mkdtemp(join(tmpdir(), 'blockbase-ui-catalog-'));
  const result = invoke(['ui', '--catalog', catalog, '--json'], { BLOCKBASE_PREVIEW_ENTRY: join(catalog, 'missing', 'index.js') });
  assert.equal(result.status, 3);
  assert.equal(result.json.error.code, 'PREVIEW_NOT_BUILT');
  assert.equal(result.json.recoveryActions[0].command, 'pnpm build');
});

test('ui fails with CATALOG_NOT_FOUND for a missing catalog directory', async () => {
  const base = await mkdtemp(join(tmpdir(), 'blockbase-ui-missing-'));
  const result = invoke(['ui', '--json'], { BLOCKBASE_HOME: join(base, 'nope') });
  assert.equal(result.status, 3);
  assert.equal(result.json.error.code, 'CATALOG_NOT_FOUND');
});

test('ui starts the preview server for BLOCKBASE_HOME, reports it once, and stops on SIGTERM', async () => {
  const base = await mkdtemp(join(tmpdir(), 'blockbase-ui-stub-'));
  const optionsFile = join(base, 'options.json');
  const stub = join(base, 'stub-preview.mjs');
  await writeFile(stub, `import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
export async function startPreviewServer(options) {
  writeFileSync(${JSON.stringify(optionsFile)}, JSON.stringify(options));
  const server = createServer((_q, r) => r.end('ok'));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { url: 'x', port: server.address().port, catalogRoot: options.catalogRoot, close: () => new Promise((done) => server.close(done)) };
}
`);
  const child = spawn(process.execPath, [executable, 'ui', '--port', '48100', '--allowed-host', 'a.local', '--allowed-host', 'b.local', '--open', '--json'], {
    env: { ...process.env, BLOCKBASE_HOME: base, BLOCKBASE_PREVIEW_ENTRY: stub },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  const started = new Promise((resolveStart, rejectStart) => {
    const timer = setTimeout(() => rejectStart(new Error('ui did not start')), 10_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      try {
        const parsed = JSON.parse(stdout);
        clearTimeout(timer);
        resolveStart(parsed);
      } catch { /* wait for the full envelope */ }
    });
    child.once('error', rejectStart);
  });
  try {
    const envelope = await started;
    assert.equal(envelope.ok, true);
    assert.equal(envelope.operation, 'ui');
    assert.match(envelope.data.url, /^http:\/\/127\.0\.0\.1:\d+\/#home$/);
    assert.equal(envelope.data.catalogRoot, base);
    const options = JSON.parse(await readFile(optionsFile, 'utf8'));
    assert.deepEqual(options, { catalogRoot: base, port: 48100, host: '127.0.0.1', allowedHosts: ['a.local', 'b.local'], open: true });
  } finally {
    child.kill('SIGTERM');
  }
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
});

test('ui maps Vite strictPort failure to UI_PORT_IN_USE with exit 5', async () => {
  const base = await mkdtemp(join(tmpdir(), 'blockbase-ui-busy-'));
  const stub = join(base, 'stub-preview.mjs');
  // Vite's strictPort error is a plain Error with no code.
  await writeFile(stub, `export async function startPreviewServer(options) { throw new Error('Port ' + options.port + ' is already in use'); }\n`);
  const result = await invokeAsync(['ui', '--port', '48101', '--json'], { BLOCKBASE_HOME: base, BLOCKBASE_PREVIEW_ENTRY: stub });
  assert.equal(result.status, 5, result.stderr);
  assert.equal(result.json.error.code, 'UI_PORT_IN_USE');
});
