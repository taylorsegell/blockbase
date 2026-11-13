import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { IndexError } from '@blockbase/core';
import { parseRemoteComponentPackage } from '@blockbase/contracts';
import { createMcpServer } from '../dist/server.js';
import { writeRevisionFixture } from './revision-fixture.mjs';

async function fixtureManifest() {
  const raw = JSON.parse(await readFile(new URL('../../contracts/fixtures/v1/component-manifest.json', import.meta.url), 'utf8'));
  return raw;
}

async function connected(stubs = {}) {
  const server = createMcpServer({ services: stubs });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'mcp-remote-package-test-client', version: '0.1.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test('retrieves a real component revision with source files and assets, returning no server filesystem paths', async (t) => {
  const catalogRoot = await mkdtemp(join(tmpdir(), 'blockbase-mcp-package-'));
  t.after(() => rm(catalogRoot, { recursive: true, force: true }));
  const componentDir = join(catalogRoot, 'components', 'local', 'card');
  const { revisionId, revisionPath } = await writeRevisionFixture(componentDir, {
    files: [
      { path: 'Card.tsx', content: 'export function Card({ title }) {\n  return title;\n}\n' },
      { path: 'styles/card.css', content: '.card { padding: 1rem; }\n' },
    ],
    assets: [{ path: 'icons/star.svg', bytes: Buffer.from('<svg></svg>') }],
  });
  const manifest = { ...(await fixtureManifest()), currentRevision: revisionId };

  const { client, server } = await connected({
    inspectComponent: async () => ({
      schemaVersion: '1', componentId: manifest.componentId, revisionId, manifest, packagePath: componentDir, revisionPath,
      evidence: [], lookup: { input: manifest.componentId, matchedBy: 'id', exact: true },
    }),
  });

  const listed = await client.listTools();
  assert.equal(listed.tools.length, 6, 'exactly six tools are registered');
  assert.ok(listed.tools.some((tool) => tool.name === 'get_component_package'));

  const result = await client.callTool({ name: 'get_component_package', arguments: { id: manifest.componentId } });
  assert.equal(result.isError, undefined);
  const pkg = result.structuredContent;
  assert.equal(pkg.schemaVersion, '1');
  assert.equal(pkg.componentId, manifest.componentId);
  assert.equal(pkg.revisionId, revisionId);
  assert.equal(pkg.manifest.displayName, manifest.displayName);
  assert.deepEqual(pkg.files.map((file) => file.path).sort(), ['Card.tsx', 'styles/card.css']);
  assert.deepEqual(pkg.assets.map((asset) => asset.path), ['icons/star.svg']);
  assert.equal(pkg.assets[0].mediaType, 'application/octet-stream');
  assert.match(pkg.files[0].contentHash, /^sha256:[0-9a-f]{64}$/);

  // No server filesystem path (temp dir, component dir, or revision dir) may appear anywhere in
  // the tool's structured content or its serialized text form.
  const serialized = JSON.stringify(pkg);
  assert.ok(!serialized.includes(catalogRoot), 'the catalog root path must not appear in the response');
  assert.ok(!serialized.includes(revisionPath), 'the revision path must not appear in the response');
  assert.ok(!serialized.includes(componentDir), 'the component package path must not appear in the response');
  assert.ok(!result.content[0].text.includes(catalogRoot));
  assert.equal(Object.prototype.hasOwnProperty.call(pkg, 'packagePath'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(pkg, 'revisionPath'), false);

  // The tool's own output satisfies the published contract end-to-end.
  const reparsed = parseRemoteComponentPackage(pkg);
  assert.equal(reparsed.revisionId, revisionId);

  await client.close();
  await server.close();
});

test('reuses get_component\'s exact-ID-or-alias lookup semantics, including ambiguous and not-found errors', async () => {
  const ambiguous = new IndexError('COMPONENT_SELECTION_REQUIRED', 'The alias matches multiple components; choose an explicit component ID.', { input: 'card', candidates: ['a', 'b'] });
  const { client, server } = await connected({
    inspectComponent: async () => { throw ambiguous; },
  });
  const getComponent = await client.callTool({ name: 'get_component', arguments: { id: 'card' } });
  const getComponentPackage = await client.callTool({ name: 'get_component_package', arguments: { id: 'card' } });
  assert.equal(getComponent.isError, true);
  assert.equal(getComponentPackage.isError, true);
  assert.equal(getComponent.structuredContent.error.code, 'COMPONENT_SELECTION_REQUIRED');
  assert.equal(getComponentPackage.structuredContent.error.code, 'COMPONENT_SELECTION_REQUIRED');
  assert.deepEqual(getComponent.structuredContent.error.details, getComponentPackage.structuredContent.error.details);
  await client.close();
  await server.close();
});

test('a component that does not exist fails identically for get_component and get_component_package', async () => {
  const notFound = new IndexError('COMPONENT_NOT_FOUND', 'No component matched the exact ID or alias.', { input: 'ghost' });
  const { client, server } = await connected({ inspectComponent: async () => { throw notFound; } });
  const getComponent = await client.callTool({ name: 'get_component', arguments: { id: 'ghost' } });
  const getComponentPackage = await client.callTool({ name: 'get_component_package', arguments: { id: 'ghost' } });
  assert.equal(getComponent.structuredContent.error.code, 'COMPONENT_NOT_FOUND');
  assert.equal(getComponentPackage.structuredContent.error.code, 'COMPONENT_NOT_FOUND');
  await client.close();
  await server.close();
});

test('forwards catalog_root, id, and an optional immutable revision to inspectComponent exactly like get_component does', async () => {
  const calls = [];
  const manifest = await fixtureManifest();
  const { client, server } = await connected({
    inspectComponent: async (...args) => {
      calls.push(args);
      throw new IndexError('COMPONENT_NOT_FOUND', 'stub', {});
    },
  });
  await client.callTool({ name: 'get_component', arguments: { id: manifest.componentId, revision: 'sha256:old', catalog_root: '/catalog' } });
  await client.callTool({ name: 'get_component_package', arguments: { id: manifest.componentId, revision: 'sha256:old', catalog_root: '/catalog' } });
  assert.deepEqual(calls[0], ['/catalog', manifest.componentId, 'sha256:old']);
  assert.deepEqual(calls[1], ['/catalog', manifest.componentId, 'sha256:old']);
  await client.close();
  await server.close();
});

test('fails with a bounded integrity error when on-disk content no longer matches the immutable revision id', async (t) => {
  const catalogRoot = await mkdtemp(join(tmpdir(), 'blockbase-mcp-package-tamper-'));
  t.after(() => rm(catalogRoot, { recursive: true, force: true }));
  const componentDir = join(catalogRoot, 'components', 'local', 'card');
  const { revisionId, revisionPath } = await writeRevisionFixture(componentDir, {
    files: [{ path: 'Card.tsx', content: 'export function Card() { return null; }\n' }],
  });
  // Tamper with the committed file after the revision id was computed, simulating on-disk
  // corruption or an out-of-band edit to supposedly-immutable content.
  await writeFile(join(revisionPath, 'original', 'Card.tsx'), 'export function Card() { return "tampered"; }\n', 'utf8');
  const manifest = { ...(await fixtureManifest()), currentRevision: revisionId };

  const { client, server } = await connected({
    inspectComponent: async () => ({
      schemaVersion: '1', componentId: manifest.componentId, revisionId, manifest, packagePath: componentDir, revisionPath,
      evidence: [], lookup: { input: manifest.componentId, matchedBy: 'id', exact: true },
    }),
  });
  const result = await client.callTool({ name: 'get_component_package', arguments: { id: manifest.componentId } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'REMOTE_PACKAGE_INTEGRITY');
  assert.ok(!JSON.stringify(result.structuredContent).includes(revisionPath), 'an integrity error must not leak the revision path either');
  await client.close();
  await server.close();
});

test('fails with a bounded size error when a stored revision exceeds the documented decoded-size limit', async (t) => {
  const catalogRoot = await mkdtemp(join(tmpdir(), 'blockbase-mcp-package-oversize-'));
  t.after(() => rm(catalogRoot, { recursive: true, force: true }));
  const componentDir = join(catalogRoot, 'components', 'local', 'card');
  const oversized = 'x'.repeat(8 * 1024 * 1024 + 1);
  const { revisionId, revisionPath } = await writeRevisionFixture(componentDir, {
    files: [{ path: 'Card.tsx', content: oversized }],
  });
  const manifest = { ...(await fixtureManifest()), currentRevision: revisionId };

  const { client, server } = await connected({
    inspectComponent: async () => ({
      schemaVersion: '1', componentId: manifest.componentId, revisionId, manifest, packagePath: componentDir, revisionPath,
      evidence: [], lookup: { input: manifest.componentId, matchedBy: 'id', exact: true },
    }),
  });
  const result = await client.callTool({ name: 'get_component_package', arguments: { id: manifest.componentId } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'REMOTE_PACKAGE_TOO_LARGE');
  await client.close();
  await server.close();
});

test('the MCP tool surface adds exactly one new tool, and it is read-only (no import/add/apply/rebuild/migrate capability)', async () => {
  const { client, server } = await connected();
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'get_component', 'get_component_package', 'inspect_project', 'prepare_adaptation', 'search_components', 'validate_adaptation',
  ]);
  const writeLikeNamePattern = /import|migrate|rebuild|^add_|apply/i;
  const newTool = listed.tools.find((tool) => tool.name === 'get_component_package');
  assert.ok(!writeLikeNamePattern.test(newTool.name), 'get_component_package must not read as a write/import/apply/migrate/rebuild tool');
  await client.close();
  await server.close();
});
