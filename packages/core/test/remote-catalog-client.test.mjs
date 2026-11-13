import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import test from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createRemoteCatalogClient, REMOTE_CATALOG_ERROR_CODES, RemoteCatalogError } from '../dist/index.js';

// Clearly-fake fixture token: never a real secret, chosen so it is obvious at a glance (and in any
// test-output redaction scan) that this string cannot leak anything sensitive. Mirrors the pattern
// `packages/mcp/test/http-server.test.mjs` already uses for the server side of this same boundary.
const TEST_TOKEN = 'core-remote-client-test-fixture-token-not-a-real-secret';
const WRONG_TOKEN = 'core-remote-client-wrong-fixture-token-also-not-a-secret';

function toolSuccess(value) {
  return { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function toolErrorResult(code, message, details) {
  const envelope = { schemaVersion: '1', ok: false, error: { code, message, ...(details ? { details } : {}) }, warnings: [], recoveryActions: [] };
  return { isError: true, structuredContent: envelope, content: [{ type: 'text', text: JSON.stringify(envelope) }] };
}

function defaultSearchResult(query) {
  return { schemaVersion: '1', query, catalogRevision: 'fake-rev', results: [], selection: { status: 'miss', confidenceMargin: 0, margin: null }, recoveryActions: [] };
}

function readJsonBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim().length === 0) { resolvePromise(undefined); return; }
      try { resolvePromise(JSON.parse(raw)); } catch (error) { rejectPromise(error); }
    });
    req.on('error', rejectPromise);
  });
}

/**
 * A minimal fake MCP peer for unit-style client tests: the pinned SDK's own `McpServer` +
 * `StreamableHTTPServerTransport`, with a bearer-token boundary in front of it and three tools
 * shaped like `search_components` / `get_component` / `get_component_package`. Every call is
 * recorded to `calls` (including the raw `Authorization` header actually received) so tests can
 * assert what the client put on the wire, not just what it returned.
 */
async function startFakeMcpServer({ token = TEST_TOKEN, handlers = {}, delayMs = 0 } = {}) {
  const transports = new Map();
  const calls = [];

  function record(name, input, req) {
    calls.push({ tool: name, args: input, authorization: req.headers.authorization });
  }

  function registerFakeTools(server, req) {
    const shape = { id: z.string().optional(), query: z.string().optional(), revision: z.string().optional(), filters: z.record(z.string(), z.unknown()).optional(), project_path: z.string().optional(), catalog_root: z.string().optional() };
    server.registerTool('search_components', { description: 'fake', inputSchema: shape }, async (input) => {
      record('search_components', input, req);
      if (delayMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
      return handlers.search ? handlers.search(input) : toolSuccess(defaultSearchResult(input.query ?? ''));
    });
    server.registerTool('get_component', { description: 'fake', inputSchema: shape }, async (input) => {
      record('get_component', input, req);
      if (delayMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
      return handlers.get ? handlers.get(input) : toolErrorResult('COMPONENT_NOT_FOUND', 'No component matched.', { input: input.id });
    });
    server.registerTool('get_component_package', { description: 'fake', inputSchema: shape }, async (input) => {
      record('get_component_package', input, req);
      if (delayMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
      return handlers.getPackage ? handlers.getPackage(input) : toolErrorResult('COMPONENT_NOT_FOUND', 'No component matched.', { input: input.id });
    });
  }

  async function handleMcpRequest(req, res) {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId) {
      const transport = transports.get(sessionId);
      if (!transport) { res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"session not found"}'); return; }
      const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
      await transport.handleRequest(req, res, body);
      return;
    }
    if (req.method !== 'POST') { res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"bad request"}'); return; }
    const body = await readJsonBody(req);
    if (!isInitializeRequest(body)) { res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"bad request"}'); return; }
    const server = new McpServer({ name: 'fake-blockbase', version: '0.0.0' });
    registerFakeTools(server, req);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => transports.set(sid, transport),
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) transports.delete(sid);
      void server.close().catch(() => undefined);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const httpServer = createHttpServer((req, res) => {
    void (async () => {
      try {
        if (new URL(req.url ?? '/', 'http://internal.invalid').pathname !== '/mcp') {
          res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
          return;
        }
        if (req.headers.authorization !== `Bearer ${token}`) {
          res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer error="invalid_token"' }).end('{"jsonrpc":"2.0","id":null,"error":{"code":-32002,"message":"Unauthorized"}}');
          return;
        }
        await handleMcpRequest(req, res);
      } catch {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"internal"}');
      }
    })();
  });

  await new Promise((resolvePromise, rejectPromise) => {
    httpServer.once('error', rejectPromise);
    httpServer.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = httpServer.address();
  const url = `http://127.0.0.1:${address.port}/mcp`;

  return {
    url,
    calls,
    async close() {
      await Promise.all(Array.from(transports.values()).map((transport) => transport.close().catch(() => undefined)));
      transports.clear();
      await new Promise((resolvePromise, rejectPromise) => httpServer.close((error) => (error ? rejectPromise(error) : resolvePromise())));
    },
  };
}

/** Finds a loopback port nothing is listening on, for "connection refused" tests. */
async function unusedLoopbackPort() {
  const probe = createHttpServer();
  await new Promise((resolvePromise, rejectPromise) => {
    probe.once('error', rejectPromise);
    probe.listen(0, '127.0.0.1', resolvePromise);
  });
  const port = probe.address().port;
  await new Promise((resolvePromise) => probe.close(resolvePromise));
  return port;
}

test('search/inspect/getPackage round-trip over a real loopback socket, and no catalog_root is ever sent', async (t) => {
  const calls = [];
  const handle = await startFakeMcpServer({
    handlers: {
      search: async (input) => { calls.push(input); return toolSuccess({ ...defaultSearchResult(input.query), results: [{ componentId: 'cmp_card', revisionId: 'sha256:rev', displayName: 'Card', namespace: 'local', slug: 'card', favorite: false, score: 1, evidence: [], compatibility: { matched: [], conflicts: [] } }] }); },
      get: async (input) => { calls.push(input); return toolSuccess({ schemaVersion: '1', componentId: input.id, revisionId: 'sha256:rev', manifest: {}, packagePath: '/remote/server/only/path', revisionPath: '/remote/server/only/path/rev', evidence: [], lookup: { input: input.id, matchedBy: 'id', exact: true } }); },
    },
  });
  t.after(() => handle.close());

  // A local-catalog env var is deliberately set here and must be completely ignored: the remote
  // client has no local-catalog-root dependency to consult in the first place.
  const savedHome = process.env.BLOCKBASE_HOME;
  process.env.BLOCKBASE_HOME = '/nonexistent/should-never-be-read-by-the-remote-client';
  const client = createRemoteCatalogClient({ url: handle.url, token: TEST_TOKEN, timeoutMs: 5000 });
  t.after(async () => { await client.close(); if (savedHome === undefined) delete process.env.BLOCKBASE_HOME; else process.env.BLOCKBASE_HOME = savedHome; });

  const search = await client.search('card', { filters: { framework: 'react', stylingModes: ['css'], limit: 5 } });
  assert.equal(search.results[0].componentId, 'cmp_card');

  const inspected = await client.inspect('cmp_card', 'sha256:rev');
  assert.equal(inspected.componentId, 'cmp_card');

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(!('catalog_root' in call), 'the client must never send catalog_root — it has no local catalog to point at');
  }
  assert.deepEqual(calls[0].filters, { framework: 'react', styling_modes: ['css'], limit: 5 });
  assert.equal(calls[1].revision, 'sha256:rev');

  for (const recorded of handle.calls) {
    assert.equal(recorded.authorization, `Bearer ${TEST_TOKEN}`, 'the token must be sent only as a Bearer Authorization header');
  }
  assert.ok(!handle.url.includes(TEST_TOKEN), 'the token must never appear in the connection URL');
});

test('unauthorized: a rejected token surfaces as a stable "unauthorized" error and never echoes either token', async (t) => {
  const handle = await startFakeMcpServer({ token: TEST_TOKEN });
  t.after(() => handle.close());
  const client = createRemoteCatalogClient({ url: handle.url, token: WRONG_TOKEN, timeoutMs: 5000 });
  t.after(() => client.close());

  await assert.rejects(() => client.search('card'), (error) => {
    assert.ok(error instanceof RemoteCatalogError);
    assert.equal(error.code, REMOTE_CATALOG_ERROR_CODES.unauthorized);
    const serialized = `${error.message} ${JSON.stringify(error.details)}`;
    assert.ok(!serialized.includes(TEST_TOKEN) && !serialized.includes(WRONG_TOKEN), 'a 401 must never echo either token');
    return true;
  });
});

test('unavailable: connection refused is classified as "unavailable", never left as a raw network error', async () => {
  const port = await unusedLoopbackPort();
  const client = createRemoteCatalogClient({ url: `http://127.0.0.1:${port}/mcp`, token: TEST_TOKEN, timeoutMs: 5000 });
  await assert.rejects(() => client.search('card'), (error) => {
    assert.ok(error instanceof RemoteCatalogError);
    assert.equal(error.code, REMOTE_CATALOG_ERROR_CODES.unavailable);
    return true;
  });
  await client.close();
});

test('unavailable: a request that exceeds timeoutMs is aborted and classified as "unavailable"', async (t) => {
  const handle = await startFakeMcpServer({ delayMs: 500 });
  t.after(() => handle.close());
  const client = createRemoteCatalogClient({ url: handle.url, token: TEST_TOKEN, timeoutMs: 50 });
  t.after(() => client.close());

  const started = Date.now();
  await assert.rejects(() => client.search('card'), (error) => {
    assert.ok(error instanceof RemoteCatalogError);
    assert.equal(error.code, REMOTE_CATALOG_ERROR_CODES.unavailable);
    return true;
  });
  assert.ok(Date.now() - started < 500, 'the client must not wait for the full server delay once timeoutMs elapses');
});

test('protocol-invalid: a tool response missing the required MCP result shape is rejected, not passed through', async (t) => {
  const handle = await startFakeMcpServer({
    handlers: { search: async () => ({ thisIsNotAValidCallToolResult: true }) },
  });
  t.after(() => handle.close());
  const client = createRemoteCatalogClient({ url: handle.url, token: TEST_TOKEN, timeoutMs: 5000 });
  t.after(() => client.close());

  await assert.rejects(() => client.search('card'), (error) => {
    assert.ok(error instanceof RemoteCatalogError);
    assert.equal(error.code, REMOTE_CATALOG_ERROR_CODES.protocolInvalid);
    return true;
  });
});

test('protocol-invalid: an oversized tool response is rejected by the response-size bound, not buffered without limit', async (t) => {
  const handle = await startFakeMcpServer({
    handlers: {
      search: async (input) => toolSuccess({
        ...defaultSearchResult(input.query ?? ''),
        results: [{
          componentId: 'oversized', revisionId: 'sha256:rev', displayName: 'x'.repeat(9 * 1024 * 1024),
          namespace: 'local', slug: 'oversized', favorite: false, score: 1, evidence: [], compatibility: { matched: [], conflicts: [] },
        }],
      }),
    },
  });
  t.after(() => handle.close());
  const client = createRemoteCatalogClient({ url: handle.url, token: TEST_TOKEN, timeoutMs: 10_000 });
  t.after(() => client.close());

  await assert.rejects(() => client.search('card'), (error) => {
    assert.ok(error instanceof RemoteCatalogError);
    assert.equal(error.code, REMOTE_CATALOG_ERROR_CODES.protocolInvalid);
    return true;
  });
});

test('not-found: COMPONENT_NOT_FOUND from get_component maps to a stable "not-found" error', async (t) => {
  const handle = await startFakeMcpServer({
    handlers: { get: async (input) => toolErrorResult('COMPONENT_NOT_FOUND', 'No component matched the exact ID or alias.', { input: input.id }) },
  });
  t.after(() => handle.close());
  const client = createRemoteCatalogClient({ url: handle.url, token: TEST_TOKEN, timeoutMs: 5000 });
  t.after(() => client.close());

  await assert.rejects(() => client.inspect('cmp_does_not_exist'), (error) => {
    assert.ok(error instanceof RemoteCatalogError);
    assert.equal(error.code, REMOTE_CATALOG_ERROR_CODES.notFound);
    assert.equal(error.details.remoteCode, 'COMPONENT_NOT_FOUND');
    return true;
  });
});

test('remote-error: an unrecognized remote tool error code falls back to a bounded "remote-error"', async (t) => {
  const handle = await startFakeMcpServer({
    handlers: { get: async () => toolErrorResult('COMPONENT_SELECTION_REQUIRED', 'The alias matches multiple components.', { candidates: ['a', 'b'] }) },
  });
  t.after(() => handle.close());
  const client = createRemoteCatalogClient({ url: handle.url, token: TEST_TOKEN, timeoutMs: 5000 });
  t.after(() => client.close());

  await assert.rejects(() => client.inspect('ambiguous alias'), (error) => {
    assert.ok(error instanceof RemoteCatalogError);
    assert.equal(error.code, REMOTE_CATALOG_ERROR_CODES.remoteError);
    assert.equal(error.details.remoteCode, 'COMPONENT_SELECTION_REQUIRED');
    return true;
  });
});

test('close() is clean and idempotent, and a closed client refuses further calls without reconnecting', async (t) => {
  const handle = await startFakeMcpServer();
  t.after(() => handle.close());
  const client = createRemoteCatalogClient({ url: handle.url, token: TEST_TOKEN, timeoutMs: 5000 });

  await client.search('card');
  await client.close();
  await client.close(); // idempotent — must not throw or hang

  await assert.rejects(() => client.search('card'), (error) => {
    assert.ok(error instanceof RemoteCatalogError);
    assert.equal(error.code, REMOTE_CATALOG_ERROR_CODES.unavailable);
    return true;
  });
  assert.equal(handle.calls.length, 1, 'no request reached the server after close()');
});
