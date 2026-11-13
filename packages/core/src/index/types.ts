import type { ComponentManifest, ContractVersion, ProjectProfile } from '@blockbase/contracts';

export type IndexOptions = {
  catalogRoot: string;
  indexPath?: string;
  /** SQLite waits briefly for a supported reader before returning SQLITE_BUSY. */
  busyTimeoutMs?: number;
  /** Runs SQLite's full-file quick_check on open. Costs a scan of the whole index, so only diagnostics ask for it. */
  verify?: boolean;
  onProgress?: (progress: IndexRebuildProgress) => void | Promise<void>;
};

export type IndexRebuildProgress = {
  phase: 'scan' | 'symbols' | 'write' | 'publish';
  completed: number;
  total: number;
  componentId?: string;
};

export type CompatibilityInput = {
  framework?: string;
  language?: string;
  runtime?: string;
  stylingModes?: string[];
  project?: Pick<ProjectProfile, 'framework' | 'language' | 'styling' | 'dependencies'>;
};

export type IndexRow = {
  componentId: string;
  namespace: string;
  slug: string;
  displayName: string;
  description: string;
  aliases: string[];
  tags: string[];
  category: string;
  framework: string;
  stylingModes: string[];
  currentRevision: string;
  favorite: boolean;
  sourcePath: string;
  manifest: ComponentManifest;
};

export type IndexRebuildResult = {
  schemaVersion: ContractVersion;
  indexPath: string;
  catalogRevision: string;
  indexSchemaVersion: number;
  searchableContentHash: string;
  componentCount: number;
  projectionCounts: {
    components: number;
    tags: number;
    favorites: number;
    compatibility: number;
  };
  source: 'manifests';
};

export type IndexStatus = {
  indexPath: string;
  healthy: boolean;
  classification: 'healthy' | 'missing' | 'malformed' | 'schema-mismatch' | 'incomplete';
  schemaVersion?: number;
  catalogRevision?: string;
  recoveryAction: { id: string; label: string; safe: boolean; command: string };
  cause?: string;
};

export type SearchEvidence = {
  field: string;
  value: string;
  matchedTerms: string[];
};

export type SearchResult = {
  componentId: string;
  revisionId: string;
  displayName: string;
  namespace: string;
  slug: string;
  favorite: boolean;
  score: number;
  evidence: SearchEvidence[];
  compatibility: {
    matched: string[];
    conflicts: string[];
  };
};

export type SearchSelection = {
  status: 'selected' | 'needs-selection' | 'miss';
  selectedComponentId?: string;
  confidenceMargin: number;
  margin: number | null;
};

export type SearchResponse = {
  schemaVersion: ContractVersion;
  query: string;
  catalogRevision: string;
  results: SearchResult[];
  selection: SearchSelection;
  recoveryActions: Array<{ id: string; label: string; safe: boolean; command?: string }>;
};

export type ComponentInspection = {
  schemaVersion: ContractVersion;
  componentId: string;
  revisionId: string;
  manifest: ComponentManifest;
  packagePath: string;
  revisionPath: string;
  evidence: Array<{ field: string; path: string; value: string }>;
  lookup: { input: string; matchedBy: 'id' | 'alias'; exact: true };
};

export type SearchOptions = {
  limit?: number;
  confidenceMargin?: number;
  compatibility?: CompatibilityInput;
};
