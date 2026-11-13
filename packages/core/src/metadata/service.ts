import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CONTRACT_VERSION, stableStringify } from '@blockbase/contracts';
import type { CollectionProjection } from '../projections/types.js';
import type { CatalogMetadata, MetadataUpdate } from './types.js';

export class MetadataConflictError extends Error {
  readonly code = 'METADATA_CONFLICT';
  constructor(message: string, readonly details: { expectedVersion: number; actualVersion: number }) { super(message); }
}

export function metadataPathFor(catalogRoot: string): string { return join(resolve(catalogRoot), 'metadata.json'); }

function normalizeTags(tags: string[]): string[] { return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].sort(); }

function normalizeCollections(collections: CollectionProjection[], knownSlugs: Set<string>): CollectionProjection[] {
  const result = collections.map((collection) => ({ id: collection.id, title: collection.id === 'favorites' ? 'Favorites' : collection.title, reserved: collection.id === 'favorites' || collection.reserved === true, slugs: [...new Set(collection.slugs)].filter((slug) => knownSlugs.has(slug)) }));
  if (!result.some((collection) => collection.id === 'favorites')) result.unshift({ id: 'favorites', title: 'Favorites', reserved: true, slugs: [] });
  return result;
}

export function initialCatalogMetadata(tagsBySlug: Record<string, string[]>, collections: CollectionProjection[], knownSlugs: Set<string>): CatalogMetadata {
  return { schemaVersion: CONTRACT_VERSION, metadataVersion: 0, tagsBySlug: Object.fromEntries(Object.entries(tagsBySlug).map(([slug, tags]) => [slug, normalizeTags(tags)])), collections: normalizeCollections(collections, knownSlugs) };
}

export async function readCatalogMetadata(catalogRoot: string, fallback: CatalogMetadata): Promise<CatalogMetadata> {
  try {
    const value = JSON.parse(await readFile(metadataPathFor(catalogRoot), 'utf8')) as Partial<CatalogMetadata>;
    if (value.schemaVersion !== CONTRACT_VERSION || !Number.isInteger(value.metadataVersion) || !value.tagsBySlug || !Array.isArray(value.collections)) throw new Error('Metadata file has an invalid shape.');
    return { schemaVersion: CONTRACT_VERSION, metadataVersion: value.metadataVersion as number, tagsBySlug: Object.fromEntries(Object.entries(value.tagsBySlug).map(([slug, tags]) => [slug, Array.isArray(tags) ? normalizeTags(tags) : []])), collections: normalizeCollections(value.collections, new Set(Object.keys(fallback.tagsBySlug))) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

async function persist(catalogRoot: string, value: CatalogMetadata): Promise<void> {
  const path = metadataPathFor(catalogRoot);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, stableStringify(value), { flag: 'w' });
  await rename(temporary, path);
}

async function withMetadataLock<T>(catalogRoot: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${metadataPathFor(catalogRoot)}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(lockPath);
      try { return await operation(); } finally { await rm(lockPath, { recursive: true, force: true }); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
  }
  throw new MetadataConflictError('Catalog metadata is busy; retry the update.', { expectedVersion: -1, actualVersion: -1 });
}

export async function updateCatalogMetadata(catalogRoot: string, current: CatalogMetadata, update: MetadataUpdate, knownSlugs: Set<string>): Promise<CatalogMetadata> {
  return withMetadataLock(catalogRoot, async () => {
    const latest = await readCatalogMetadata(catalogRoot, current);
    if (update.expectedVersion !== undefined && update.expectedVersion !== latest.metadataVersion) throw new MetadataConflictError('Catalog metadata changed since it was read.', { expectedVersion: update.expectedVersion, actualVersion: latest.metadataVersion });
    const next: CatalogMetadata = { schemaVersion: CONTRACT_VERSION, metadataVersion: latest.metadataVersion + 1, tagsBySlug: update.tagsBySlug ? Object.fromEntries(Object.entries(update.tagsBySlug).map(([slug, tags]) => [slug, normalizeTags(tags)])) : latest.tagsBySlug, collections: update.collections ? normalizeCollections(update.collections, knownSlugs) : latest.collections };
    await persist(catalogRoot, next);
    return next;
  });
}

export async function exportCatalogMetadata(catalogRoot: string, fallback: CatalogMetadata): Promise<{ path: string; metadata: CatalogMetadata; hash: string }> {
  const metadata = await readCatalogMetadata(catalogRoot, fallback);
  const content = stableStringify(metadata);
  const { createHash } = await import('node:crypto');
  return { path: metadataPathFor(catalogRoot), metadata, hash: `sha256:${createHash('sha256').update(content).digest('hex')}` };
}
