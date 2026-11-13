import type { ContractVersion } from '@blockbase/contracts';
import type { CollectionProjection } from '../projections/types.js';

export type CatalogMetadata = {
  schemaVersion: ContractVersion;
  metadataVersion: number;
  tagsBySlug: Record<string, string[]>;
  collections: CollectionProjection[];
};

export type MetadataUpdate = {
  expectedVersion?: number;
  tagsBySlug?: Record<string, string[]>;
  collections?: CollectionProjection[];
};
