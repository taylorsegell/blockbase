import type { ComponentManifest, SourceEnvelope } from '@blockbase/contracts';

export type LocalImportInput = string | { source: string; stdin?: string };

export type ImportOptions = {
  catalogRoot: string;
  namespace?: string;
  slug?: string;
  displayName?: string;
  manifest?: ComponentManifest;
  entryPoint?: string;
  stdin?: string;
  /** Optimistic concurrency guard for an existing component package. */
  expectedRevision?: string;
  /** Optimistic metadata-version guard for an existing component package. */
  expectedManifestVersion?: number;
  /** Test-only failure injection at named atomic commit boundaries. */
  onCommitStep?: (step: CommitStep) => void;
};

export type CommitStep = 'staged' | 'revision-renamed' | 'manifest-written' | 'package-renamed';

export type IntegrityRecord = {
  sourceHash: string;
  fileHashes: Record<string, string>;
  assetHashes: Record<string, string>;
};

export type ImportedRevision = {
  envelope: SourceEnvelope;
  manifest: ComponentManifest;
  revisionId: string;
  integrity: IntegrityRecord;
  packagePath: string;
  componentPath: string;
  revisionPath: string;
};

export type SourceContent = {
  envelope: SourceEnvelope;
  /** Raw asset bytes are retained internally because SourceAsset is hash-only by contract. */
  assetBytes: Map<string, Uint8Array>;
};
