import type { ComponentManifest, ContractVersion } from '@blockbase/contracts';

export type ProjectionEntry = {
  componentId: string;
  namespace: string;
  slug: string;
  name: string;
  bucket: string;
  path: string;
  sharedPath?: boolean;
  exported: string;
  tags: string[];
  categoryRoute: string;
  facetInputs: { category: string; bucket: string; tags: string[] };
  packagePath: string;
  revisionId: string;
};

export type CollectionProjection = {
  id: string;
  title: string;
  reserved: boolean;
  slugs: string[];
};

export type ProjectionDataAccounting = {
  tags: { source: 'authoritative-manifest'; componentCount: number; tagCount: number };
  collections: {
    source: 'legacy-export-import-record' | 'not-provided';
    collectionCount: number;
    preservedSlugs: string[];
    unresolvedSlugs: string[];
    reversible: true;
  };
};

export type PreviewProjection = {
  schemaVersion: ContractVersion;
  generatedFrom: 'authoritative-manifests';
  taxonomy: { familyHeader: ['Name', 'Slug']; buckets: ['brick', 'build', 'creation']; families: string[] };
  counts: { manifests: number; entries: number; tags: number; collections: number };
  entries: ProjectionEntry[];
  collections: CollectionProjection[];
  dataAccounting: ProjectionDataAccounting;
};

export type ProjectionOutputs = {
  registry: PreviewProjection;
  catalog: PreviewProjection;
};

export type ProjectionOptions = {
  catalogRoot: string;
  /** Optional explicit legacy collections export; it is recorded, never authoritative for component metadata. */
  collectionsPath?: string;
  /** Migration-produced identity/path overlay; never read from the legacy checkout. */
  migrationReportPath?: string;
  indexPath?: string;
};

export type ProjectionWriteOptions = ProjectionOptions & {
  registryPath: string;
  catalogPath: string;
};

export type ProjectionDrift = {
  registry: boolean;
  catalog: boolean;
};

export type ProjectionManifest = ComponentManifest;
