import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { parseCliErrorEnvelope, parseCliSuccessEnvelope } from '@blockbase/contracts';

// Proves task 5.4's CLI remote-mode routing and diagnostics: `search`/`inspect`/`adapt`/`add`
// served from a real `blockbase mcp --transport http` server (no local catalog required), the
// `--catalog`/`BLOCKBASE_REMOTE_URL` mutual-exclusivity and missing-token guards, the
// local-host-only guard on maintenance commands, the remote failure taxonomy's mapping to stable
// exit codes, that a project path is never sent to the remote server, that `add --apply` still
// only ever writes to the local project, and that the bearer token never appears in any captured
// CLI output. Every remote scenario below drives the real `dist/index.js` binary as a subprocess
// against a real loopback HTTP MCP server (the same rigor `mcp.test.mjs` already uses for the
// server side of this boundary) — never a mock of the CLI itself.

const packageRoot = resolve(import.meta.dirname, '..');
const executable = resolve(packageRoot, 'dist/index.js');
const projectFixture = resolve(packageRoot, '../../tests/fixtures/destinations/fixture-a');

// Clearly-fake fixture tokens — never real secrets, chosen so a scan of test output is
// unambiguous about what it is checking for. Mirrors `packages/cli/test/mcp.test.mjs`.
const REMOTE_TOKEN = 'cli-remote-test-fixture-token-not-a-real-secret';
const REMOTE_WRONG_TOKEN = 'cli-remote-test-wrong-fixture-token-also-not-a-secret';

/** Every stdout/stderr string captured by `invoke` across the whole file, scanned once at the end for the token. */
const capturedOutputs = [];

/**
 * `envOverrides` is merged onto the inherited environment; a value of `undefined` deletes that
 * key entirely — used so a remote-mode invocation can positively prove `BLOCKBASE_HOME` is
 * genuinely absent, not just unset by coincidence in the ambient shell.
 */
function invoke(args, envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  for (const [key, value] of Object.entries(envOverrides)) if (value === undefined) delete env[key];
  const result = spawnSync(process.execPath, [executable, ...args], { cwd: packageRoot, env, encoding: 'utf8' });
  capturedOutputs.push(result.stdout ?? '', result.stderr ?? '');
  return { ...result, json: args.includes('--json') && result.stdout.trim() ? JSON.parse(result.stdout) : null };
}

/**
 * Same as `invoke`, but non-blocking. Required whenever this same test process also runs an
 * in-process HTTP server (the recording proxy below) that the spawned CLI must be able to reach
 * concurrently — `spawnSync` blocks this process's entire event loop until the child exits, which
 * would starve that in-process server of the ability to ever accept the child's connection.
 */
async function invokeAsync(args, envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  for (const [key, value] of Object.entries(envOverrides)) if (value === undefined) delete env[key];
  const child = spawn(process.execPath, [executable, ...args], { cwd: packageRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [status] = await once(child, 'close');
  capturedOutputs.push(stdout, stderr);
  return { status, stdout, stderr, json: args.includes('--json') && stdout.trim() ? JSON.parse(stdout) : null };
}

async function waitFor(getValue, predicate, description, timeoutMs = 10_000) {
  const start = Date.now();
  while (!predicate(getValue())) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${description}. Last value: ${JSON.stringify(getValue())}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  return getValue();
}

/** Spawns a real `blockbase mcp --transport http` server (M1/M2) over a real loopback socket, serving `catalogRoot`. */
async function startRemoteServer(catalogRoot, token) {
  const child = spawn(process.execPath, [executable, 'mcp', '--transport', 'http', '--host', '127.0.0.1', '--port', '0'], {
    cwd: packageRoot,
    env: { ...process.env, BLOCKBASE_MCP_TOKEN: token, BLOCKBASE_HOME: catalogRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await waitFor(() => stderr, (value) => /MCP HTTP server listening on (http:\/\/\S+)/.test(value), 'HTTP startup diagnostic');
  const [, url] = stderr.match(/MCP HTTP server listening on (http:\/\/\S+)/);
  return {
    url,
    async stop() {
      child.kill('SIGTERM');
      await once(child, 'close');
      capturedOutputs.push(stdout, stderr);
    },
  };
}

/**
 * A dumb passthrough reverse proxy in front of a real MCP HTTP server. It never implements or
 * simulates the MCP protocol itself — it only records each raw request body before forwarding it
 * unmodified to `upstreamUrl` — so it can act as a spy on exactly what bytes the CLI's remote
 * client put on the wire (task 5.3's "never a project path" invariant, checked at the CLI layer).
 */
async function startRecordingProxy(upstreamUrl) {
  const bodies = [];
  const httpServer = createHttpServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';
      // Only POST carries a request body worth recording; the client transport also opens a
      // standalone, indefinitely-long-lived GET (for server-pushed notifications) that must be
      // streamed straight through rather than buffered, or forwarding it would hang forever.
      let bodyText;
      if (method !== 'GET' && method !== 'HEAD') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        bodyText = Buffer.concat(chunks).toString('utf8');
        bodies.push(bodyText);
      }
      const forwardHeaders = { ...req.headers };
      delete forwardHeaders.host;
      delete forwardHeaders['content-length'];
      delete forwardHeaders.connection;
      const upstreamResponse = await fetch(upstreamUrl, { method, headers: forwardHeaders, body: bodyText });
      const outHeaders = {};
      upstreamResponse.headers.forEach((value, key) => {
        if (key !== 'content-length' && key !== 'content-encoding') outHeaders[key] = value;
      });
      res.writeHead(upstreamResponse.status, outHeaders);
      if (upstreamResponse.body) for await (const chunk of upstreamResponse.body) res.write(chunk);
      res.end();
    })().catch((error) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(String(error));
    });
  });
  // The client's standalone server-push GET never completes on its own; track live sockets so
  // `close()` can force them shut instead of waiting forever for that connection to end.
  const sockets = new Set();
  httpServer.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolvePromise, rejectPromise) => {
    httpServer.once('error', rejectPromise);
    httpServer.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = httpServer.address();
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    bodies,
    async close() {
      const closed = new Promise((resolvePromise, rejectPromise) => httpServer.close((error) => (error ? rejectPromise(error) : resolvePromise())));
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

async function freshProject() {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-cli-remote-project-'));
  await cp(projectFixture, root, { recursive: true });
  return root;
}

async function readdirRecursive(root) {
  const files = [];
  async function visit(directory) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push(relative(root, path).split(sep).join('/'));
    }
  }
  await visit(root);
  return files.sort();
}

/** Builds a real, rebuilt local catalog (via the CLI's own `import`/`catalog rebuild`) to serve remotely. */
async function buildRemoteCatalog(content = 'export function RemoteCard() { return <div className="bg-card p-4 text-foreground">Remote Card</div>; }\n') {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-cli-remote-catalog-'));
  const catalog = join(root, 'catalog');
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'index.tsx'), content);
  const imported = invoke(['import', source, '--catalog', catalog, '--namespace', 'tests', '--slug', 'remote-card', '--name', 'Remote Card', '--json']);
  assert.equal(imported.status, 0, `catalog fixture import failed: ${imported.stderr}`);
  const rebuilt = invoke(['catalog', 'rebuild', '--catalog', catalog, '--json']);
  assert.equal(rebuilt.status, 0, `catalog fixture rebuild failed: ${rebuilt.stderr}`);
  const revisionId = parseCliSuccessEnvelope(imported.json).data.revisionId;
  const componentId = parseCliSuccessEnvelope(imported.json).data.manifest.componentId;
  return { catalog, componentId, revisionId };
}

test('remote search and inspect are served with no local catalog configured (BLOCKBASE_HOME absent)', async () => {
  const { catalog, componentId } = await buildRemoteCatalog();
  const server = await startRemoteServer(catalog, REMOTE_TOKEN);
  try {
    const remoteEnv = { BLOCKBASE_REMOTE_URL: server.url, BLOCKBASE_MCP_TOKEN: REMOTE_TOKEN, BLOCKBASE_HOME: undefined };
    const search = invoke(['search', 'remote card', '--json'], remoteEnv);
    assert.equal(search.status, 0, search.stderr);
    assert.equal(search.stderr, '');
    const searchEnvelope = parseCliSuccessEnvelope(search.json);
    assert.equal(searchEnvelope.operation, 'search');
    assert.ok(searchEnvelope.data.results.some((result) => result.componentId === componentId));

    const inspect = invoke(['inspect', componentId, '--json'], remoteEnv);
    assert.equal(inspect.status, 0, inspect.stderr);
    const inspectEnvelope = parseCliSuccessEnvelope(inspect.json);
    assert.equal(inspectEnvelope.operation, 'inspect');
    assert.equal(inspectEnvelope.data.componentId, componentId);
  } finally {
    await server.stop();
  }
});

test('remote adapt stages locally with no destination writes, and add --apply writes only to the local project', async () => {
  const { catalog, componentId } = await buildRemoteCatalog();
  const server = await startRemoteServer(catalog, REMOTE_TOKEN);
  const project = await freshProject();
  try {
    const remoteEnv = { BLOCKBASE_REMOTE_URL: server.url, BLOCKBASE_MCP_TOKEN: REMOTE_TOKEN, BLOCKBASE_HOME: undefined };
    const before = await readdirRecursive(project);

    const adapt = invoke(['adapt', componentId, '--project', project, '--json'], remoteEnv);
    assert.equal(adapt.status, 0, adapt.stderr);
    const adaptEnvelope = parseCliSuccessEnvelope(adapt.json);
    assert.equal(adaptEnvelope.data.componentId, componentId);
    assert.ok(adaptEnvelope.data.files.length > 0);
    assert.deepEqual(await readdirRecursive(project), before, 'adapt must stage in-memory only; it must not write to the destination project');

    const add = invoke(['add', componentId, '--project', project, '--apply', '--json'], remoteEnv);
    assert.equal(add.status, 0, add.stderr);
    const addEnvelope = parseCliSuccessEnvelope(add.json);
    assert.equal(addEnvelope.data.applied, true);
    assert.ok(addEnvelope.data.bundle.files.length > 0);
    for (const file of addEnvelope.data.bundle.files) {
      assert.equal(await readFile(join(project, file.path), 'utf8'), file.content, `${file.path} must be written locally after --apply`);
    }
    assert.notDeepEqual(await readdirRecursive(project), before, 'apply must write real files to the local project');
  } finally {
    await server.stop();
  }
});

test('remote adapt and add never send a project path to the remote server', async () => {
  const { catalog, componentId } = await buildRemoteCatalog();
  const server = await startRemoteServer(catalog, REMOTE_TOKEN);
  const proxy = await startRecordingProxy(server.url);
  const project = await freshProject();
  try {
    const remoteEnv = { BLOCKBASE_REMOTE_URL: proxy.url, BLOCKBASE_MCP_TOKEN: REMOTE_TOKEN, BLOCKBASE_HOME: undefined };
    const adapt = await invokeAsync(['adapt', componentId, '--project', project, '--json'], remoteEnv);
    assert.equal(adapt.status, 0, adapt.stderr);
    const add = await invokeAsync(['add', componentId, '--project', project, '--apply', '--json'], remoteEnv);
    assert.equal(add.status, 0, add.stderr);

    assert.ok(proxy.bodies.some((body) => body.includes('"tools/call"')), 'the proxy must have observed real tool calls to inspect');
    for (const body of proxy.bodies) {
      assert.equal(body.includes('project_path'), false, 'no request body may carry a project_path field');
      assert.equal(body.includes(project), false, 'no request body may carry the local project path');
    }
  } finally {
    await proxy.close();
    await server.stop();
  }
});

test('a stale explicit --revision surfaced through the remote adaptation path keeps the existing bounded ADAPT_STALE_REVISION behavior', async () => {
  const { catalog, componentId, revisionId: staleRevision } = await buildRemoteCatalog();
  // Re-importing different content to the same namespace/slug bumps the component's current
  // revision (`revisionHash` is content-derived), leaving `staleRevision` (the first import) no
  // longer current.
  const sourceDir = join(catalog, '..', 'source');
  await writeFile(join(sourceDir, 'index.tsx'), 'export function RemoteCard() { return <div className="bg-card p-4 text-foreground">Remote Card v2</div>; }\n');
  const bumped = invoke(['import', sourceDir, '--catalog', catalog, '--namespace', 'tests', '--slug', 'remote-card', '--name', 'Remote Card', '--json']);
  assert.equal(bumped.status, 0, bumped.stderr);
  assert.notEqual(parseCliSuccessEnvelope(bumped.json).data.revisionId, staleRevision);
  const rebuilt = invoke(['catalog', 'rebuild', '--catalog', catalog, '--json']);
  assert.equal(rebuilt.status, 0, rebuilt.stderr);

  const server = await startRemoteServer(catalog, REMOTE_TOKEN);
  const project = await freshProject();
  try {
    const remoteEnv = { BLOCKBASE_REMOTE_URL: server.url, BLOCKBASE_MCP_TOKEN: REMOTE_TOKEN, BLOCKBASE_HOME: undefined };
    const stale = invoke(['adapt', componentId, '--project', project, '--revision', staleRevision, '--json'], remoteEnv);
    assert.equal(stale.status, 7, stale.stderr);
    const staleEnvelope = parseCliErrorEnvelope(stale.json);
    assert.equal(staleEnvelope.error.code, 'ADAPT_STALE_REVISION');
  } finally {
    await server.stop();
  }
});

test('--catalog and BLOCKBASE_REMOTE_URL are mutually exclusive, and a missing or empty token fails before any connection is attempted', () => {
  const conflict = invoke(['search', 'card', '--catalog', join(packageRoot, 'missing-catalog'), '--json'], { BLOCKBASE_REMOTE_URL: 'http://127.0.0.1:1/mcp' });
  assert.equal(conflict.status, 2);
  const conflictEnvelope = parseCliErrorEnvelope(conflict.json);
  assert.equal(conflictEnvelope.error.code, 'INVALID_ARGUMENTS');
  assert.match(conflictEnvelope.error.message, /mutually exclusive/);

  const start = Date.now();
  const missingToken = invoke(['search', 'card', '--json'], { BLOCKBASE_REMOTE_URL: 'http://127.0.0.1:1/mcp', BLOCKBASE_MCP_TOKEN: undefined });
  const elapsedMs = Date.now() - start;
  assert.equal(missingToken.status, 2);
  const tokenEnvelope = parseCliErrorEnvelope(missingToken.json);
  assert.equal(tokenEnvelope.error.code, 'INVALID_ARGUMENTS');
  assert.match(tokenEnvelope.error.message, /BLOCKBASE_MCP_TOKEN/);
  assert.ok(elapsedMs < 3000, 'a missing token must fail before attempting any connection, not after a connection timeout');

  const emptyToken = invoke(['search', 'card', '--json'], { BLOCKBASE_REMOTE_URL: 'http://127.0.0.1:1/mcp', BLOCKBASE_MCP_TOKEN: '' });
  assert.equal(emptyToken.status, 2);
  assert.match(parseCliErrorEnvelope(emptyToken.json).error.message, /BLOCKBASE_MCP_TOKEN/);
});

test('local-only catalog-host operations refuse to run when BLOCKBASE_REMOTE_URL is set, instead of silently ignoring it', async () => {
  const remoteEnv = { BLOCKBASE_REMOTE_URL: 'http://127.0.0.1:1/mcp' };
  for (const args of [['doctor', '--json'], ['catalog', 'locate', '--json'], ['catalog', 'validate', '--json'], ['catalog', 'rebuild', '--json'], ['catalog', 'migrate', '--catalog', 'x', '--target', 'y', '--dry-run', '--json']]) {
    const result = invoke(args, remoteEnv);
    assert.equal(result.status, 2, `${args.join(' ')} should refuse with a usage exit code`);
    const envelope = parseCliErrorEnvelope(result.json);
    assert.equal(envelope.error.code, 'INVALID_ARGUMENTS');
    assert.match(envelope.error.message, /local catalog-host operation/);
  }
  const root = await mkdtemp(join(tmpdir(), 'blockbase-cli-remote-import-'));
  await mkdir(join(root, 'source'));
  await writeFile(join(root, 'source', 'index.tsx'), 'export function X(){return null;}\n');
  const importResult = invoke(['import', join(root, 'source'), '--catalog', join(root, 'catalog'), '--json'], remoteEnv);
  assert.equal(importResult.status, 2);
  assert.match(parseCliErrorEnvelope(importResult.json).error.message, /local catalog-host operation/);
  assert.deepEqual(await readdir(root), ['source'], 'import must not run (no catalog directory created) when BLOCKBASE_REMOTE_URL is set');
});

test('remote unauthorized, not-found, and unavailable failures map to stable JSON errors, exit codes, and bounded recovery actions', async () => {
  const { catalog } = await buildRemoteCatalog();
  const server = await startRemoteServer(catalog, REMOTE_TOKEN);
  try {
    const unauthorized = invoke(['search', 'card', '--json'], { BLOCKBASE_REMOTE_URL: server.url, BLOCKBASE_MCP_TOKEN: REMOTE_WRONG_TOKEN, BLOCKBASE_HOME: undefined });
    assert.equal(unauthorized.status, 4);
    const unauthorizedEnvelope = parseCliErrorEnvelope(unauthorized.json);
    assert.equal(unauthorizedEnvelope.error.code, 'REMOTE_UNAUTHORIZED');
    assert.ok(unauthorizedEnvelope.recoveryActions.length > 0);

    const notFound = invoke(['inspect', 'cmp_test_does_not_exist', '--json'], { BLOCKBASE_REMOTE_URL: server.url, BLOCKBASE_MCP_TOKEN: REMOTE_TOKEN, BLOCKBASE_HOME: undefined });
    assert.equal(notFound.status, 3);
    const notFoundEnvelope = parseCliErrorEnvelope(notFound.json);
    assert.equal(notFoundEnvelope.error.code, 'REMOTE_NOT_FOUND');
    assert.ok(notFoundEnvelope.recoveryActions.length > 0);
  } finally {
    await server.stop();
  }

  const unavailable = invoke(['search', 'card', '--json'], { BLOCKBASE_REMOTE_URL: 'http://127.0.0.1:1/mcp', BLOCKBASE_MCP_TOKEN: REMOTE_TOKEN, BLOCKBASE_HOME: undefined });
  assert.equal(unavailable.status, 10);
  const unavailableEnvelope = parseCliErrorEnvelope(unavailable.json);
  assert.equal(unavailableEnvelope.error.code, 'REMOTE_UNAVAILABLE');
  assert.ok(unavailableEnvelope.recoveryActions.length > 0);
});

test('the bearer token never appears in any CLI stdout/stderr captured across every remote-mode scenario above', () => {
  assert.ok(capturedOutputs.length > 0, 'the scan must have something to check');
  for (const text of capturedOutputs) {
    assert.equal(text.includes(REMOTE_TOKEN), false, 'REMOTE_TOKEN must never be echoed');
    assert.equal(text.includes(REMOTE_WRONG_TOKEN), false, 'REMOTE_WRONG_TOKEN must never be echoed');
  }
});
