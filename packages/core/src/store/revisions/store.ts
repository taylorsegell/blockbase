import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseComponentManifest, stableStringify, type ComponentManifest, type SourceEnvelope } from '@blockbase/contracts';
import { IMPORT_ERROR_CODES, ImportError } from '../../import/errors.js';
import { canonicalizeSourceEnvelope, revisionHash, sha256 } from '../../import/local.js';
import type { CommitStep, ImportedRevision, IntegrityRecord, SourceContent } from '../../import/types.js';
import { RevisionLockError, RevisionStoreError, REVISION_STORE_ERROR_CODES, StaleManifestError } from './errors.js';

export type RevisionStoreOptions = {
  catalogRoot: string;
  onCommitStep?: (step: CommitStep) => void;
};

export type RevisionCommitOptions = {
  /** The immutable revision the caller read before preparing this commit. */
  expectedRevision?: string;
  /** The metadata version the caller read before preparing this commit. */
  expectedManifestVersion?: number;
  /** Alias for expectedManifestVersion used by storage clients. */
  expectedVersion?: number;
  /** Convenience If-Match value: a revision string or metadata version number. */
  ifMatch?: string | number;
};

export type StoredComponentManifest = ComponentManifest & { manifestVersion: number };

export type RecoveryEntry = {
  path: string;
  kind: 'package-staging' | 'revision-staging' | 'manifest-temporary' | 'package-temporary' | 'lock';
  action: 'removed';
};

export type RecoveryResult = {
  catalogRoot: string;
  removed: RecoveryEntry[];
};

function assertSegment(value: string, label: string): string {
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new ImportError(IMPORT_ERROR_CODES.invalidPath, `${label} must be a single safe path segment.`, { [label]: value });
  }
  return value;
}

async function syncFile(path: string, contents: Uint8Array | string): Promise<void> {
  const handle = await open(path, 'w');
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function integrityFor(source: SourceContent): IntegrityRecord {
  const envelope = canonicalizeSourceEnvelope(source.envelope);
  return {
    sourceHash: revisionHash(envelope),
    fileHashes: Object.fromEntries(envelope.files.map((file) => [file.path, file.contentHash])),
    assetHashes: Object.fromEntries(envelope.assets.map((asset) => [asset.path, asset.contentHash])),
  };
}

async function writeRevisionDirectory(path: string, source: SourceContent): Promise<void> {
  const originalPath = join(path, 'original');
  const assetsPath = join(path, 'assets');
  const directories = new Set<string>([path, originalPath]);
  await mkdir(originalPath, { recursive: true });
  if (source.envelope.assets.length > 0) {
    await mkdir(assetsPath, { recursive: true });
    directories.add(assetsPath);
  }
  for (const file of source.envelope.files) {
    const destination = join(originalPath, file.path);
    const parent = dirname(destination);
    await mkdir(parent, { recursive: true });
    directories.add(parent);
    await syncFile(destination, Buffer.from(file.content, 'utf8'));
  }
  for (const asset of source.envelope.assets) {
    const bytes = source.assetBytes.get(asset.path);
    if (!bytes) throw new ImportError(IMPORT_ERROR_CODES.invalidEnvelope, 'The source envelope does not provide bytes for an asset.', { path: asset.path });
    if (sha256(bytes) !== asset.contentHash) throw new ImportError(IMPORT_ERROR_CODES.hashMismatch, 'An asset content hash does not match its content.', { path: asset.path });
    const destination = join(assetsPath, asset.path);
    const parent = dirname(destination);
    await mkdir(parent, { recursive: true });
    directories.add(parent);
    await syncFile(destination, bytes);
  }
  // Sync child directories before their parents so directory entries survive a
  // process interruption on filesystems that do not order metadata writes.
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) await syncDirectory(directory);
}

async function writeManifest(path: string, manifest: ComponentManifest): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await syncFile(temporary, stableStringify(manifest));
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function manifestVersion(manifest: ComponentManifest | undefined): number {
  const value = (manifest as StoredComponentManifest | undefined)?.manifestVersion;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 1;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT');
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function acquireLock(componentPath: string): Promise<() => Promise<void>> {
  const lockPath = `${componentPath}.lock`;
  await mkdir(dirname(componentPath), { recursive: true });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(lockPath, 'wx');
    await handle.writeFile(stableStringify({ pid: process.pid, acquiredAt: new Date().toISOString(), token: randomUUID() }));
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'EEXIST') {
      throw new RevisionLockError('The component is already being committed.', { componentPath, lockPath });
    }
    await rm(lockPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await rm(lockPath, { force: true });
    await syncDirectory(dirname(componentPath)).catch(() => undefined);
  };
}

async function readStoredManifestAt(componentPath: string): Promise<StoredComponentManifest | undefined> {
  const path = join(componentPath, 'component.json');
  let value: string;
  try {
    value = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    return parseComponentManifest(JSON.parse(value)) as StoredComponentManifest;
  } catch (error) {
    throw new ImportError(IMPORT_ERROR_CODES.invalidEnvelope, 'The committed component manifest is invalid.', { path, cause: error instanceof Error ? error.message : String(error) });
  }
}

function expectedValues(options: RevisionCommitOptions): { revision?: string; version?: number } {
  const match = options.ifMatch;
  return {
    revision: options.expectedRevision ?? (typeof match === 'string' ? match : undefined),
    version: options.expectedManifestVersion ?? options.expectedVersion ?? (typeof match === 'number' ? match : undefined),
  };
}

function optimisticOptions(manifest: ComponentManifest, options: RevisionCommitOptions, revisionId?: string): RevisionCommitOptions {
  const stored = manifest as Partial<StoredComponentManifest>;
  const hasStoredVersion = typeof stored.manifestVersion === 'number' && Number.isInteger(stored.manifestVersion) && stored.manifestVersion > 0;
  return {
    ...options,
    expectedRevision: options.expectedRevision ?? (hasStoredVersion && revisionId !== manifest.currentRevision ? manifest.currentRevision : undefined),
    expectedManifestVersion: options.expectedManifestVersion ?? options.expectedVersion ?? (hasStoredVersion ? stored.manifestVersion : undefined),
  };
}

function assertCurrentVersion(componentPath: string, current: StoredComponentManifest | undefined, options: RevisionCommitOptions): void {
  const expected = expectedValues(options);
  const actualRevision = current?.currentRevision;
  const actualVersion = manifestVersion(current);
  if (expected.revision !== undefined && expected.revision !== actualRevision) {
    throw new StaleManifestError('The component manifest is stale and was not updated.', { componentPath, expectedRevision: expected.revision, currentRevision: actualRevision });
  }
  if (expected.version !== undefined && expected.version !== actualVersion) {
    throw new StaleManifestError('The component manifest version is stale and was not updated.', { componentPath, expectedManifestVersion: expected.version, currentManifestVersion: actualVersion });
  }
}

async function cleanup(path: string | undefined): Promise<void> {
  if (path) await rm(path, { recursive: true, force: true }).catch(() => undefined);
}

// `<name>.tmp-<id>` files are written beside component.json and renamed into place; a crash can leave one behind.
const PACKAGE_TEMPORARY = /^[^/]+\.tmp-[^/]+$/;

/**
 * Remove leftover temp files (`component.json.tmp-*`, `demo.tsx.tmp-*`, `source-paste.txt.tmp-*`, any `<name>.tmp-*`)
 * directly inside one package folder. Only regular files matching the temp pattern are removed.
 */
export async function removePackageTemporaries(packagePath: string): Promise<RecoveryEntry[]> {
  const removed: RecoveryEntry[] = [];
  const entries = await readdir(packagePath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !PACKAGE_TEMPORARY.test(entry.name)) continue;
    const path = join(packagePath, entry.name);
    try {
      await rm(path, { force: true });
    } catch (error) {
      throw new RevisionStoreError(REVISION_STORE_ERROR_CODES.recoveryFailed, 'The revision-store recovery scan could not remove a temporary artifact.', { path, cause: error instanceof Error ? error.message : String(error) });
    }
    removed.push({ path, kind: entry.name.startsWith('component.json.tmp-') ? 'manifest-temporary' : 'package-temporary', action: 'removed' });
  }
  if (removed.length > 0) await syncDirectory(packagePath).catch(() => undefined);
  return removed;
}

export class RevisionStore {
  readonly catalogRoot: string;
  readonly onCommitStep?: (step: CommitStep) => void;

  constructor(options: RevisionStoreOptions) {
    this.catalogRoot = options.catalogRoot;
    this.onCommitStep = options.onCommitStep;
  }

  packagePath(namespace: string, slug: string): string {
    return join(this.catalogRoot, 'components', assertSegment(namespace, 'namespace'), assertSegment(slug, 'slug'));
  }

  async commit(sourceInput: SourceContent | SourceEnvelope, manifest: ComponentManifest, options: RevisionCommitOptions = {}): Promise<ImportedRevision> {
    const source: SourceContent = 'envelope' in sourceInput ? sourceInput : { envelope: sourceInput, assetBytes: new Map() };
    const envelope = canonicalizeSourceEnvelope(source.envelope);
    const integrity = integrityFor({ ...source, envelope });
    const revisionId = integrity.sourceHash;
    const revisionName = revisionId.slice('sha256:'.length);
    const componentPath = this.packagePath(manifest.namespace, manifest.slug);
    const revisionPath = join(componentPath, 'revisions', revisionName);
    const guardedOptions = optimisticOptions(manifest, options, revisionId);
    const release = await acquireLock(componentPath);
    let revisionStaging: string | undefined;
    let packageStaging: string | undefined;
    try {
      const packageExists = await isDirectory(componentPath);
      const current = packageExists ? await readStoredManifestAt(componentPath) : undefined;
      assertCurrentVersion(componentPath, current, guardedOptions);
      const parsedManifest: StoredComponentManifest = {
        ...manifest,
        currentRevision: revisionId,
        manifestVersion: current ? manifestVersion(current) + 1 : 1,
        integrity: { sourceHash: integrity.sourceHash, assetHashes: Object.values(integrity.assetHashes) },
      };
      try {
        parseComponentManifest(parsedManifest);
      } catch (error) {
        throw new ImportError(IMPORT_ERROR_CODES.invalidEnvelope, error instanceof Error ? error.message : 'The component manifest is invalid.');
      }

      if (packageExists) {
        const revisionExists = await isDirectory(revisionPath);
        if (!revisionExists) {
          const revisionsPath = dirname(revisionPath);
          await mkdir(revisionsPath, { recursive: true });
          revisionStaging = join(revisionsPath, `.staging-${randomUUID()}`);
          await mkdir(revisionStaging, { recursive: true });
          await writeRevisionDirectory(revisionStaging, source);
          this.onCommitStep?.('staged');
          await rename(revisionStaging, revisionPath);
          revisionStaging = undefined;
          await syncDirectory(revisionsPath);
          this.onCommitStep?.('revision-renamed');
        }
        await writeManifest(join(componentPath, 'component.json'), parsedManifest);
        this.onCommitStep?.('manifest-written');
      } else {
        const componentsPath = join(this.catalogRoot, 'components');
        await mkdir(componentsPath, { recursive: true });
        packageStaging = join(componentsPath, `.staging-${randomUUID()}`);
        await mkdir(join(packageStaging, 'revisions', revisionName), { recursive: true });
        await writeRevisionDirectory(join(packageStaging, 'revisions', revisionName), source);
        await writeManifest(join(packageStaging, 'component.json'), parsedManifest);
        this.onCommitStep?.('staged');
        await rename(packageStaging, componentPath);
        packageStaging = undefined;
        await syncDirectory(dirname(componentPath));
        this.onCommitStep?.('package-renamed');
      }

      return {
        envelope,
        manifest: parsedManifest,
        revisionId,
        integrity,
        packagePath: componentPath,
        componentPath,
        revisionPath,
      };
    } catch (error) {
      await cleanup(revisionStaging);
      await cleanup(packageStaging);
      if (error instanceof ImportError || error instanceof RevisionStoreError) throw error;
      throw new ImportError(IMPORT_ERROR_CODES.commitFailed, 'The revision could not be committed.', { cause: error instanceof Error ? error.message : String(error) });
    } finally {
      await release();
    }
  }

  /** Atomically edits metadata while retaining the current immutable revision. */
  async updateManifest(namespace: string, slug: string, manifest: ComponentManifest, options: RevisionCommitOptions = {}): Promise<ComponentManifest> {
    const componentPath = this.packagePath(namespace, slug);
    const release = await acquireLock(componentPath);
    try {
      const current = await readStoredManifestAt(componentPath);
      if (!current) throw new ImportError(IMPORT_ERROR_CODES.sourceNotFound, 'The component package was not found.', { namespace, slug });
      assertCurrentVersion(componentPath, current, optimisticOptions(manifest, options));
      const next: StoredComponentManifest = {
        ...manifest,
        componentId: current.componentId,
        namespace: current.namespace,
        slug: current.slug,
        currentRevision: current.currentRevision,
        manifestVersion: manifestVersion(current) + 1,
        integrity: current.integrity,
      };
      try {
        parseComponentManifest(next);
      } catch (error) {
        throw new ImportError(IMPORT_ERROR_CODES.invalidEnvelope, error instanceof Error ? error.message : 'The component manifest is invalid.');
      }
      await writeManifest(join(componentPath, 'component.json'), next);
      this.onCommitStep?.('manifest-written');
      return next;
    } finally {
      await release();
    }
  }

  updateMetadata(namespace: string, slug: string, manifest: ComponentManifest, options: RevisionCommitOptions = {}): Promise<ComponentManifest> {
    return this.updateManifest(namespace, slug, manifest, options);
  }

  async readManifest(namespace: string, slug: string): Promise<ComponentManifest> {
    const path = join(this.packagePath(namespace, slug), 'component.json');
    try {
      return parseComponentManifest(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) {
      if (error instanceof ImportError) throw error;
      throw new ImportError(IMPORT_ERROR_CODES.sourceNotFound, 'The component package was not found.', { namespace, slug });
    }
  }

  async readManifestVersion(namespace: string, slug: string): Promise<number> {
    const current = await readStoredManifestAt(this.packagePath(namespace, slug));
    if (!current) throw new ImportError(IMPORT_ERROR_CODES.sourceNotFound, 'The component package was not found.', { namespace, slug });
    return manifestVersion(current);
  }

  /** Remove only known temporary/staging artifacts; authoritative packages stay untouched. */
  async recover(): Promise<RecoveryResult> {
    const removed: RecoveryEntry[] = [];
    const root = join(this.catalogRoot, 'components');
    const remove = async (path: string, kind: RecoveryEntry['kind'], parent: string): Promise<void> => {
      try {
        await rm(path, { recursive: true, force: true });
        removed.push({ path, kind, action: 'removed' });
        await syncDirectory(parent).catch(() => undefined);
      } catch (error) {
        throw new RevisionStoreError(REVISION_STORE_ERROR_CODES.recoveryFailed, 'The revision-store recovery scan could not remove a temporary artifact.', { path, cause: error instanceof Error ? error.message : String(error) });
      }
    };
    const rootEntries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of rootEntries) {
      const path = join(root, entry.name);
      if (entry.name.startsWith('.staging-')) await remove(path, 'package-staging', root);
      else if (entry.isDirectory()) {
        const namespaceEntries = await readdir(path, { withFileTypes: true }).catch(() => []);
        for (const packageEntry of namespaceEntries) {
          const packagePath = join(path, packageEntry.name);
          if (packageEntry.name.endsWith('.lock')) await remove(packagePath, 'lock', path);
          else if (packageEntry.name.startsWith('.staging-')) await remove(packagePath, 'package-staging', path);
          else if (packageEntry.isDirectory()) {
            const revisionRoot = join(packagePath, 'revisions');
            const revisionEntries = await readdir(revisionRoot, { withFileTypes: true }).catch(() => []);
            for (const revisionEntry of revisionEntries) {
              if (revisionEntry.name.startsWith('.staging-')) await remove(join(revisionRoot, revisionEntry.name), 'revision-staging', revisionRoot);
            }
            removed.push(...await removePackageTemporaries(packagePath));
          }
        }
      }
    }
    return { catalogRoot: this.catalogRoot, removed };
  }

  recoverIncomplete(): Promise<RecoveryResult> {
    return this.recover();
  }
}

export async function recoverRevisionStore(options: RevisionStoreOptions | string): Promise<RecoveryResult> {
  return new RevisionStore(typeof options === 'string' ? { catalogRoot: options } : options).recover();
}

export const recoverCatalog = recoverRevisionStore;
export const scanRecovery = recoverRevisionStore;

export function createRevisionStore(options: RevisionStoreOptions | string): RevisionStore {
  return new RevisionStore(typeof options === 'string' ? { catalogRoot: options } : options);
}
