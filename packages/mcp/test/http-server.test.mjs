import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer } from '../dist/server.js';
import { writeRevisionFixture } from './revision-fixture.mjs';

// Clearly-fake fixture tokens: never a real secret, chosen so it is obvious at a glance (and in
// any test-output redaction scan) that these strings cannot leak anything sensitive.
const TEST_TOKEN = 'mcp-http-test-fixture-token-not-a-real-secret';
// Same length as TEST_TOKEN but different content, so tests can exercise the timing-safe
// comparison's equal-length branch (not just the "different length" branch) without hardcoding
// a second token value by hand.
const WRONG_TOKEN_SAME_LENGTH = TEST_TOKEN.split('').reverse().join('');
const WRONG_TOKEN_DIFFERENT_LENGTH = 'short-wrong-token';

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`../../contracts/fixtures/v1/${name}`, import.meta.url), 'utf8'));
}

async function connectedClient(url, name = 'mcp-http-test-client', token = TEST_TOKEN) {
  const client = new Client({ name, version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function rawRequest(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const target = new URL(url);
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolvePromise({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', rejectPromise);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function authHeaders(token = TEST_TOKEN) {
  return { authorization: `Bearer ${token}` };
}

/**
 * Sends a raw HTTP/1.1 request over a bare socket, bypassing Node's `http.request` client
 * (which collapses duplicate `Authorization` header lines before they ever reach the wire).
 * Used only to prove the server's own duplicate-header detection, which reads
 * `req.rawHeaders` on the *receiving* side.
 */
function rawSocketRequest(url, extraHeaderLines) {
  return new Promise((resolvePromise, rejectPromise) => {
    const target = new URL(url);
    const socket = netConnect({ host: target.hostname, port: Number(target.port) }, () => {
      const requestLines = [
        `GET ${target.pathname} HTTP/1.1`,
        `Host: ${target.host}`,
        'Connection: close',
        ...extraHeaderLines,
        '',
        '',
      ];
      socket.write(requestLines.join('\r\n'));
    });
    let raw = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { raw += chunk; });
    socket.on('end', () => {
      const separatorIndex = raw.indexOf('\r\n\r\n');
      const head = separatorIndex === -1 ? raw : raw.slice(0, separatorIndex);
      const bodyText = separatorIndex === -1 ? '' : raw.slice(separatorIndex + 4);
      const [statusLine, ...headerLines] = head.split('\r\n');
      const status = Number(statusLine.split(' ')[1]);
      const headers = {};
      for (const line of headerLines) {
        const colonIndex = line.indexOf(':');
        if (colonIndex === -1) continue;
        const key = line.slice(0, colonIndex).trim().toLowerCase();
        const value = line.slice(colonIndex + 1).trim();
        headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
      }
      resolvePromise({ status, headers, body: bodyText });
    });
    socket.on('error', rejectPromise);
  });
}

test('HTTP server serves an init/list-tools/call-tool transcript at /mcp with the same structured results as stdio', async (t) => {
  const search = {
    schemaVersion: '1', query: 'card', catalogRevision: 'rev', results: [],
    selection: { status: 'miss', confidenceMargin: 0.12, margin: null }, recoveryActions: [],
  };
  const calls = [];
  const handle = await startHttpServer({
    host: '127.0.0.1',
    port: 0,
    token: TEST_TOKEN,
    services: {
      searchComponents: async (...args) => { calls.push(args); return search; },
    },
  });
  t.after(() => handle.close());

  assert.equal(new URL(handle.url).pathname, '/mcp');

  const client = await connectedClient(handle.url);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), [
    'search_components', 'get_component', 'get_component_package', 'inspect_project', 'prepare_adaptation', 'validate_adaptation',
  ]);

  const result = await client.callTool({ name: 'search_components', arguments: { query: 'card', catalog_root: '/catalog' } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, search);
  assert.deepEqual(JSON.parse(result.content[0].text), search);
  assert.deepEqual(calls, [['/catalog', 'card', {}]]);

  await client.close();
});

test('an authenticated HTTP client can call get_component_package end-to-end and gets back no server filesystem paths', async (t) => {
  const catalogRoot = await mkdtemp(join(tmpdir(), 'blockbase-mcp-http-package-'));
  const componentDir = join(catalogRoot, 'components', 'local', 'card');
  const { revisionId, revisionPath } = await writeRevisionFixture(componentDir, {
    files: [{ path: 'Card.tsx', content: 'export function Card() { return null; }\n' }],
    assets: [{ path: 'icons/star.svg', bytes: Buffer.from('<svg></svg>') }],
  });
  const manifest = { ...(await fixture('component-manifest.json')), currentRevision: revisionId };

  const handle = await startHttpServer({
    host: '127.0.0.1',
    port: 0,
    token: TEST_TOKEN,
    services: {
      inspectComponent: async () => ({
        schemaVersion: '1', componentId: manifest.componentId, revisionId, manifest, packagePath: componentDir, revisionPath,
        evidence: [], lookup: { input: manifest.componentId, matchedBy: 'id', exact: true },
      }),
    },
  });
  // Register the server-close hook before the temp-directory cleanup hook. `node:test` runs
  // `t.after` hooks in registration order, and closing the real HTTP socket first — before any
  // recursive `fs.rm` touches the filesystem threadpool — avoids a multi-second stall in
  // `httpServer.close()`'s keep-alive teardown that otherwise races with it (reproduced even
  // against an unrelated directory; not specific to this fixture's own files).
  t.after(() => handle.close());
  t.after(() => rm(catalogRoot, { recursive: true, force: true }));

  const client = await connectedClient(handle.url);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 6);

  const result = await client.callTool({ name: 'get_component_package', arguments: { id: manifest.componentId } });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.revisionId, revisionId);
  assert.deepEqual(result.structuredContent.files.map((file) => file.path), ['Card.tsx']);
  assert.deepEqual(result.structuredContent.assets.map((asset) => asset.path), ['icons/star.svg']);
  assert.ok(!result.content[0].text.includes(catalogRoot), 'the HTTP response text must never carry a server filesystem path');
  assert.ok(!result.content[0].text.includes(revisionPath));

  await client.close();
});

test('unsupported routes and methods return bounded JSON errors instead of crashing the server', async (t) => {
  const handle = await startHttpServer({ host: '127.0.0.1', port: 0, token: TEST_TOKEN });
  t.after(() => handle.close());

  const base = new URL(handle.url);
  // Wrong path and wrong method are both rejected before the auth check runs at all, so these
  // two requests deliberately carry no Authorization header.
  const wrongPath = await rawRequest(`http://${base.hostname}:${base.port}/not-mcp`, { method: 'POST' });
  assert.equal(wrongPath.status, 404);
  const wrongPathBody = JSON.parse(wrongPath.body);
  assert.equal(wrongPathBody.jsonrpc, '2.0');
  assert.ok(wrongPathBody.error.message.length < 4096);

  const wrongMethod = await rawRequest(handle.url, { method: 'PUT' });
  assert.equal(wrongMethod.status, 405);
  assert.ok(JSON.parse(wrongMethod.body).error);

  const badJson = await rawRequest(handle.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: '{not json',
  });
  assert.equal(badJson.status, 400);
  assert.ok(JSON.parse(badJson.body).error);

  const unknownSession = await rawRequest(handle.url, {
    method: 'GET',
    headers: { 'mcp-session-id': 'does-not-exist', accept: 'text/event-stream', ...authHeaders() },
  });
  assert.equal(unknownSession.status, 404);
  assert.ok(JSON.parse(unknownSession.body).error);

  // The server must still serve a fresh, valid request after all of the above.
  const client = await connectedClient(handle.url);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 6);
  await client.close();
});

test('concurrent MCP sessions over HTTP do not share client session state', async (t) => {
  const bundle = await fixture('adaptation-bundle.json');
  const validation = await fixture('validation-result.json');
  const handle = await startHttpServer({
    host: '127.0.0.1',
    port: 0,
    token: TEST_TOKEN,
    services: {
      prepareComponentAdaptation: async () => bundle,
      validateAdaptation: async () => validation,
    },
  });
  t.after(() => handle.close());

  const clientA = await connectedClient(handle.url, 'session-a');
  const clientB = await connectedClient(handle.url, 'session-b');

  const prepared = await clientA.callTool({
    name: 'prepare_adaptation',
    arguments: { id: bundle.componentId, project_path: bundle.projectPath, catalog_root: '/catalog' },
  });
  assert.equal(prepared.isError, undefined);
  assert.equal(prepared.structuredContent.bundleId, bundle.bundleId);

  // Session B never prepared this bundle, so its session-local bundle map must not
  // contain what session A stored — proving the two HTTP sessions are isolated.
  const validatedByB = await clientB.callTool({
    name: 'validate_adaptation',
    arguments: { bundle_id: bundle.bundleId, project_path: bundle.projectPath },
  });
  assert.equal(validatedByB.isError, true);
  assert.equal(validatedByB.structuredContent.error.code, 'VALIDATE_BUNDLE_NOT_FOUND');

  // Session A can validate its own prepared bundle by ID.
  const validatedByA = await clientA.callTool({
    name: 'validate_adaptation',
    arguments: { bundle_id: bundle.bundleId, project_path: bundle.projectPath },
  });
  assert.equal(validatedByA.isError, undefined);
  assert.equal(validatedByA.structuredContent.status, validation.status);

  await clientA.close();
  await clientB.close();
});

test('startHttpServer rejects invalid host/port before opening a socket', async () => {
  await assert.rejects(() => startHttpServer({ host: '', port: 4000, token: TEST_TOKEN }), RangeError);
  await assert.rejects(() => startHttpServer({ host: '127.0.0.1', port: -1, token: TEST_TOKEN }), RangeError);
  await assert.rejects(() => startHttpServer({ host: '127.0.0.1', port: 70000, token: TEST_TOKEN }), RangeError);
  await assert.rejects(() => startHttpServer({ host: '127.0.0.1', port: 1.5, token: TEST_TOKEN }), RangeError);
  await assert.rejects(() => startHttpServer({ host: '127.0.0.1', port: 4000, path: 'mcp', token: TEST_TOKEN }), RangeError);
});

test('close() closes active transports and releases the listening socket', async () => {
  const handle = await startHttpServer({ host: '127.0.0.1', port: 0, token: TEST_TOKEN });
  const client = await connectedClient(handle.url);
  await client.listTools();

  await handle.close();
  await client.close().catch(() => undefined);

  await assert.rejects(rawRequest(handle.url, { method: 'POST', headers: authHeaders() }));
  // Calling close() again must stay a no-op (idempotent).
  await handle.close();
});

test('SIGTERM triggers graceful shutdown that closes the socket', async () => {
  const handle = await startHttpServer({ host: '127.0.0.1', port: 0, token: TEST_TOKEN });
  const client = await connectedClient(handle.url);
  await client.listTools();

  process.emit('SIGTERM');
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));

  await assert.rejects(rawRequest(handle.url, { method: 'POST', headers: authHeaders() }));
  await client.close().catch(() => undefined);
});

test('HTTP mode refuses startup when BLOCKBASE_MCP_TOKEN is absent, empty, or whitespace-only', async () => {
  const savedEnvToken = process.env.BLOCKBASE_MCP_TOKEN;
  delete process.env.BLOCKBASE_MCP_TOKEN;
  try {
    // No `token` option and no env var: startHttpServer must reject before opening any socket.
    await assert.rejects(() => startHttpServer({ host: '127.0.0.1', port: 0 }), RangeError);
    // An explicit empty string is equally invalid...
    await assert.rejects(() => startHttpServer({ host: '127.0.0.1', port: 0, token: '' }), RangeError);
    // ...as is a whitespace-only value, and via the env-var fallback specifically.
    process.env.BLOCKBASE_MCP_TOKEN = '   ';
    await assert.rejects(() => startHttpServer({ host: '127.0.0.1', port: 0 }), RangeError);
  } finally {
    if (savedEnvToken === undefined) delete process.env.BLOCKBASE_MCP_TOKEN;
    else process.env.BLOCKBASE_MCP_TOKEN = savedEnvToken;
  }
});

test('bearer-token boundary: rejected requests never reach MCP transport/tool services, and only a valid token succeeds', async (t) => {
  const calls = [];
  const handle = await startHttpServer({
    host: '127.0.0.1',
    port: 0,
    token: TEST_TOKEN,
    services: {
      searchComponents: async (...args) => { calls.push(args); return { schemaVersion: '1', query: 'x', catalogRevision: 'rev', results: [], selection: { status: 'miss', confidenceMargin: 0, margin: null }, recoveryActions: [] }; },
    },
  });
  t.after(() => handle.close());

  const capturedBodies = [];
  const capturedWwwAuthenticate = [];
  const initializeRequestBody = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'unauthenticated-test-client', version: '0.1.0' } },
  });

  async function assertRejected(headers, expectedWwwAuthenticateError, label) {
    const response = await rawRequest(handle.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: initializeRequestBody,
    });
    assert.equal(response.status, 401, `${label} must return 401`);
    assert.equal(response.headers['www-authenticate'], `Bearer error="${expectedWwwAuthenticateError}"`, `${label} must carry a standard WWW-Authenticate header`);
    assert.equal(response.headers['mcp-session-id'], undefined, `${label} must never mint a session id — no transport/session was created`);
    assert.ok(response.body.length < 4096, `${label} response body must be bounded`);
    const parsedBody = JSON.parse(response.body);
    assert.equal(parsedBody.jsonrpc, '2.0');
    assert.equal(typeof parsedBody.error.message, 'string');
    capturedBodies.push(response.body);
    capturedWwwAuthenticate.push(response.headers['www-authenticate']);
  }

  // Missing Authorization header entirely.
  await assertRejected({}, 'invalid_request', 'missing header');

  // Malformed shapes: wrong scheme, empty bearer token, and a token with embedded whitespace.
  await assertRejected({ authorization: `Basic ${Buffer.from(`user:${TEST_TOKEN}`).toString('base64')}` }, 'invalid_request', 'wrong scheme');
  await assertRejected({ authorization: 'Bearer' }, 'invalid_request', 'bearer with no token');
  await assertRejected({ authorization: 'Bearer ' }, 'invalid_request', 'bearer with empty token');
  await assertRejected({ authorization: `Bearer ${TEST_TOKEN} extra` }, 'invalid_request', 'bearer token with embedded whitespace');
  await assertRejected({ authorization: `bearer ${TEST_TOKEN}` }, 'invalid_request', 'lowercase scheme');

  // Incorrect credentials, both shorter and the same length as the real token, proving the
  // timing-safe comparison handles a length mismatch without throwing or crashing the handler.
  await assertRejected({ authorization: `Bearer ${WRONG_TOKEN_DIFFERENT_LENGTH}` }, 'invalid_token', 'wrong token (different length)');
  await assertRejected({ authorization: `Bearer ${WRONG_TOKEN_SAME_LENGTH}` }, 'invalid_token', 'wrong token (same length)');

  // Duplicate Authorization headers, sent over a raw socket since Node's http client collapses
  // duplicates before they reach the wire.
  const duplicate = await rawSocketRequest(handle.url, [
    `Authorization: Bearer ${TEST_TOKEN}`,
    `Authorization: Bearer ${TEST_TOKEN}`,
  ]);
  assert.equal(duplicate.status, 401, 'duplicate Authorization headers must return 401');
  assert.equal(duplicate.headers['www-authenticate'], 'Bearer error="invalid_request"');
  assert.equal(duplicate.headers['mcp-session-id'], undefined);
  capturedBodies.push(duplicate.body);
  capturedWwwAuthenticate.push(duplicate.headers['www-authenticate']);

  // None of the above rejected requests may have reached MCP transport/session/tool code.
  assert.deepEqual(calls, [], 'no rejected request may invoke a tool service');

  // Redaction scan: the real fixture token must never appear in any captured 401 body or
  // WWW-Authenticate header, even though several of those requests carried it correctly and
  // one carried it twice.
  for (const body of capturedBodies) assert.ok(!body.includes(TEST_TOKEN), 'a 401 response body must never echo the token');
  for (const header of capturedWwwAuthenticate) assert.ok(!header.includes(TEST_TOKEN), 'WWW-Authenticate must never echo the token');

  // Only now does a valid, correctly-shaped, single Authorization header succeed — completing
  // MCP initialization and a real tool call, and only now does the service spy see a call.
  const client = await connectedClient(handle.url);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 6);
  const result = await client.callTool({ name: 'search_components', arguments: { query: 'x', catalog_root: '/catalog' } });
  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 1, 'the one authenticated call is the only call the spy ever saw');
  await client.close();
});
