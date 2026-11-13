import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CONTRACT_VERSION, parseComponentManifest, stableStringify, type ComponentManifest } from '@blockbase/contracts';
import { rebuildIndex } from '../index/store.js';
import { initialCatalogMetadata, readCatalogMetadata, updateCatalogMetadata } from '../metadata/service.js';
import type { CollectionProjection } from '../projections/types.js';
import { recordCatalogOperation } from '../store/history/git.js';
import { createRevisionStore } from '../store/revisions/store.js';
import { ORGANIZE_ERROR_CODES, OrganizeError } from './errors.js';

const FAMILY_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COLLECTION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type TaxonomyFamily = {
  name: string;
  slug: string;
};

export type TaxonomyFile = {
  schemaVersion: typeof CONTRACT_VERSION;
  families: TaxonomyFamily[];
};

export type CatalogComponentRef = {
  componentId: string;
  namespace: string;
  slug: string;
  category: string;
  tags: string[];
  manifest: ComponentManifest;
};

function catalogRootOf(catalogRoot: string): string {
  return resolve(catalogRoot);
}

export function taxonomyPathFor(catalogRoot: string): string {
  return join(catalogRootOf(catalogRoot), 'taxonomy.json');
}

function assertFamilySlug(slug: string): string {
  if (!FAMILY_SLUG.test(slug)) throw new OrganizeError(ORGANIZE_ERROR_CODES.invalidFamily, 'A family slug must be lowercase letters, numbers, and hyphens.', { slug });
  return slug;
}

function assertCollectionId(id: string): string {
  if (!COLLECTION_ID.test(id)) throw new OrganizeError(ORGANIZE_ERROR_CODES.invalidCollection, 'A collection id must be lowercase letters, numbers, and hyphens.', { id });
  return id;
}

function normalizeTag(tag: string): string {
  const value = tag.trim().toLowerCase();
  if (!value || /\s/.test(value)) throw new OrganizeError(ORGANIZE_ERROR_CODES.invalidTag, 'A tag must be a single non-empty token.', { tag });
  return value;
}

export async function readTaxonomy(catalogRoot: string): Promise<TaxonomyFile> {
  try {
    const value = JSON.parse(await readFile(taxonomyPathFor(catalogRoot), 'utf8')) as Partial<TaxonomyFile>;
    if (value.schemaVersion !== CONTRACT_VERSION || !Array.isArray(value.families)) throw new OrganizeError(ORGANIZE_ERROR_CODES.invalidFamily, 'taxonomy.json has an invalid shape.', { path: taxonomyPathFor(catalogRoot) });
    const families = value.families.map((family) => ({ name: String(family.name || family.slug), slug: assertFamilySlug(String(family.slug)) }));
    const seen = new Set<string>();
    for (const family of families) {
      if (seen.has(family.slug)) throw new OrganizeError(ORGANIZE_ERROR_CODES.invalidFamily, 'taxonomy.json repeats a family slug.', { slug: family.slug });
      seen.add(family.slug);
    }
    return { schemaVersion: CONTRACT_VERSION, families: families.sort((left, right) => left.slug.localeCompare(right.slug)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: CONTRACT_VERSION, families: [] };
    throw error;
  }
}

async function writeTaxonomy(catalogRoot: string, taxonomy: TaxonomyFile): Promise<void> {
  const path = taxonomyPathFor(catalogRoot);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, stableStringify(taxonomy));
  await rename(temporary, path);
}

export async function listCatalogComponents(catalogRoot: string): Promise<CatalogComponentRef[]> {
  const root = join(catalogRootOf(catalogRoot), 'components');
  const namespaces = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? [] : Promise.reject(error)));
  const components: CatalogComponentRef[] = [];
  for (const namespace of namespaces) {
    if (!namespace.isDirectory() || namespace.name.startsWith('.')) continue;
    const slugs = await readdir(join(root, namespace.name), { withFileTypes: true }).catch(() => []);
    for (const slug of slugs) {
      if (!slug.isDirectory() || slug.name.startsWith('.')) continue;
      try {
        const manifest = parseComponentManifest(JSON.parse(await readFile(join(root, namespace.name, slug.name, 'component.json'), 'utf8')));
        components.push({ componentId: manifest.componentId, namespace: manifest.namespace, slug: manifest.slug, category: manifest.category, tags: [...manifest.tags], manifest });
      } catch {
        continue;
      }
    }
  }
  return components.sort((left, right) => left.componentId.localeCompare(right.componentId));
}

export function resolveCatalogComponent(components: CatalogComponentRef[], input: string): CatalogComponentRef {
  const byId = components.filter((component) => component.componentId === input);
  if (byId.length === 1) return byId[0];
  const bySlug = components.filter((component) => component.slug === input || `${component.namespace}/${component.slug}` === input);
  if (bySlug.length === 1) return bySlug[0];
  if (bySlug.length > 1) {
    throw new OrganizeError(ORGANIZE_ERROR_CODES.ambiguous, 'That slug matches more than one component. Pass the component id.', { input, candidates: bySlug.map((component) => component.componentId) });
  }
  throw new OrganizeError(ORGANIZE_ERROR_CODES.notFound, 'No catalog component matched that id or slug.', { input });
}

async function mutateManifest(catalogRoot: string, component: CatalogComponentRef, mutate: (manifest: ComponentManifest) => ComponentManifest): Promise<CatalogComponentRef> {
  const store = createRevisionStore({ catalogRoot });
  const current = await store.readManifest(component.namespace, component.slug);
  const next = await store.updateManifest(component.namespace, component.slug, mutate(current));
  await rebuildIndex({ catalogRoot });
  return { componentId: next.componentId, namespace: next.namespace, slug: next.slug, category: next.category, tags: [...next.tags], manifest: next };
}

async function syncTagMetadata(catalogRoot: string, components: CatalogComponentRef[]): Promise<void> {
  const counts = new Map<string, number>();
  for (const component of components) counts.set(component.slug, (counts.get(component.slug) ?? 0) + 1);
  const unique = Object.fromEntries(components.filter((component) => counts.get(component.slug) === 1).map((component) => [component.slug, component.tags]));
  const known = new Set(Object.keys(unique));
  const fallback = initialCatalogMetadata(unique, [], known);
  const current = await readCatalogMetadata(catalogRoot, fallback);
  await updateCatalogMetadata(catalogRoot, current, { tagsBySlug: { ...current.tagsBySlug, ...unique }, expectedVersion: current.metadataVersion }, known);
}

/** Re-derives metadata.json tags from the manifests, e.g. after a rollback restored older ones. */
export async function resyncTagMetadata(catalogRoot: string): Promise<void> {
  await syncTagMetadata(catalogRoot, await listCatalogComponents(catalogRoot));
}

export async function listTags(catalogRoot: string, input?: string): Promise<{ components: Array<{ componentId: string; namespace: string; slug: string; tags: string[] }> }> {
  const components = await listCatalogComponents(catalogRoot);
  const selected = input ? [resolveCatalogComponent(components, input)] : components;
  return { components: selected.map(({ componentId, namespace, slug, tags }) => ({ componentId, namespace, slug, tags: [...tags].sort() })) };
}

export async function addTag(catalogRoot: string, input: string, tag: string): Promise<CatalogComponentRef> {
  const value = normalizeTag(tag);
  return recordCatalogOperation<CatalogComponentRef>(catalogRoot, { operation: 'tag.add', summary: (result) => `tag add ${value} → ${result.namespace}/${result.slug}` }, async () => {
    const components = await listCatalogComponents(catalogRoot);
    const component = resolveCatalogComponent(components, input);
    const updated = await mutateManifest(catalogRoot, component, (manifest) => ({ ...manifest, tags: [...new Set([...manifest.tags, value])].sort() }));
    const next = components.map((entry) => (entry.componentId === updated.componentId ? updated : entry));
    await syncTagMetadata(catalogRoot, next);
    return updated;
  });
}

export async function removeTag(catalogRoot: string, input: string, tag: string): Promise<CatalogComponentRef> {
  const value = normalizeTag(tag);
  return recordCatalogOperation<CatalogComponentRef>(catalogRoot, { operation: 'tag.remove', summary: (result) => `tag remove ${value} → ${result.namespace}/${result.slug}` }, async () => {
    const components = await listCatalogComponents(catalogRoot);
    const component = resolveCatalogComponent(components, input);
    const updated = await mutateManifest(catalogRoot, component, (manifest) => ({ ...manifest, tags: manifest.tags.filter((entry) => entry !== value) }));
    const next = components.map((entry) => (entry.componentId === updated.componentId ? updated : entry));
    await syncTagMetadata(catalogRoot, next);
    return updated;
  });
}

export async function listFamilies(catalogRoot: string): Promise<{ families: TaxonomyFamily[]; unassigned: Array<{ componentId: string; slug: string; category: string }> }> {
  const taxonomy = await readTaxonomy(catalogRoot);
  const known = new Set(taxonomy.families.map((family) => family.slug));
  const components = await listCatalogComponents(catalogRoot);
  return {
    families: taxonomy.families,
    unassigned: components.filter((component) => !known.has(component.category)).map(({ componentId, slug, category }) => ({ componentId, slug, category })),
  };
}

export async function setFamily(catalogRoot: string, input: string, slug: string, options: { name?: string; create?: boolean } = {}): Promise<{ component: CatalogComponentRef; created: boolean; families: TaxonomyFamily[] }> {
  const familySlug = assertFamilySlug(slug);
  return recordCatalogOperation<{ component: CatalogComponentRef; created: boolean; families: TaxonomyFamily[] }>(catalogRoot, { operation: 'family.set', summary: (result) => `family set ${familySlug} → ${result.component.namespace}/${result.component.slug}` }, async () => {
    const components = await listCatalogComponents(catalogRoot);
    const component = resolveCatalogComponent(components, input);
    const taxonomy = await readTaxonomy(catalogRoot);
    let created = false;
    if (!taxonomy.families.some((family) => family.slug === familySlug)) {
      if (!options.create) throw new OrganizeError(ORGANIZE_ERROR_CODES.unknownFamily, 'That family is not in taxonomy.json. Pass --create to add it.', { slug: familySlug });
      taxonomy.families.push({ slug: familySlug, name: options.name?.trim() || familySlug });
      taxonomy.families.sort((left, right) => left.slug.localeCompare(right.slug));
      await writeTaxonomy(catalogRoot, taxonomy);
      created = true;
    }
    const updated = await mutateManifest(catalogRoot, component, (manifest) => ({ ...manifest, category: familySlug }));
    return { component: updated, created, families: taxonomy.families };
  });
}

async function withCollections(catalogRoot: string, update: (collections: CollectionProjection[], known: Set<string>) => CollectionProjection[]): Promise<CollectionProjection[]> {
  const components = await listCatalogComponents(catalogRoot);
  const known = new Set(components.map((component) => component.slug));
  const tagsBySlug = Object.fromEntries(components.map((component) => [component.slug, component.tags]));
  const fallback = initialCatalogMetadata(tagsBySlug, [], known);
  const current = await readCatalogMetadata(catalogRoot, fallback);
  const next = await updateCatalogMetadata(catalogRoot, current, { collections: update(current.collections.map((collection) => ({ ...collection, slugs: [...collection.slugs] })), known), expectedVersion: current.metadataVersion }, known);
  return next.collections;
}

export async function listCollections(catalogRoot: string): Promise<{ collections: CollectionProjection[] }> {
  const components = await listCatalogComponents(catalogRoot);
  const known = new Set(components.map((component) => component.slug));
  const tagsBySlug = Object.fromEntries(components.map((component) => [component.slug, component.tags]));
  const metadata = await readCatalogMetadata(catalogRoot, initialCatalogMetadata(tagsBySlug, [], known));
  return { collections: metadata.collections };
}

export async function createCollection(catalogRoot: string, id: string, title: string): Promise<{ collections: CollectionProjection[] }> {
  const collectionId = assertCollectionId(id);
  return recordCatalogOperation<{ collections: CollectionProjection[] }>(catalogRoot, { operation: 'collection.create', summary: () => `collection create ${collectionId}` }, async () => {
    const label = title.trim();
    if (!label) throw new OrganizeError(ORGANIZE_ERROR_CODES.invalidCollection, 'A collection title is required.', { id: collectionId });
    const collections = await withCollections(catalogRoot, (current) => {
      if (current.some((collection) => collection.id === collectionId)) throw new OrganizeError(ORGANIZE_ERROR_CODES.duplicateCollection, 'That collection already exists.', { id: collectionId });
      return [...current, { id: collectionId, title: label, reserved: collectionId === 'favorites', slugs: [] }];
    });
    return { collections };
  });
}

export async function deleteCollection(catalogRoot: string, id: string): Promise<{ collections: CollectionProjection[] }> {
  const collectionId = assertCollectionId(id);
  return recordCatalogOperation<{ collections: CollectionProjection[] }>(catalogRoot, { operation: 'collection.delete', summary: () => `collection delete ${collectionId}` }, async () => {
    if (collectionId === 'favorites') throw new OrganizeError(ORGANIZE_ERROR_CODES.reservedCollection, 'The favorites collection cannot be deleted.', { id: collectionId });
    const collections = await withCollections(catalogRoot, (current) => {
      if (!current.some((collection) => collection.id === collectionId)) throw new OrganizeError(ORGANIZE_ERROR_CODES.notFound, 'That collection was not found.', { id: collectionId });
      return current.filter((collection) => collection.id !== collectionId);
    });
    return { collections };
  });
}

function requireCollection(collections: CollectionProjection[], id: string): CollectionProjection {
  const collection = collections.find((entry) => entry.id === id);
  if (!collection) throw new OrganizeError(ORGANIZE_ERROR_CODES.notFound, 'That collection was not found.', { id });
  return collection;
}

export async function addCollectionSlug(catalogRoot: string, id: string, slug: string): Promise<{ collections: CollectionProjection[] }> {
  const collectionId = assertCollectionId(id);
  return recordCatalogOperation<{ collections: CollectionProjection[] }>(catalogRoot, { operation: 'collection.add', summary: () => `collection add ${slug} → ${collectionId}` }, async () => {
    const collections = await withCollections(catalogRoot, (current, known) => {
      if (!known.has(slug)) throw new OrganizeError(ORGANIZE_ERROR_CODES.notFound, 'That component slug is not in the catalog.', { slug });
      const collection = requireCollection(current, collectionId);
      if (!collection.slugs.includes(slug)) collection.slugs.push(slug);
      return current;
    });
    return { collections };
  });
}

export async function removeCollectionSlug(catalogRoot: string, id: string, slug: string): Promise<{ collections: CollectionProjection[] }> {
  const collectionId = assertCollectionId(id);
  return recordCatalogOperation<{ collections: CollectionProjection[] }>(catalogRoot, { operation: 'collection.remove', summary: () => `collection remove ${slug} from ${collectionId}` }, async () => {
    const collections = await withCollections(catalogRoot, (current) => {
      const collection = requireCollection(current, collectionId);
      collection.slugs = collection.slugs.filter((entry) => entry !== slug);
      return current;
    });
    return { collections };
  });
}

export async function reorderCollectionSlug(catalogRoot: string, id: string, slug: string, index: number): Promise<{ collections: CollectionProjection[] }> {
  const collectionId = assertCollectionId(id);
  return recordCatalogOperation<{ collections: CollectionProjection[] }>(catalogRoot, { operation: 'collection.reorder', summary: () => `collection reorder ${slug} to ${index} in ${collectionId}` }, async () => {
    if (!Number.isInteger(index) || index < 0) throw new OrganizeError(ORGANIZE_ERROR_CODES.invalidCollection, 'A collection index must be a non-negative integer.', { index });
    const collections = await withCollections(catalogRoot, (current) => {
      const collection = requireCollection(current, collectionId);
      const from = collection.slugs.indexOf(slug);
      if (from < 0) throw new OrganizeError(ORGANIZE_ERROR_CODES.notFound, 'That slug is not in the collection.', { id: collectionId, slug });
      const [moved] = collection.slugs.splice(from, 1);
      const target = Math.min(index, collection.slugs.length);
      collection.slugs.splice(target, 0, moved);
      return current;
    });
    return { collections };
  });
}
