import type { ComponentManifest, ContractVersion } from '@blockbase/contracts';

/**
 * Provenance stamp for the legacy-catalog migration heuristics (row shape,
 * entry-point detection, conflict policy). It is folded into `migrationId`
 * so a deliberate bump changes plan identity, which `--resume` then detects
 * via `expectedMigrationId`. It does not track `HEAD`; bump it only after
 * re-validating the heuristics against a real corpus.
 */
export const LEGACY_PINNED_REVISION = '93b3daf8995bbcb203a7f8e72c192782dceb1f34';

/**
 * Optional structural-audit anchor: the revision whose `catalog.yaml` the
 * current catalog is diffed against to surface family reorganizations.
 * Resolved with `git show <rev>:catalog.yaml` in the source repository; when
 * the revision is absent (any repository other than the one it was recorded
 * in), the audit is skipped and the plan reports no structural changes.
 * Override per run with `baselineRevision` or `baselineCatalogPath`.
 */
export const LEGACY_ORIGINAL_BASELINE = '1d8397d1cc175267da9086d1e9000cda63691c8c';

export type MigrationMode = 'plan' | 'apply' | 'resume';
export type MigrationDisposition = 'migrate' | 'skip' | 'block';
export type MigrationEntryStatus = 'ready' | 'already-present' | 'applied' | 'skipped' | 'blocked';

export type MigrationHashInventory = {
  catalogHash: string | null;
  taxonomyHash: string | null;
  corpusHash: string | null;
  files: Record<string, string>;
};

export type MigrationConflictResolution = {
  code: string;
  identity: string;
  path?: string;
  resolution: string;
  authority: 'catalog' | 'filed-source' | 'preview-registry' | 'policy';
  requiredDecision: boolean;
  details?: Record<string, unknown>;
};

export type StructuralRowChange = {
  identity: string;
  before: { name: string; bucket: string; path: string };
  after: { name: string; bucket: string; path: string };
  changedFields: Array<'name' | 'bucket' | 'path'>;
  resolution: 'preserve-current-catalog-row';
  reviewRequired: true;
};

export type MigrationEntryPlan = {
  identity: string;
  source: { name: string; bucket: string; slug: string; path: string; exported: string; tags: string[] };
  target: { componentId: string; namespace: string; slug: string; packagePath: string };
  revisionId: string | null;
  sourceHash: string | null;
  sourceFiles: string[];
  entryPoint?: string;
  disposition: MigrationDisposition;
  status: MigrationEntryStatus;
  conflicts: string[];
  skips: string[];
  requiredDecisions: string[];
  provenance: {
    sourceType: 'legacy-filed' | 'unavailable';
    locator: string;
    byteIdentityClaim: false;
    limitation: string;
  };
  manifest?: ComponentManifest;
  diagnostics: string[];
};

export type MigrationPlan = {
  schemaVersion: ContractVersion;
  mode: 'plan';
  migrationId: string;
  pinnedRevision: string;
  sourceRevision: string | null;
  sourceRoot: string;
  targetRoot: string;
  source: MigrationHashInventory;
  target: { existingComponentCount: number; existingIndex: boolean };
  entries: MigrationEntryPlan[];
  structuralChanges: StructuralRowChange[];
  conflictResolutions: MigrationConflictResolution[];
  writes: string[];
  skips: Array<{ identity: string; reason: string; path?: string }>;
  blocked: Array<{ identity: string; reason: string; path?: string }>;
  requiredDecisions: string[];
  rollbackPrerequisite: MigrationRollbackPrerequisite;
  policy: {
    metadataAuthority: 'catalog';
    filedSourceType: 'legacy-filed';
    sourceMutation: 'forbidden';
    previewRegistration: 'missing-registration-is-skipped';
    sharedPath: 'duplicate-packages';
  };
};

export type MigrationRollbackPrerequisite = {
  // Always false: plan, apply, and resume never write to sourceRoot. Encoded
  // as a literal (not a runtime-computed boolean) so a future change that
  // starts mutating the source cannot accidentally leave this claim stale
  // without a type-level edit here.
  sourceMutated: false;
  action: 'delete-target-root';
  targetRoot: string;
  reportPath: string | null;
  note: string;
};

export type MigrationAuditRecord = {
  sequence: number;
  identity: string;
  disposition: MigrationDisposition;
  action: 'committed' | 'already-present' | 'skipped' | 'blocked';
  revisionId: string | null;
  packagePath: string;
  reasons: string[];
};

export type MigrationResult = Omit<MigrationPlan, 'mode' | 'blocked'> & {
  mode: 'apply' | 'resume';
  status: 'complete' | 'partial' | 'blocked';
  blocked: MigrationPlan['blocked'];
  before: MigrationHashInventory;
  after: MigrationHashInventory;
  audit: MigrationAuditRecord[];
  index?: { indexPath: string; catalogRevision: string; componentCount: number };
  reportPath?: string;
  idempotent: boolean;
};

export type MigrationOptions = {
  sourceRoot: string;
  targetRoot: string;
  catalogPath?: string;
  taxonomyPath?: string;
  registryPath?: string | null;
  baselineCatalogPath?: string;
  baselineRevision?: string;
  reportPath?: string;
  expectedMigrationId?: string;
};
