import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = resolve(packageRoot, 'dist/index.js');

// Clearly-fake fixture token for tests that need HTTP transport to actually authenticate — this
// is never a real secret. `startHttpServer` reads it via BLOCKBASE_MCP_TOKEN (see
// packages/mcp/src/server.ts); the CLI itself forwards no `token` option, so the env var is the
// only path a spawned `blockbase mcp --transport http` process has to learn it.
const HTTP_TEST_TOKEN = 'cli-mcp-test-fixture-token-not-a-real-secret';

// NB: callers must read `.stdout`/`.stderr` off the returned object directly (never destructure
// it with a rest spread) — these are live getters over data captured as it arrives, and a rest
// spread would snapshot them at call time, before the child has written anything.
//
// `envOverrides` is merged onto the inherited environment; a value of `undefined` deletes that
// key entirely (used to prove a variable is genuinely absent, not just falsy).
function spawnCli(args, envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[key];
  }
  const child = spawn(process.execPath, [executable, ...args], { cwd: packageRoot, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return { child, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

async function waitFor(getValue, predicate, description, timeoutMs = 10_000) {
  const start = Date.now();
  while (!predicate(getValue())) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${description}. Last value: ${JSON.stringify(getValue())}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  return getValue();
}

/** Sends one newline-delimited JSON-RPC message over stdio, matching the pinned SDK's framing. */
function sendStdioMessage(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

/** Parses the JSON-RPC response for `id` out of newline-delimited stdout content. */
function readStdioResponse(stdout, id) {
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line);
    if (parsed.id === id) return parsed;
  }
  return undefined;
}

/** POSTs one JSON-RPC message to a streamable-HTTP MCP endpoint and parses its single SSE data event. */
function postJsonRpc(url, body, extraHeaders = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const target = new URL(url);
    const payload = JSON.stringify(body);
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(payload),
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolvePromise({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', rejectPromise);
    req.write(payload);
    req.end();
  });
}

function parseSseJsonRpc(body) {
  for (const event of body.split('\n\n')) {
    const dataLine = event.split('\n').find((line) => line.startsWith('data:'));
    if (dataLine) return JSON.parse(dataLine.slice('data:'.length).trim());
  }
  throw new Error(`No JSON-RPC data event found in SSE body: ${body}`);
}

test('blockbase mcp with no transport flag starts stdio exactly as before, with no BLOCKBASE_MCP_TOKEN required', async () => {
  // Stdio must never require or read a token: prove it by explicitly removing the variable
  // from the spawned process's environment (rather than merely not setting it, which would
  // leave the assertion dependent on whatever happens to be in the ambient shell env).
  const session = spawnCli(['mcp'], { BLOCKBASE_MCP_TOKEN: undefined });
  const { child } = session;
  try {
    sendStdioMessage(child, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'blockbase-cli-test', version: '0.1.0' } },
    });
    await waitFor(() => session.stdout, (stdout) => readStdioResponse(stdout, 1) !== undefined, 'stdio initialize response');
    const initResponse = readStdioResponse(session.stdout, 1);
    assert.equal(initResponse.result.serverInfo.name, 'blockbase');
    assert.equal(session.stderr, '', 'stdio mode must not write anything to stderr on a clean start');

    sendStdioMessage(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
    sendStdioMessage(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await waitFor(() => session.stdout, (stdout) => readStdioResponse(stdout, 2) !== undefined, 'stdio tools/list response');
    const listResponse = readStdioResponse(session.stdout, 2);
    assert.deepEqual(
      listResponse.result.tools.map((tool) => tool.name).sort(),
      ['get_component', 'get_component_package', 'inspect_project', 'prepare_adaptation', 'search_components', 'validate_adaptation'],
    );
  } finally {
    child.stdin.end();
    await once(child, 'close');
  }
});

test('blockbase mcp --transport http starts the HTTP lifecycle and serves init/list-tools with stderr-only diagnostics', async () => {
  const session = spawnCli(['mcp', '--transport', 'http', '--host', '127.0.0.1', '--port', '0'], { BLOCKBASE_MCP_TOKEN: HTTP_TEST_TOKEN });
  const { child } = session;
  const authHeader = { authorization: `Bearer ${HTTP_TEST_TOKEN}` };
  try {
    await waitFor(() => session.stderr, (stderr) => /MCP HTTP server listening on (http:\/\/\S+)/.test(stderr), 'HTTP startup diagnostic');
    const [, url] = session.stderr.match(/MCP HTTP server listening on (http:\/\/\S+)/);
    assert.equal(session.stdout, '', 'HTTP startup must never write anything to stdout');

    // A request with no Authorization header must be rejected before any transport/session is
    // created — proven by the 401 carrying no mcp-session-id and by the followup authenticated
    // initialize below succeeding as the very first real session.
    const unauthenticated = await postJsonRpc(url, {
      jsonrpc: '2.0', id: 0, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'blockbase-cli-http-test-unauth', version: '0.1.0' } },
    });
    assert.equal(unauthenticated.status, 401, 'a request with no Authorization header must be rejected');
    assert.equal(unauthenticated.headers['www-authenticate'], 'Bearer error="invalid_request"');
    assert.equal(unauthenticated.headers['mcp-session-id'], undefined);
    assert.ok(!unauthenticated.body.includes(HTTP_TEST_TOKEN), 'a 401 body must never echo the token');

    const initResponse = await postJsonRpc(url, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'blockbase-cli-http-test', version: '0.1.0' } },
    }, authHeader);
    assert.equal(initResponse.status, 200);
    const sessionId = initResponse.headers['mcp-session-id'];
    assert.ok(sessionId, 'initialize response must carry a session id');
    const initResult = parseSseJsonRpc(initResponse.body);
    assert.equal(initResult.result.serverInfo.name, 'blockbase');

    const initializedResponse = await postJsonRpc(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': sessionId, ...authHeader });
    assert.equal(initializedResponse.status, 202);

    const listResponse = await postJsonRpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { 'mcp-session-id': sessionId, ...authHeader });
    assert.equal(listResponse.status, 200);
    const listResult = parseSseJsonRpc(listResponse.body);
    assert.deepEqual(
      listResult.result.tools.map((tool) => tool.name).sort(),
      ['get_component', 'get_component_package', 'inspect_project', 'prepare_adaptation', 'search_components', 'validate_adaptation'],
    );

    assert.equal(session.stdout, '', 'MCP traffic travels over the HTTP socket, never stdout');
    assert.ok(!session.stderr.includes(HTTP_TEST_TOKEN), 'the token must never appear in stderr diagnostics');

    child.kill('SIGTERM');
    const [code] = await once(child, 'close');
    assert.equal(code, 0, 'a real SIGTERM must release the socket and exit cleanly');
    await assert.rejects(postJsonRpc(url, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, authHeader), 'the socket must be released after shutdown');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

test('blockbase mcp --transport http refuses to start when BLOCKBASE_MCP_TOKEN is missing or empty, reusing the CLI\'s existing error-surfacing path', async () => {
  const missing = spawnCli(['mcp', '--transport', 'http', '--host', '127.0.0.1', '--port', '0'], { BLOCKBASE_MCP_TOKEN: undefined });
  const [missingCode] = await once(missing.child, 'close');
  assert.equal(missingCode, 2, 'a missing token must exit with the usage exit code, before listening');
  assert.equal(missing.stdout, '', 'no machine-readable stdout for a usage error');
  assert.match(missing.stderr, /Error \[INVALID_ARGUMENTS\]:.*BLOCKBASE_MCP_TOKEN/);
  assert.ok(!missing.stderr.includes('MCP HTTP server listening'), 'the server must never start listening without a token');
  assert.ok(missing.stderr.length < 4096, 'diagnostic must be bounded');

  const empty = spawnCli(['mcp', '--transport', 'http', '--host', '127.0.0.1', '--port', '0'], { BLOCKBASE_MCP_TOKEN: '' });
  const [emptyCode] = await once(empty.child, 'close');
  assert.equal(emptyCode, 2, 'an empty token must exit with the usage exit code, before listening');
  assert.match(empty.stderr, /Error \[INVALID_ARGUMENTS\]:.*BLOCKBASE_MCP_TOKEN/);
  assert.ok(!empty.stderr.includes('MCP HTTP server listening'), 'the server must never start listening with an empty token');
});

test('an invalid --transport value is rejected with a bounded diagnostic before anything starts', async () => {
  const session = spawnCli(['mcp', '--transport', 'carrier-pigeon']);
  const [code] = await once(session.child, 'close');
  assert.equal(code, 2, 'invalid arguments must exit with the usage exit code');
  assert.equal(session.stdout, '', 'no machine-readable stdout for a usage error');
  assert.match(session.stderr, /Error \[INVALID_ARGUMENTS\]:.*--transport/);
  assert.ok(session.stderr.length < 4096, 'diagnostic must be bounded');
});

test('missing host and port for --transport http fail before listening, reusing task 1.1 validation', async () => {
  const session = spawnCli(['mcp', '--transport', 'http']);
  const [code] = await once(session.child, 'close');
  assert.equal(code, 2, 'missing host/port must exit with the usage exit code');
  assert.equal(session.stdout, '', 'no machine-readable stdout for a usage error');
  assert.match(session.stderr, /Error \[INVALID_ARGUMENTS\]:.*host/);
  assert.ok(session.stderr.length < 4096, 'diagnostic must be bounded');
});

test('an out-of-range --port for --transport http fails before listening', async () => {
  const session = spawnCli(['mcp', '--transport', 'http', '--host', '127.0.0.1', '--port', '70000']);
  const [code] = await once(session.child, 'close');
  assert.equal(code, 2, 'an invalid port must exit with the usage exit code');
  assert.equal(session.stdout, '', 'no machine-readable stdout for a usage error');
  assert.match(session.stderr, /Error \[INVALID_ARGUMENTS\]:.*port/);
});
