import { readFile } from 'node:fs/promises';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import { CONTRACT_VERSION, parseComponentManifest, stableStringify, type ComponentManifest } from '@blockbase/contracts';
import { ALLOWED_BUCKETS } from '../catalog/taxonomy.js';
import { openIndex } from '../index/store.js';
import type { CollectionProjection, PreviewProjection, ProjectionDrift, ProjectionEntry, ProjectionOptions, ProjectionOutputs, ProjectionWriteOptions } from './types.js';

export * from './types.js';

const BUCKETS = [...ALLOWED_BUCKETS] as ['brick', 'build', 'creation'];

type ManifestRecord = { manifest: ComponentManifest; path: string };
type CatalogOverlay = { name: string; bucket: string; slug: string; path: string; exported: string; sharedPath?: boolean };

function compare(left: string, right: string): number {
  return left.localeCompare(right);
}

async function manifestRecords(catalogRoot: string): Promise<ManifestRecord[]> {
  const root = join(resolve(catalogRoot), 'components');
  const records: ManifestRecord[] = [];
  const namespaces = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const namespace of namespaces.sort((a, b) => compare(a.name, b.name))) {
    if (!namespace.isDirectory()) continue;
    const namespaceRoot = join(root, namespace.name);
    const slugs = await readdir(namespaceRoot, { withFileTypes: true });
    for (const slug of slugs.sort((a, b) => compare(a.name, b.name))) {
      if (!slug.isDirectory()) continue;
      const path = join(namespaceRoot, slug.name, 'component.json');
      let manifest: ComponentManifest;
      try {
        manifest = parseComponentManifest(JSON.parse(await readFile(path, 'utf8')));
      } catch (error) {
        throw new Error(`Authoritative manifest '${path}' is invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
      records.push({ manifest, path });
    }
  }
  return records;
}

async function readMigrationOverlays(path: string | undefined): Promise<Map<string, CatalogOverlay>> {
  if (!path) return new Map();
  let value: unknown;
  try { value = JSON.parse(await readFile(path, 'utf8')); } catch (error) { throw new Error(`Migration report '${path}' is invalid: ${error instanceof Error ? error.message : String(error)}`); }
  const rows = value && typeof value === 'object' && Array.isArray((value as { entries?: unknown }).entries) ? (value as { entries: unknown[] }).entries : [];
  const overlays = new Map<string, CatalogOverlay>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const item = row as Record<string, unknown>;
    const target = item.target;
    const source = item.source;
    if (!target || typeof target !== 'object' || !source || typeof source !== 'object' || Array.isArray(target) || Array.isArray(source)) continue;
    const targetRecord = target as Record<string, unknown>;
    const sourceRecord = source as Record<string, unknown>;
    const conflicts = Array.isArray(item.conflicts) ? item.conflicts.filter((code): code is string => typeof code === 'string') : [];
    if (typeof targetRecord.componentId !== 'string' || typeof sourceRecord.name !== 'string' || typeof sourceRecord.bucket !== 'string' || typeof sourceRecord.slug !== 'string' || typeof sourceRecord.path !== 'string' || typeof sourceRecord.exported !== 'string') continue;
    overlays.set(targetRecord.componentId, {
      name: sourceRecord.name,
      bucket: sourceRecord.bucket,
      slug: sourceRecord.slug,
      path: sourceRecord.path,
      exported: sourceRecord.exported,
      ...(conflicts.includes('catalog.shared_path_exception') ? { sharedPath: true } : {}),
    });
  }
  return overlays;
}

function assertManifestCatalog(manifest: ComponentManifest, manifestPath: string, overlays: Map<string, CatalogOverlay>): CatalogOverlay {
  const catalog = overlays.get(manifest.componentId) ?? (manifest as ComponentManifest & { catalog?: CatalogOverlay }).catalog;
  if (!catalog) throw new Error(`Manifest '${manifestPath}' has no migration projection overlay; provide migrationReportPath.`);
  if (catalog.name !== manifest.namespace) throw new Error(`Manifest '${manifestPath}' has conflicting namespace/name identity.`);
  if (catalog.exported !== manifest.displayName) throw new Error(`Manifest '${manifestPath}' has conflicting exported/displayName identity.`);
  if (!(BUCKETS as readonly string[]).includes(catalog.bucket)) throw new Error(`Manifest '${manifestPath}' has unsupported bucket '${catalog.bucket}'.`);
  const canonical = catalog.path === 'empty-states/dino-404' && manifest.slug === 'snowboarder-404'
    ? catalog.path
    : `${catalog.name}/${manifest.slug}`;
  if (catalog.path !== canonical) throw new Error(`Manifest '${manifestPath}' has noncanonical catalog path '${catalog.path}'.`);
  return catalog;
}

function projectionEntry(record: ManifestRecord, overlays: Map<string, CatalogOverlay>): ProjectionEntry {
  const { manifest } = record;
  const catalog = assertManifestCatalog(manifest, record.path, overlays);
  const packagePath = relative(resolve(record.path, '../../../..'), dirname(record.path)).split(sep).join('/');
  return {
    componentId: manifest.componentId,
    namespace: manifest.namespace,
    slug: manifest.slug,
    name: catalog.name,
    bucket: catalog.bucket,
    path: catalog.path,
    ...(catalog.sharedPath ? { sharedPath: true } : {}),
    exported: catalog.exported,
    tags: [...manifest.tags].sort(compare),
    categoryRoute: `/category/${encodeURIComponent(catalog.name)}`,
    facetInputs: { category: catalog.name, bucket: catalog.bucket, tags: [...manifest.tags].sort(compare) },
    packagePath,
    revisionId: manifest.currentRevision,
  };
}

function assertCollisions(entries: ProjectionEntry[]): void {
  const seenId = new Map<string, ProjectionEntry>();
  const seenIdentity = new Map<string, ProjectionEntry>();
  const seenPath = new Map<string, ProjectionEntry>();
  for (const entry of entries) {
    const identity = `${entry.namespace}/${entry.slug}`;
    const priorId = seenId.get(entry.componentId);
    if (priorId) throw new Error(`Projection component ID collision '${entry.componentId}' (${priorId.packagePath}, ${entry.packagePath}).`);
    const priorIdentity = seenIdentity.get(identity);
    if (priorIdentity) throw new Error(`Projection identity collision '${identity}' (${priorIdentity.packagePath}, ${entry.packagePath}).`);
    const priorPath = seenPath.get(entry.path);
    if (priorPath && !(entry.sharedPath === true && priorPath.sharedPath === true && entry.path === 'empty-states/dino-404')) {
      throw new Error(`Projection catalog path collision '${entry.path}' (${priorPath.componentId}, ${entry.componentId}).`);
    }
    seenId.set(entry.componentId, entry);
    seenIdentity.set(identity, entry);
    seenPath.set(entry.path, entry);
  }
}

async function readCollections(path: string | undefined, slugs: Set<string>): Promise<{ collections: CollectionProjection[]; source: 'legacy-export-import-record' | 'not-provided'; unresolvedSlugs: string[] }> {
  if (!path) return { collections: [], source: 'not-provided', unresolvedSlugs: [] };
  let value: unknown;
  try { value = parse(await readFile(path, 'utf8')); } catch (error) { throw new Error(`Collections export '${path}' is invalid: ${error instanceof Error ? error.message : String(error)}`); }
  const rows = value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as { collections?: unknown }).collections)
    ? (value as { collections: unknown[] }).collections : [];
  const unresolved = new Set<string>();
  const collections: CollectionProjection[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const item = row as Record<string, unknown>;
    if (typeof item.id !== 'string' || typeof item.title !== 'string' || !Array.isArray(item.slugs)) continue;
    const rawSlugs = item.slugs.filter((slug): slug is string => typeof slug === 'string');
    const preserved = [...new Set(rawSlugs.filter((slug) => slugs.has(slug)))].sort(compare);
    for (const slug of rawSlugs) if (!slugs.has(slug)) unresolved.add(slug);
    collections.push({ id: item.id, title: item.title, reserved: item.reserved === true, slugs: preserved });
  }
  collections.sort((left, right) => left.id.localeCompare(right.id));
  return { collections, source: 'legacy-export-import-record', unresolvedSlugs: [...unresolved].sort(compare) };
}

async function assertIndexParity(catalogRoot: string, entries: ProjectionEntry[], indexPath?: string): Promise<void> {
  const index = await openIndex({ catalogRoot, ...(indexPath ? { indexPath } : {}) });
  try {
    const rows = index.db.prepare('SELECT component_id, namespace, slug, current_revision FROM components ORDER BY component_id').all() as Array<Record<string, unknown>>;
    if (rows.length !== entries.length) throw new Error(`Projection/index count mismatch: ${entries.length} manifests versus ${rows.length} index rows.`);
    const expected = new Map(entries.map((entry) => [entry.componentId, entry]));
    for (const row of rows) {
      const entry = expected.get(String(row.component_id));
      if (!entry || entry.namespace !== row.namespace || entry.slug !== row.slug || entry.revisionId !== row.current_revision) throw new Error(`Projection/index identity mismatch for '${String(row.component_id)}'.`);
    }
  } finally { index.close(); }
}

export async function generatePreviewProjections(options: ProjectionOptions): Promise<ProjectionOutputs> {
  const records = await manifestRecords(options.catalogRoot);
  const overlays = await readMigrationOverlays(options.migrationReportPath ?? join(resolve(options.catalogRoot), 'migration-report.json'));
  const entries = records.map((record) => projectionEntry(record, overlays)).sort((left, right) => left.bucket.localeCompare(right.bucket) || left.name.localeCompare(right.name) || left.slug.localeCompare(right.slug));
  assertCollisions(entries);
  await assertIndexParity(options.catalogRoot, entries, options.indexPath);
  const collections = await readCollections(options.collectionsPath, new Set(entries.map((entry) => entry.slug)));
  const families = [...new Set(entries.map((entry) => entry.name))].sort(compare);
  const dataAccounting = {
    tags: { source: 'authoritative-manifest' as const, componentCount: entries.length, tagCount: entries.reduce((count, entry) => count + entry.tags.length, 0) },
    collections: { source: collections.source, collectionCount: collections.collections.length, preservedSlugs: [...new Set(collections.collections.flatMap((collection) => collection.slugs))].sort(compare), unresolvedSlugs: collections.unresolvedSlugs, reversible: true as const },
  };
  const projection: PreviewProjection = {
    schemaVersion: CONTRACT_VERSION,
    generatedFrom: 'authoritative-manifests',
    taxonomy: { familyHeader: ['Name', 'Slug'], buckets: BUCKETS, families },
    counts: { manifests: records.length, entries: entries.length, tags: dataAccounting.tags.tagCount, collections: collections.collections.length },
    entries,
    collections: collections.collections,
    dataAccounting,
  };
  return { registry: projection, catalog: projection };
}

export function projectionJson(projection: PreviewProjection): string {
  return stableStringify(projection);
}

export async function writePreviewProjections(options: ProjectionWriteOptions): Promise<{ outputs: ProjectionOutputs; paths: { registry: string; catalog: string } }> {
  const outputs = await generatePreviewProjections(options);
  await mkdir(dirname(resolve(options.registryPath)), { recursive: true });
  await mkdir(dirname(resolve(options.catalogPath)), { recursive: true });
  await writeFile(resolve(options.registryPath), projectionJson(outputs.registry));
  await writeFile(resolve(options.catalogPath), projectionJson(outputs.catalog));
  return { outputs, paths: { registry: resolve(options.registryPath), catalog: resolve(options.catalogPath) } };
}

export async function checkPreviewProjectionDrift(options: ProjectionWriteOptions): Promise<ProjectionDrift> {
  const outputs = await generatePreviewProjections(options);
  const [registry, catalog] = await Promise.all([
    readFile(resolve(options.registryPath), 'utf8').catch(() => null),
    readFile(resolve(options.catalogPath), 'utf8').catch(() => null),
  ]);
  const drift = { registry: registry !== projectionJson(outputs.registry), catalog: catalog !== projectionJson(outputs.catalog) };
  if (drift.registry || drift.catalog) throw new Error(`Generated projection drift detected (registry=${drift.registry}, catalog=${drift.catalog}).`);
  return drift;
}
