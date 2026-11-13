import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/server.js';

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`../../contracts/fixtures/v1/${name}`, import.meta.url), 'utf8'));
}

async function connected(stubs = {}) {
  const server = createMcpServer({ services: stubs });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'mcp-test-client', version: '0.1.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test('lists the five bounded tools and delegates calls to core services', async () => {
  const calls = [];
  const search = {
    schemaVersion: '1', query: 'card', catalogRevision: 'rev', results: [],
    selection: { status: 'miss', confidenceMargin: 0.12, margin: null }, recoveryActions: [],
  };
  const { client, server } = await connected({
    searchComponents: async (...args) => { calls.push(['search', ...args]); return search; },
    inspectComponent: async (...args) => { calls.push(['inspect', ...args]); return { schemaVersion: '1', componentId: args[1], revisionId: 'rev', manifest: await fixture('component-manifest.json'), packagePath: '/catalog/card', revisionPath: '/catalog/card/revisions/rev', evidence: [], lookup: { input: args[1], matchedBy: 'id', exact: true } }; },
    inspectProject: async (...args) => { calls.push(['project', ...args]); return await fixture('project-profile.json'); },
  });

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), [
    'search_components', 'get_component', 'get_component_package', 'inspect_project', 'prepare_adaptation', 'validate_adaptation',
  ]);
  const result = await client.callTool({ name: 'search_components', arguments: { query: 'card', catalog_root: '/catalog' } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, search);
  assert.deepEqual(JSON.parse(result.content[0].text), search);
  const inspected = await client.callTool({ name: 'get_component', arguments: { id: 'cmp_card', catalog_root: '/catalog' } });
  assert.equal(inspected.structuredContent.componentId, 'cmp_card');
  assert.deepEqual(calls, [
    ['search', '/catalog', 'card', {}],
    ['inspect', '/catalog', 'cmp_card', undefined],
  ]);
  await client.close();
  await server.close();
});

test('preparing then validating an adaptation is session-bound and does not apply files', async () => {
  const bundle = await fixture('adaptation-bundle.json');
  const validation = await fixture('validation-result.json');
  const projectPath = await mkdtemp(join(tmpdir(), 'blockbase-mcp-project-'));
  bundle.projectPath = projectPath;
  const calls = [];
  const { client, server } = await connected({
    prepareComponentAdaptation: async (...args) => { calls.push(['prepare', ...args]); return bundle; },
    validateAdaptation: async (...args) => { calls.push(['validate', ...args]); return validation; },
  });
  const before = await readdir(bundle.projectPath);
  const prepared = await client.callTool({ name: 'prepare_adaptation', arguments: { id: bundle.componentId, project_path: bundle.projectPath, catalog_root: '/catalog' } });
  assert.equal(prepared.isError, undefined);
  assert.equal(prepared.structuredContent.bundleId, bundle.bundleId);
  const checked = await client.callTool({ name: 'validate_adaptation', arguments: { bundle_id: bundle.bundleId, project_path: bundle.projectPath } });
  assert.equal(checked.isError, undefined);
  assert.equal(checked.structuredContent.status, validation.status);
  assert.deepEqual(await readdir(bundle.projectPath), before);
  assert.equal(calls[0][0], 'prepare');
  assert.deepEqual(calls[0][1], bundle.componentId);
  assert.deepEqual(calls[0][2], { catalogRoot: '/catalog', projectPath: bundle.projectPath });
  assert.equal(calls[1][0], 'validate');
  assert.equal(calls[1][1].bundleId, bundle.bundleId);
  assert.deepEqual(calls[1][2], { projectPath: bundle.projectPath });
  await client.close();
  await server.close();
  await rm(projectPath, { recursive: true, force: true });
});

test('core failures become bounded structured tool errors', async () => {
  const { client, server } = await connected({
    searchComponents: async () => { throw Object.assign(new Error('catalog unavailable'), { code: 'INDEX_NOT_FOUND', details: { path: '/missing' } }); },
  });
  const result = await client.callTool({ name: 'search_components', arguments: { query: 'card', catalog_root: '/missing' } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.error.code, 'INTERNAL_ERROR');
  assert.match(result.content[0].text, /unexpectedly/);
  assert.ok(result.content[0].text.length < 4096);
  await client.close();
  await server.close();
});

test('server and transport close cleanly at session end', async () => {
  const { client, server } = await connected();
  await client.close();
  await server.close();
  assert.equal(server.server.transport, undefined);
});
