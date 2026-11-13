import type { ContractVersion } from '@blockbase/contracts';

export type CatalogResolutionSource = 'explicit' | 'environment' | 'platform-default';

export type CatalogLocationKind = 'missing' | 'file' | 'directory' | 'other';

export type CheckedCatalogLocation = {
  path: string;
  source: CatalogResolutionSource;
  exists: boolean;
  kind: CatalogLocationKind;
  selected: boolean;
};
export type CatalogResolutionOptions = {
  catalog?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
  cwd?: string;
};

export type CatalogResolution = {
  schemaVersion: ContractVersion;
  found: boolean;
  catalogPath: string | null;
  resolvedPath: string | null;
  rootPath: string | null;
  source: CatalogResolutionSource | null;
  winningSource: CatalogResolutionSource | null;
  checkedLocations: CheckedCatalogLocation[];
};

export type CatalogDiagnosticSeverity = 'error' | 'warning';

export type CatalogDiagnosticCode =
  | 'catalog.missing'
  | 'catalog.invalid_yaml'
  | 'catalog.invalid_shape'
  | 'catalog.missing_field'
  | 'catalog.path_traversal'
  | 'catalog.noncanonical_path'
  | 'catalog.duplicate_identity'
  | 'catalog.shared_path'
  | 'catalog.shared_path_exception'
  | 'catalog.missing_required_file'
  | 'catalog.missing_index'
  | 'catalog.metadata_invalid_yaml'
  | 'catalog.metadata_disagreement'
  | 'catalog.registry_missing'
  | 'taxonomy.invalid_yaml'
  | 'taxonomy.invalid_header'
  | 'taxonomy.invalid_bucket'
  | 'taxonomy.missing_family'
  | 'taxonomy.unused_family'
  | 'taxonomy.duplicate_family';

export type DiagnosticEvidence = {
  file: string;
  line?: number;
  column?: number;
  value?: unknown;
};

export type CatalogDiagnostic = {
  code: CatalogDiagnosticCode;
  severity: CatalogDiagnosticSeverity;
  message: string;
  file?: string;
  path?: string;
  evidence?: DiagnosticEvidence;
};

export type LegacyCatalogRow = {
  name: string;
  bucket: string;
  slug: string;
  path: string;
  exported: string;
  tags: string[];
};

export type LegacyCatalogInventory = {
  schemaVersion: ContractVersion;
  rootPath: string;
  catalogPath: string;
  taxonomyPath: string;
  registryPath: string | null;
  resolution: CatalogResolution;
  entries: LegacyCatalogRow[];
  entryCount: number;
  uniquePathCount: number;
  diagnostics: CatalogDiagnostic[];
  counts: {
    entries: number;
    uniquePaths: number;
    invalidManifests: number;
    metadataDisagreements: number;
    missingIndexes: number;
    registrySlugs: number;
    registryMissing: number;
  };
  catalogHash: string | null;
  taxonomyHash: string | null;
  corpusHash: string | null;
};
