import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { parseRemoteComponentPackage } from '@blockbase/contracts';
import {
  AdaptationError,
  RemoteCatalogSource,
  applyAdaptation,
  importEnvelope,
  prepareComponentAdaptation,
  rebuildIndex,
  sha256,
  validateAdaptation,
} from '../dist/index.js';

// Proves task 5.3's contract: adaptation sourced from an already-verified `RemoteComponentPackage`
// (via `RemoteCatalogSource`) behaves identically to adaptation sourced from a local catalog disk
// path (via `LocalCatalogSource`, used implicitly whenever `catalogRoot` is passed), for the same
// underlying revision and destination project — with the destination side (project inspection,
// existing-target reads, token mapping, staging, apply planning, writes, validation) never seeing
// or depending on the catalog source, and the remote surface never seeing a project path.
//
// `RemoteCatalogSource` is driven here through a fake `RemoteCatalogClient` (the same public shape
// `createRemoteCatalogClient` — task 5.2, already closed and independently tested against a real
// loopback MCP server — returns) rather than a real network round trip: task 5.2 already proves the
// wire protocol and integrity verification; this file's job is proving the *adaptation engine's*
// behavior once it holds an already-verified `RemoteComponentPackage`, which is exactly the
// boundary task 5.3 owns.

const projectFixture = resolve(import.meta.dirname, '../../../tests/fixtures/destinations/fixture-a');
const sourceContent = 'export function StaticCard() {\n  return <article className="rounded-lg bg-card p-4 text-foreground shadow-sm">Card</article>;\n}\n';

async function fixtureManifest() {
  return JSON.parse(await readFile(new URL('../../contracts/fixtures/v1/component-manifest.json', import.meta.url), 'utf8'));
}

async function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

async function freshProject() {
  const root = await tempDir('blockbase-remote-adapt-project-');
  await cp(projectFixture, root, { recursive: true });
  return root;
}

async function importStaticCard(catalogRoot) {
  const manifest = await fixtureManifest();
  Object.assign(manifest, { componentId: 'cmp_test_remote_static_card', namespace: 'test', slug: 'remote-static-card', displayName: 'Static Card' });
  return importEnvelope({
    schemaVersion: '1',
    sourceType: 'directory',
    files: [{ path: 'StaticCard.tsx', content: sourceContent, contentHash: sha256(sourceContent) }],
    assets: [],
    entryPoint: 'StaticCard.tsx',
    provenance: { sourceType: 'directory', locator: 'fixtures/static-tailwind' },
  }, { catalogRoot, manifest });
}

async function readRevisionFiles(revisionPath) {
  const root = join(revisionPath, 'original');
  const files = [];
  async function visit(directory) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push({ path: relative(root, path).split(sep).join('/'), content: await readFile(path, 'utf8') });
    }
  }
  await visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Builds a real, task-5.1-verified `RemoteComponentPackage` from a real imported catalog revision. */
async function buildRemotePackage(imported) {
  const files = (await readRevisionFiles(imported.revisionPath)).map((file) => ({ ...file, contentHash: sha256(file.content) }));
  return parseRemoteComponentPackage({
    schemaVersion: '1',
    componentId: imported.manifest.componentId,
    revisionId: imported.revisionId,
    manifest: imported.manifest,
    files,
    assets: [],
  });
}

/** A fake `RemoteCatalogClient` (task 5.2's public shape) that records every call for auditing. */
function fakeRemoteClient(getPackageFor, inspectManifestFor) {
  const calls = [];
  return {
    calls,
    async search(query, options) {
      calls.push(['search', query, options]);
      throw new Error('adaptation must never call search()');
    },
    async inspect(id, revision) {
      calls.push(['inspect', id, revision]);
      return { manifest: inspectManifestFor(id, revision) };
    },
    async getPackage(id, revision) {
      calls.push(['getPackage', id, revision]);
      return getPackageFor(id, revision);
    },
    async close() {
      calls.push(['close']);
    },
  };
}

/** No call recorded by a fake client ever carries a project path — only componentId/revision. */
function assertNeverSawProjectPath(calls, ...projectPaths) {
  for (const call of calls) {
    for (const arg of call) {
      if (typeof arg !== 'string') continue;
      for (const projectPath of projectPaths) assert.equal(arg.includes(projectPath), false, `call ${JSON.stringify(call)} leaked the project path ${projectPath}`);
    }
  }
}

test('local and remote catalog sources produce identical adaptation bundles for the same revision and project', async () => {
  const catalogRootDir = await tempDir('blockbase-remote-adapt-catalog-');
  const catalogRoot = join(catalogRootDir, 'catalog');
  const imported = await importStaticCard(catalogRoot);
  await rebuildIndex({ catalogRoot });
  const remotePackage = await buildRemotePackage(imported);
  const client = fakeRemoteClient(() => remotePackage, () => remotePackage.manifest);
  const remoteSource = new RemoteCatalogSource(client);

  // Same project path for both calls: prepare only ever reads from it, so two independent
  // prepares against the identical, unmodified directory are directly comparable.
  const projectPath = await freshProject();
  const localBundle = await prepareComponentAdaptation(imported.manifest.componentId, { catalogRoot, projectPath });
  const remoteBundle = await prepareComponentAdaptation(imported.manifest.componentId, { catalogSource: remoteSource, projectPath });

  // Full equivalence: nothing in the returned bundle distinguishes catalog source (by design —
  // the envelope's sourceType stays 'directory' regardless of origin, and bundle-level provenance
  // mirrors the *component's own* recorded provenance, not how this adaptation fetched it). There
  // is therefore no "local vs remote" fingerprint left to explicitly call out as different.
  assert.deepEqual(remoteBundle, localBundle);

  // The specific fields task 5.3's acceptance criteria name, asserted individually too so a future
  // change that reintroduces a difference fails with a precise, targeted diff:
  assert.deepEqual(remoteBundle.files, localBundle.files);
  assert.deepEqual(remoteBundle.tokenMappings, localBundle.tokenMappings);
  assert.deepEqual(remoteBundle.dependencyDelta, localBundle.dependencyDelta);
  assert.deepEqual(remoteBundle.residuals, localBundle.residuals);
  assert.deepEqual(remoteBundle.warnings, localBundle.warnings);
  assert.deepEqual(remoteBundle.validationCommands, localBundle.validationCommands);
  assert.ok(remoteBundle.tokenMappings.some((mapping) => mapping.confidence === 'high'));

  // The remote surface only ever saw componentId/revision-shaped calls — never search(), never the
  // project path in any argument.
  assert.equal(client.calls.some((call) => call[0] === 'search'), false);
  assert.deepEqual(client.calls, [['getPackage', imported.manifest.componentId, undefined]]);
  assertNeverSawProjectPath(client.calls, projectPath);

  await rm(catalogRootDir, { recursive: true, force: true });
  await rm(projectPath, { recursive: true, force: true });
});

test('apply and validate outputs match between local- and remote-sourced bundles', async () => {
  const catalogRootDir = await tempDir('blockbase-remote-adapt-catalog-');
  const catalogRoot = join(catalogRootDir, 'catalog');
  const imported = await importStaticCard(catalogRoot);
  await rebuildIndex({ catalogRoot });
  const remotePackage = await buildRemotePackage(imported);
  const client = fakeRemoteClient(() => remotePackage, () => remotePackage.manifest);
  const remoteSource = new RemoteCatalogSource(client);

  const localProject = await freshProject();
  const remoteProject = await freshProject();
  const localBundle = await prepareComponentAdaptation(imported.manifest.componentId, { catalogRoot, projectPath: localProject });
  const remoteBundle = await prepareComponentAdaptation(imported.manifest.componentId, { catalogSource: remoteSource, projectPath: remoteProject });

  const localValidation = await validateAdaptation(localBundle, { projectPath: localProject, timeoutMs: 10_000 });
  const remoteValidation = await validateAdaptation(remoteBundle, { projectPath: remoteProject, timeoutMs: 10_000 });
  assert.deepEqual(localValidation.commands.map((command) => [command.command, command.status]), remoteValidation.commands.map((command) => [command.command, command.status]));
  assert.equal(localValidation.status, remoteValidation.status);
  assert.deepEqual(localValidation.residuals, remoteValidation.residuals);
  assert.deepEqual(localValidation.warnings, remoteValidation.warnings);

  const localPlan = await applyAdaptation(localBundle, { catalogRoot });
  const remotePlan = await applyAdaptation(remoteBundle, { catalogSource: remoteSource });
  assert.deepEqual(localPlan.files, remotePlan.files);
  assert.deepEqual(localPlan.writes, remotePlan.writes);
  assert.deepEqual(localPlan.blocked, remotePlan.blocked);
  assert.equal(localPlan.revisionId, remotePlan.revisionId);

  for (const file of localBundle.files) {
    assert.equal(await readFile(join(localProject, file.path), 'utf8'), await readFile(join(remoteProject, file.path), 'utf8'));
  }

  assertNeverSawProjectPath(client.calls, localProject, remoteProject);

  await rm(catalogRootDir, { recursive: true, force: true });
  await rm(localProject, { recursive: true, force: true });
  await rm(remoteProject, { recursive: true, force: true });
});

test('a remote-sourced explicit revision that is no longer current is rejected as ADAPT_STALE_REVISION, mirroring local behavior', async () => {
  const manifest = await fixtureManifest();
  Object.assign(manifest, { componentId: 'cmp_test_remote_stale', namespace: 'test', slug: 'remote-stale', currentRevision: `sha256:${'b'.repeat(64)}` });
  const content = 'export function Stale() { return null; }\n';
  const requestedRevision = `sha256:${'a'.repeat(64)}`;
  // The server still resolves the requested (historical) revision's bytes — exactly like local
  // `inspectComponent` does for a historical revision — but its manifest reports a newer current
  // revision, the same signal `LocalCatalogSource`'s fresh on-disk re-read supplies locally.
  const remotePackage = parseRemoteComponentPackage({
    schemaVersion: '1', componentId: manifest.componentId, revisionId: requestedRevision, manifest,
    files: [{ path: 'Stale.tsx', content, contentHash: sha256(content) }], assets: [],
  });
  const client = fakeRemoteClient(() => remotePackage, () => remotePackage.manifest);
  const remoteSource = new RemoteCatalogSource(client);
  const projectPath = await freshProject();

  await assert.rejects(
    () => prepareComponentAdaptation(manifest.componentId, { catalogSource: remoteSource, projectPath, revision: requestedRevision }),
    (error) => error instanceof AdaptationError && error.code === 'ADAPT_STALE_REVISION' && error.details.requested === requestedRevision && error.details.current === manifest.currentRevision,
  );

  await rm(projectPath, { recursive: true, force: true });
});

test('destination-side errors (project conflicts, changed targets) fire identically for a remote-sourced bundle', async () => {
  const manifest = await fixtureManifest();
  Object.assign(manifest, { componentId: 'cmp_test_remote_destination', namespace: 'test', slug: 'remote-destination' });
  const content = 'export function Destination() { return null; }\n';
  const remotePackage = parseRemoteComponentPackage({
    schemaVersion: '1', componentId: manifest.componentId, revisionId: manifest.currentRevision, manifest,
    files: [{ path: 'Destination.tsx', content, contentHash: sha256(content) }], assets: [],
  });
  const client = fakeRemoteClient(() => remotePackage, () => remotePackage.manifest);
  const remoteSource = new RemoteCatalogSource(client);

  const conflictProject = await tempDir('blockbase-remote-adapt-conflict-');
  await mkdir(join(conflictProject, 'src', 'components'), { recursive: true });
  await writeFile(join(conflictProject, 'package.json'), JSON.stringify({ type: 'module', dependencies: { react: '18.0.0', vite: '5.0.0' } }));
  await writeFile(join(conflictProject, 'src', 'index.css'), ':root { --surface: white; }\n');
  await writeFile(join(conflictProject, 'src', 'globals.css'), ':root { --surface: black; }\n');
  await assert.rejects(
    () => prepareComponentAdaptation(manifest.componentId, { catalogSource: remoteSource, projectPath: conflictProject }),
    (error) => error instanceof AdaptationError && error.code === 'ADAPT_PROJECT_CONFLICT',
  );

  const targetProject = await freshProject();
  const bundle = await prepareComponentAdaptation(manifest.componentId, { catalogSource: remoteSource, projectPath: targetProject });
  const target = bundle.files[0];
  await mkdir(dirname(join(targetProject, target.path)), { recursive: true });
  await writeFile(join(targetProject, target.path), 'interfering edit\n');
  await assert.rejects(
    () => applyAdaptation(bundle, { catalogSource: remoteSource }),
    (error) => error instanceof AdaptationError && error.code === 'ADAPT_TARGET_CHANGED',
  );
  assert.equal(await readFile(join(targetProject, target.path), 'utf8'), 'interfering edit\n');

  await rm(conflictProject, { recursive: true, force: true });
  await rm(targetProject, { recursive: true, force: true });
});

test('a remote package with individually valid paths still cannot escape the destination project', async () => {
  const manifest = await fixtureManifest();
  Object.assign(manifest, { componentId: 'cmp_test_remote_escape', namespace: 'test', slug: 'remote-escape' });
  const entryContent = 'export function Entry() { return null; }\n';
  const otherContent = 'export const helper = 1;\n';
  // Every individual path is a valid, parseRemoteComponentPackage-accepted relative path (no
  // leading '/', no '..' segments) — the escape only appears once `safeRelative` combines the
  // destination's own componentDirectory convention with a file's position *relative to the entry
  // file*, exactly the same computation local-sourced files go through.
  const files = [
    { path: 'a/b/c/d/Entry.tsx', content: entryContent, contentHash: sha256(entryContent) },
    { path: 'other.ts', content: otherContent, contentHash: sha256(otherContent) },
  ];
  const remotePackage = parseRemoteComponentPackage({
    schemaVersion: '1', componentId: manifest.componentId, revisionId: manifest.currentRevision, manifest, files, assets: [],
  });
  const client = fakeRemoteClient(() => remotePackage, () => remotePackage.manifest);
  const remoteSource = new RemoteCatalogSource(client);
  const projectPath = await freshProject();
  const componentsDir = join(projectPath, 'src', 'components');
  const before = await readdir(componentsDir);

  await assert.rejects(
    () => prepareComponentAdaptation(manifest.componentId, { catalogSource: remoteSource, projectPath }),
    (error) => error instanceof AdaptationError && error.code === 'ADAPT_INVALID_TARGET',
  );
  // Nothing was written: the escaping file is detected during bundle preparation, well before
  // any apply-time write.
  assert.deepEqual(await readdir(componentsDir), before);

  await rm(projectPath, { recursive: true, force: true });
});

test('remote package assets never become destination project files, even though they travel with the resolved source', async () => {
  const manifest = await fixtureManifest();
  Object.assign(manifest, { componentId: 'cmp_test_remote_assets', namespace: 'test', slug: 'remote-assets' });
  const entryContent = 'export function WithAsset() { return null; }\n';
  const assetBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');
  const files = [{ path: 'WithAsset.tsx', content: entryContent, contentHash: sha256(entryContent) }];
  const assets = [{ path: 'icons/star.svg', contentBase64: assetBytes.toString('base64'), contentHash: sha256(assetBytes), mediaType: 'image/svg+xml' }];
  const remotePackage = parseRemoteComponentPackage({
    schemaVersion: '1', componentId: manifest.componentId, revisionId: manifest.currentRevision, manifest, files, assets,
  });
  const client = fakeRemoteClient(() => remotePackage, () => remotePackage.manifest);
  const remoteSource = new RemoteCatalogSource(client);
  const projectPath = await freshProject();

  const bundle = await prepareComponentAdaptation(manifest.componentId, { catalogSource: remoteSource, projectPath });
  assert.equal(bundle.files.length, 1);
  assert.ok(bundle.files[0].path.endsWith('WithAsset.tsx'));
  assert.equal(bundle.files.some((file) => file.path.includes('star.svg') || file.path.includes('icons')), false);

  await rm(projectPath, { recursive: true, force: true });
});
