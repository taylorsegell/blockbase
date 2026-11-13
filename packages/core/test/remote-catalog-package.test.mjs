import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import test from 'node:test';
import { parseRemoteComponentPackage } from '@blockbase/contracts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createRemoteCatalogClient, REMOTE_CATALOG_ERROR_CODES, RemoteCatalogError } from '../dist/index.js';

const TEST_TOKEN = 'core-remote-package-test-fixture-token-not-a-real-secret';

async function fixturePackage() {
  return JSON.parse(await readFile(new URL('../../contracts/fixtures/v1/remote-component-package.json', import.meta.url), 'utf8'));
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

/** A single-tool fake MCP peer: only `get_component_package`, driven by `respond(input)`. */
async function startFakePackageServer(respond, token = TEST_TOKEN) {
  const transports = new Map();

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
    const server = new McpServer({ name: 'fake-blockbase-package', version: '0.0.0' });
    server.registerTool('get_component_package', {
      description: 'fake', inputSchema: { id: z.string(), revision: z.string().optional(), catalog_root: z.string().optional() },
    }, async (input) => respond(input));
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
        if (new URL(req.url ?? '/', 'http://internal.invalid').pathname !== '/mcp') { res.writeHead(404).end(); return; }
        if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401, { 'www-authenticate': 'Bearer error="invalid_token"' }).end('{}'); return; }
        await handleMcpRequest(req, res);
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    })();
  });
  await new Promise((resolvePromise, rejectPromise) => {
    httpServer.once('error', rejectPromise);
    httpServer.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = httpServer.address();
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      await Promise.all(Array.from(transports.values()).map((transport) => transport.close().catch(() => undefined)));
      transports.clear();
      await new Promise((resolvePromise, rejectPromise) => httpServer.close((error) => (error ? rejectPromise(error) : resolvePromise())));
    },
  };
}

function toolSuccess(value) {
  return { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] };
}

test('getPackage returns the exact task-5.1-verified RemoteComponentPackage for a well-formed server response', async (t) => {
  const fixture = await fixturePackage();
  const handle = await startFakePackageServer(async () => toolSuccess(fixture));
  t.after(() => handle.close());
  const client = createRemoteCatalogClient({ url: handle.url, token: TEST_TOKEN, timeoutMs: 5000 });
  t.after(() => client.close());

  const got = await client.getPackage(fixture.componentId);
  const expected = parseRemoteComponentPackage(fixture);
  assert.deepEqual(got, expected);
  assert.equal(got.files[0].path, 'Card.tsx');
  assert.equal(got.assets[0].path, 'icons/star.svg');
});

test('getPackage rejects a response whose declared content hash does not match its content (tampered in transit)', async (t) => {
  const fixture = await fixturePackage();
  const tampered = structuredClone(fixture);
  // Mutate the file's bytes without updating its declared hash — exactly the "tampered or
  // corrupted remote component package" scenario task 5.1's parser exists to catch.
  tampered.files[0].content = `${tampered.files[0].content}// tampered\n`;
  const handle = await startFakePackageServer(async () => toolSuccess(tampered));
  t.after(() => handle.close());
  const client = createRemoteCatalogClient({ url: handle.url, token: TEST_TOKEN, timeoutMs: 5000 });
  t.after(() => client.close());

  await assert.rejects(() => client.getPackage(fixture.componentId), (error) => {
    assert.ok(error instanceof RemoteCatalogError);
    assert.equal(error.code, REMOTE_CATALOG_ERROR_CODES.integrityInvalid);
    assert.ok(Array.isArray(error.details.issues) && error.details.issues.some((issue) => issue.path.includes('files[0]')));
    return true;
  });
});

test('getPackage rejects a response carrying a path-traversal file path, even though the tool call itself succeeded', async (t) => {
  const fixture = await fixturePackage();
  const malicious = structuredClone(fixture);
  malicious.files[0].path = '../../etc/passwd';
  const handle = await startFakePackageServer(async () => toolSuccess(malicious));
  t.after(() => handle.close());
  const client = createRemoteCatalogClient({ url: handle.url, token: TEST_TOKEN, timeoutMs: 5000 });
  t.after(() => client.close());

  await assert.rejects(() => client.getPackage(fixture.componentId), (error) => {
    assert.ok(error instanceof RemoteCatalogError);
    assert.equal(error.code, REMOTE_CATALOG_ERROR_CODES.integrityInvalid);
    return true;
  });
});

test('getPackage forwards an explicit revision argument and never a catalog_root', async (t) => {
  const fixture = await fixturePackage();
  let receivedInput;
  const handle = await startFakePackageServer(async (input) => { receivedInput = input; return toolSuccess(fixture); });
  t.after(() => handle.close());
  const client = createRemoteCatalogClient({ url: handle.url, token: TEST_TOKEN, timeoutMs: 5000 });
  t.after(() => client.close());

  await client.getPackage(fixture.componentId, fixture.revisionId);
  assert.equal(receivedInput.id, fixture.componentId);
  assert.equal(receivedInput.revision, fixture.revisionId);
  assert.ok(!('catalog_root' in receivedInput));
});
