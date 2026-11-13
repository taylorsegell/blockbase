import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initialCatalogMetadata, listCatalogComponents, readCatalogMetadata } from '@blockbase/core';

export type CatalogListComponent = {
  componentId: string;
  namespace: string;
  slug: string;
  displayName: string;
  description: string;
  category: string;
  tags: string[];
  /** Bucket recorded by the legacy migration report, or null for blocks imported since. */
  bucket: string | null;
};

export type CatalogListCollection = { id: string; title: string; reserved: boolean; slugs: string[] };

export type CatalogList = { components: CatalogListComponent[]; collections: CatalogListCollection[] };

/**
 * Read-only listing of every component plus collections: the same inputs the catalog page
 * reads (manifests, migration-report buckets, metadata collections), so a client such as the
 * editor extension can mirror the page without reading the catalog directory itself.
 */
export async function listCatalog(catalogRoot: string): Promise<CatalogList> {
  const [components, buckets] = await Promise.all([listCatalogComponents(catalogRoot), readBuckets(catalogRoot)]);
  const known = new Set(components.map((component) => component.slug));
  const fallback = initialCatalogMetadata(Object.fromEntries(components.map((component) => [component.slug, component.tags])), [], known);
  const metadata = await readCatalogMetadata(catalogRoot, fallback);
  return {
    components: components.map(({ manifest }) => ({
      componentId: manifest.componentId,
      namespace: manifest.namespace,
      slug: manifest.slug,
      displayName: manifest.displayName,
      description: manifest.description,
      category: manifest.category,
      tags: [...manifest.tags],
      bucket: buckets.get(manifest.componentId) ?? null,
    })),
    collections: metadata.collections.map(({ id, title, reserved, slugs }) => ({ id, title, reserved, slugs: [...slugs] })),
  };
}

async function readBuckets(catalogRoot: string): Promise<Map<string, string>> {
  const buckets = new Map<string, string>();
  let text: string;
  try {
    text = await readFile(join(catalogRoot, 'migration-report.json'), 'utf8');
  } catch {
    return buckets; // migration-report.json is optional (catalogs that never migrated).
  }
  let report: { entries?: Array<{ manifest?: { componentId?: unknown }; source?: { bucket?: unknown } }> };
  try {
    report = JSON.parse(text);
  } catch {
    return buckets;
  }
  for (const item of report.entries ?? []) {
    const id = item.manifest?.componentId;
    if (typeof id === 'string' && typeof item.source?.bucket === 'string') buckets.set(id, item.source.bucket);
  }
  return buckets;
}
