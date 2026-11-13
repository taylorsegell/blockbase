import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import { CONTRACT_VERSION, stableStringify, type ComponentManifest, type SourceEnvelope } from '@blockbase/contracts';
import { readLegacyCatalog, type LegacyCatalogInventory, type LegacyCatalogRow } from '../catalog/index.js';
import { chooseEntryPoint } from '../catalog/entry-point.js';
import { rebuildIndex } from '../index/index.js';
import { RevisionStore } from '../store/revisions/store.js';
import { recordCatalogOperation } from '../store/history/git.js';
import { canonicalizeSourceEnvelope, revisionHash, sha256 } from '../import/local.js';
import type { SourceContent } from '../import/types.js';
import {
  LEGACY_ORIGINAL_BASELINE,
  LEGACY_PINNED_REVISION,
  type MigrationAuditRecord,
  type MigrationConflictResolution,
  type MigrationEntryPlan,
  type MigrationHashInventory,
  type MigrationOptions,
  type MigrationPlan,
  type MigrationResult,
  type MigrationRollbackPrerequisite,
  type StructuralRowChange,
} from './types.js';

const TEXT_EXTENSIONS = new Set(['.css', '.js', '.jsx', '.json', '.mjs', '.ts', '.tsx', '.md', '.txt', '.yaml', '.yml']);
const FILED_LIMITATION = 'The upstream original is unavailable; preserved bytes are legacy-filed input and do not establish byte identity to an upstream source.';

function identity(row: LegacyCatalogRow): string {
  return `${row.name}/${row.slug}`;
}

function safePart(value: string): string {
  const result = value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return result || 'legacy';
}

function safeSegment(value: string): boolean {
  return Boolean(value) && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\') && !value.includes('\0');
}

function componentId(row: LegacyCatalogRow): string {
  return `cmp_${safePart(row.name)}_${safePart(row.slug)}`;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function regularFiles(root: string): Promise<{ files: string[]; symlinks: string[] }> {
  const files: string[] = [];
  const symlinks: string[] = [];
  async function visit(path: string): Promise<void> {
    const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) symlinks.push(child);
      else if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) files.push(child);
    }
  }
  await visit(root);
  return { files, symlinks };
}

async function readFiledSource(root: string, row: LegacyCatalogRow): Promise<{ content: SourceContent; sourceFiles: string[]; entryPoint?: string; symlinks: string[] }> {
  const componentRoot = resolve(root, row.path);
  const info = await stat(componentRoot);
  if (!info.isDirectory()) throw new Error(`Component path '${row.path}' is not a directory.`);
  const collected = await regularFiles(componentRoot);
  const files = collected.files.map((path) => ({ absolute: path, path: relative(componentRoot, path).split(sep).join('/') }));
  const sourceFiles = files.filter((file) => TEXT_EXTENSIONS.has(extname(file.path).toLowerCase()));
  const assets = files.filter((file) => !TEXT_EXTENSIONS.has(extname(file.path).toLowerCase()));
  const entryPoint = chooseEntryPoint(sourceFiles.map((file) => file.path).filter((path) => /\.(?:tsx|jsx|ts|js)$/.test(path)));
  const sourceEnvelope: SourceEnvelope = {
    schemaVersion: CONTRACT_VERSION,
    sourceType: 'directory',
    files: await Promise.all(sourceFiles.map(async (file) => {
      const content = await readFile(file.absolute, 'utf8');
      return { path: file.path, content, contentHash: sha256(content) };
    })),
    assets: await Promise.all(assets.map(async (file) => ({ path: file.path, mediaType: 'application/octet-stream', contentHash: sha256(await readFile(file.absolute)) }))),
    ...(entryPoint ? { entryPoint } : {}),
    provenance: { sourceType: 'directory', locator: componentRoot },
  };
  const assetBytes = new Map<string, Uint8Array>();
  for (const file of assets) assetBytes.set(file.path, await readFile(file.absolute));
  return { content: { envelope: canonicalizeSourceEnvelope(sourceEnvelope), assetBytes }, sourceFiles: files.map((file) => file.path), ...(entryPoint ? { entryPoint } : {}), symlinks: collected.symlinks };
}

function manifestFor(row: LegacyCatalogRow, source: SourceContent, revisionId: string, warnings: string[]): ComponentManifest {
  const displayName = row.exported || row.slug;
  const language = source.envelope.files.some((file) => /\.tsx?$/.test(file.path)) ? 'typescript' : 'javascript';
  return {
    schemaVersion: CONTRACT_VERSION,
    componentId: componentId(row),
    namespace: row.name,
    slug: row.slug,
    displayName,
    description: `Legacy-filed component preserved from ${row.path}.`,
    aliases: [],
    tags: [...row.tags].sort(),
    category: row.name,
    framework: 'react',
    stylingModes: source.envelope.files.some((file) => /\.css$/.test(file.path)) ? ['css'] : [],
    currentRevision: revisionId,
    ...(source.envelope.entryPoint ? { entryPoint: source.envelope.entryPoint } : {}),
    provenance: { sourceType: 'legacy-filed', locator: row.path, license: 'unknown', attributionStatus: 'unknown' },
    compatibility: { language, runtime: 'react', frameworkRange: '*', clientServer: 'either' },
    interface: { props: [], slots: [], events: [], accessibilityNotes: [] },
    dependencies: [],
    tokens: { schemaVersion: CONTRACT_VERSION, contractId: `tokens_${safePart(row.name)}_${safePart(row.slug)}_v1`, tokens: [] },
    quality: {
      parseStatus: warnings.length > 0 ? 'partial' : 'passed',
      previewStatus: 'unknown',
      normalizationCoverage: 0,
      riskLevel: warnings.length > 0 ? 'high' : 'medium',
      warnings: [...new Set([FILED_LIMITATION, ...warnings])].sort(),
    },
    // RevisionStore preserves the canonical asset-path order in its integrity
    // projection; retain that order so an identical apply is a no-op.
    integrity: { sourceHash: revisionId, assetHashes: source.envelope.assets.map((asset) => asset.contentHash) },
  };
}

async function fileHash(path: string): Promise<string | null> {
  try { return sha256(await readFile(path)); } catch { return null; }
}

async function hashInventory(inventory: LegacyCatalogInventory): Promise<MigrationHashInventory> {
  const files = new Map<string, string>();
  const add = async (path: string): Promise<void> => {
    const hash = await fileHash(path);
    if (hash) files.set(relative(inventory.rootPath, path).split(sep).join('/'), hash);
  };
  await add(inventory.catalogPath);
  await add(inventory.taxonomyPath);
  if (inventory.registryPath) await add(inventory.registryPath);
  for (const row of inventory.entries) {
    const root = resolve(inventory.rootPath, row.path);
    if (!existsSync(root)) continue;
    const collected = await regularFiles(root).catch(() => ({ files: [], symlinks: [] }));
    for (const path of collected.files) await add(path);
  }
  return { catalogHash: inventory.catalogHash, taxonomyHash: inventory.taxonomyHash, corpusHash: inventory.corpusHash, files: Object.fromEntries([...files.entries()].sort(([a], [b]) => a.localeCompare(b))) };
}

function diagnosticsFor(inventory: LegacyCatalogInventory, row: LegacyCatalogRow): string[] {
  return inventory.diagnostics.filter((item) => item.path === row.path || item.path === row.slug || item.path === identity(row)).map((item) => item.code).sort();
}

function conflictResolution(row: LegacyCatalogRow, codes: string[], registryMissing: boolean): MigrationConflictResolution[] {
  const results: MigrationConflictResolution[] = [];
  const add = (code: string, resolution: string, authority: MigrationConflictResolution['authority'], details?: Record<string, unknown>) => results.push({ code, identity: identity(row), path: row.path, resolution, authority, requiredDecision: false, ...(details ? { details } : {}) });
  for (const code of codes) {
    if (code === 'catalog.metadata_invalid_yaml') add(code, 'Use catalog row fields and retain filed source; metadata is not authoritative.', 'catalog');
    else if (code === 'catalog.metadata_disagreement') add(code, 'Use catalog row fields as the canonical identity, bucket, path, and tags.', 'catalog');
    else if (code === 'catalog.missing_index') add(code, 'Choose the lexicographically first supported source file as the entry point.', 'filed-source');
    else if (code === 'catalog.registry_missing') add(code, 'Migrate the package and skip preview registration until a projection exists.', 'preview-registry');
    else if (code === 'catalog.shared_path_exception') add(code, 'Create distinct packages for each identity while reading the shared source path once.', 'policy');
    else add(code, 'Retain the source unchanged and block only if the target cannot be safely addressed.', 'policy');
  }
  if (registryMissing && !codes.includes('catalog.registry_missing')) add('catalog.registry_missing', 'Migrate the package and skip preview registration until a projection exists.', 'preview-registry');
  return results;
}

function baselineRows(sourceRoot: string, options: MigrationOptions): LegacyCatalogRow[] {
  let text: string | undefined;
  if (options.baselineCatalogPath) {
    try { text = requireText(options.baselineCatalogPath); } catch { text = undefined; }
  } else {
    try {
      text = execFileSync('git', ['show', `${options.baselineRevision ?? LEGACY_ORIGINAL_BASELINE}:catalog.yaml`], { cwd: sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { text = undefined; }
  }
  if (!text) return [];
  try {
    const value = parse(text) as { blocks?: unknown[] };
    return (value.blocks ?? []).flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const row = item as Record<string, unknown>;
      return [
        { name: String(row.name ?? ''), bucket: String(row.bucket ?? ''), slug: String(row.slug ?? ''), path: String(row.path ?? ''), exported: String(row.exported ?? ''), tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : [] },
      ];
    });
  } catch { return []; }
}

function requireText(path: string): string {
  // This helper keeps baseline loading synchronous so git and explicit-file sources use the same deterministic path.
  return readFileSync(path, 'utf8');
}

function structuralChanges(current: LegacyCatalogRow[], baseline: LegacyCatalogRow[]): StructuralRowChange[] {
  // Slugs are the stable row key across family moves; using name/slug here
  // would miss the very family changes this audit is intended to preserve.
  const prior = new Map(baseline.map((row) => [row.slug, row]));
  return current.flatMap((row) => {
    const before = prior.get(row.slug);
    if (!before) return [];
    const changedFields = (['name', 'bucket', 'path'] as const).filter((field) => before[field] !== row[field]);
    return changedFields.length === 0 ? [] : [{ identity: identity(row), before: { name: before.name, bucket: before.bucket, path: before.path }, after: { name: row.name, bucket: row.bucket, path: row.path }, changedFields: [...changedFields], resolution: 'preserve-current-catalog-row' as const, reviewRequired: true as const }];
  }).sort((a, b) => a.identity.localeCompare(b.identity));
}

async function targetState(targetRoot: string): Promise<{ existingComponentCount: number; existingIndex: boolean }> {
  const components = join(targetRoot, 'components');
  const namespaces = await readdir(components, { withFileTypes: true }).catch(() => []);
  let count = 0;
  for (const namespace of namespaces) if (namespace.isDirectory()) count += (await readdir(join(components, namespace.name), { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).length;
  return { existingComponentCount: count, existingIndex: existsSync(join(targetRoot, 'index.sqlite')) };
}

function assertTargetOutsideSource(options: Pick<MigrationOptions, 'sourceRoot' | 'targetRoot'>): void {
  const sourceRoot = resolve(options.sourceRoot);
  const targetRoot = resolve(options.targetRoot);
  if (targetRoot === sourceRoot || targetRoot.startsWith(`${sourceRoot}${sep}`)) {
    throw new Error('The migration target must be outside the read-only legacy source root.');
  }
}

export async function planLegacyMigration(options: MigrationOptions): Promise<MigrationPlan> {
  assertTargetOutsideSource(options);
  const sourceRoot = resolve(options.sourceRoot);
  const targetRoot = resolve(options.targetRoot);
  const inventory = readLegacyCatalog({ rootPath: sourceRoot, catalog: options.catalogPath ?? join(sourceRoot, 'catalog.yaml'), taxonomyPath: options.taxonomyPath, registryPath: options.registryPath });
  const source = await hashInventory(inventory);
  const target = await targetState(targetRoot);
  const entries: MigrationEntryPlan[] = [];
  const conflictResolutions: MigrationConflictResolution[] = [];
  const skips: MigrationPlan['skips'] = [];
  const blocked: MigrationPlan['blocked'] = [];
  for (const row of inventory.entries) {
    const codes = diagnosticsFor(inventory, row);
    const resolutions = conflictResolution(row, codes, inventory.diagnostics.some((item) => item.code === 'catalog.registry_missing' && item.path === row.slug));
    conflictResolutions.push(...resolutions);
    const targetSafe = safeSegment(row.name) && safeSegment(row.slug);
    const targetPackagePath = join(targetRoot, 'components', targetSafe ? row.name : safePart(row.name), targetSafe ? row.slug : safePart(row.slug));
    const entry: MigrationEntryPlan = {
      identity: identity(row), source: { ...row, tags: [...row.tags] }, target: { componentId: componentId(row), namespace: row.name, slug: row.slug, packagePath: targetPackagePath }, revisionId: null,
      sourceFiles: [], sourceHash: null, ...(codes.includes('catalog.missing_index') ? {} : {}), disposition: 'migrate', status: 'ready', conflicts: codes, skips: [], requiredDecisions: [], provenance: { sourceType: 'unavailable', locator: row.path, byteIdentityClaim: false, limitation: FILED_LIMITATION }, diagnostics: [],
    };
    try {
      if (!targetSafe) throw new Error('Catalog identity contains an unsafe namespace or slug segment.');
      const filed = await readFiledSource(sourceRoot, row);
      entry.sourceFiles = filed.sourceFiles;
      if (filed.entryPoint) entry.entryPoint = filed.entryPoint;
      if (filed.symlinks.length > 0) throw new Error(`Symlinked source files are not accepted: ${filed.symlinks.map((path) => relative(sourceRoot, path)).join(', ')}`);
      if (!filed.entryPoint) throw new Error('No supported source entry point exists.');
      const revisionId = revisionHash(filed.content.envelope);
      entry.revisionId = revisionId;
      entry.sourceHash = revisionId;
      entry.provenance = { sourceType: 'legacy-filed', locator: row.path, byteIdentityClaim: false, limitation: FILED_LIMITATION };
      const warnings = [...codes.filter((code) => code !== 'catalog.registry_missing').map((code) => `Resolved legacy diagnostic ${code}.`), ...(codes.includes('catalog.registry_missing') ? ['Preview registration is intentionally skipped because no registry entry exists.'] : [])];
      entry.manifest = manifestFor(row, filed.content, revisionId, warnings);
      if (codes.includes('catalog.registry_missing')) { entry.skips.push('preview-registration-missing'); skips.push({ identity: identity(row), reason: 'catalog.registry_missing', path: row.path }); }
    } catch (error) {
      entry.disposition = 'block'; entry.status = 'blocked'; entry.provenance.sourceType = 'unavailable'; entry.diagnostics.push(error instanceof Error ? error.message : String(error)); blocked.push({ identity: identity(row), reason: entry.diagnostics[0], path: row.path });
    }
    entries.push(entry);
  }
  const baseline = baselineRows(sourceRoot, options);
  const migrationId = `mig_${hashText(stableStringify({ pinnedRevision: LEGACY_PINNED_REVISION, source: source.corpusHash, targetRoot, entries: entries.map((entry) => ({ identity: entry.identity, revisionId: entry.revisionId, disposition: entry.disposition })) })).slice(0, 24)}`;
  const rollbackPrerequisite: MigrationRollbackPrerequisite = {
    sourceMutated: false,
    action: 'delete-target-root',
    targetRoot,
    reportPath: null,
    note: 'The legacy source root is never written by plan, apply, or resume (see policy.sourceMutation). Rolling back a migration requires no source restoration: delete targetRoot (and, if present, reportPath) and re-run apply from a clean target.',
  };
  const plan: MigrationPlan = {
    schemaVersion: CONTRACT_VERSION, mode: 'plan', migrationId, pinnedRevision: LEGACY_PINNED_REVISION, sourceRevision: (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } })(), sourceRoot, targetRoot, source, target, entries,
    structuralChanges: structuralChanges(inventory.entries, baseline), conflictResolutions: conflictResolutions.sort((a, b) => `${a.identity}\0${a.code}`.localeCompare(`${b.identity}\0${b.code}`)), writes: entries.filter((entry) => entry.disposition === 'migrate').flatMap((entry) => [join(entry.target.packagePath, 'component.json'), join(entry.target.packagePath, 'revisions', (entry.revisionId ?? 'pending').replace(/^sha256:/, ''), 'original')]).concat(entries.some((entry) => entry.disposition === 'migrate') ? [join(targetRoot, 'index.sqlite')] : []).sort(), skips, blocked, requiredDecisions: [], rollbackPrerequisite, policy: { metadataAuthority: 'catalog', filedSourceType: 'legacy-filed', sourceMutation: 'forbidden', previewRegistration: 'missing-registration-is-skipped', sharedPath: 'duplicate-packages' },
  };
  if (options.expectedMigrationId && options.expectedMigrationId !== plan.migrationId) throw new Error(`Migration plan identity changed: expected ${options.expectedMigrationId}, received ${plan.migrationId}.`);
  return plan;
}

async function readExistingManifest(path: string): Promise<Record<string, unknown> | undefined> {
  try { return JSON.parse(await readFile(join(path, 'component.json'), 'utf8')) as Record<string, unknown>; } catch { return undefined; }
}

function sameManifest(existing: Record<string, unknown>, planned: ComponentManifest): boolean {
  const copy = { ...existing } as Record<string, unknown>;
  delete copy.manifestVersion;
  return stableStringify(copy) === stableStringify(planned);
}

function migrationSummary(result: MigrationResult): string {
  const committed = result.audit.filter((item) => item.action === 'committed').length;
  return `catalog migrate ${result.migrationId} ${result.status} (${committed} committed, ${result.blocked.length} blocked)`;
}

export async function applyLegacyMigration(options: MigrationOptions, mode: 'apply' | 'resume' = 'apply'): Promise<MigrationResult> {
  assertTargetOutsideSource(options);
  // Create the target first so history starts before the migration and records it as its own commit.
  await mkdir(options.targetRoot, { recursive: true });
  return recordCatalogOperation<MigrationResult>(options.targetRoot, { operation: 'catalog.migrate', summary: migrationSummary }, () => writeLegacyMigration(options, mode));
}

async function writeLegacyMigration(options: MigrationOptions, mode: 'apply' | 'resume'): Promise<MigrationResult> {
  const plan = await planLegacyMigration(options);
  const before = plan.source;
  const audit: MigrationAuditRecord[] = [];
  const store = new RevisionStore({ catalogRoot: plan.targetRoot });
  await mkdir(plan.targetRoot, { recursive: true });
  for (const [index, entry] of plan.entries.entries()) {
    if (entry.disposition === 'block' || !entry.manifest || !entry.revisionId) {
      audit.push({ sequence: index + 1, identity: entry.identity, disposition: 'block', action: 'blocked', revisionId: entry.revisionId, packagePath: entry.target.packagePath, reasons: entry.diagnostics });
      continue;
    }
    const existing = await readExistingManifest(entry.target.packagePath);
    if (existing && existing.currentRevision !== entry.revisionId) {
      entry.disposition = 'block'; entry.status = 'blocked'; entry.diagnostics.push('Target package already contains a different immutable revision.');
      audit.push({ sequence: index + 1, identity: entry.identity, disposition: 'block', action: 'blocked', revisionId: entry.revisionId, packagePath: entry.target.packagePath, reasons: [...entry.diagnostics] });
      continue;
    }
    if (existing && sameManifest(existing, entry.manifest)) {
      entry.status = 'already-present';
      audit.push({ sequence: index + 1, identity: entry.identity, disposition: 'migrate', action: 'already-present', revisionId: entry.revisionId, packagePath: entry.target.packagePath, reasons: [] });
      continue;
    }
    try {
      const filed = await readFiledSource(plan.sourceRoot, entry.source);
      const committed = await store.commit(filed.content, entry.manifest);
      entry.status = 'applied';
      audit.push({ sequence: index + 1, identity: entry.identity, disposition: 'migrate', action: 'committed', revisionId: committed.revisionId, packagePath: committed.packagePath, reasons: [] });
    } catch (error) {
      entry.disposition = 'block'; entry.status = 'blocked'; entry.diagnostics.push(error instanceof Error ? error.message : String(error));
      audit.push({ sequence: index + 1, identity: entry.identity, disposition: 'block', action: 'blocked', revisionId: entry.revisionId, packagePath: entry.target.packagePath, reasons: [...entry.diagnostics] });
    }
  }
  const blocked = plan.entries.filter((entry) => entry.disposition === 'block').map((entry) => ({ identity: entry.identity, reason: entry.diagnostics[0] ?? 'Migration entry blocked.', path: entry.source.path }));
  plan.blocked = blocked;
  const indexResult = await rebuildIndex({ catalogRoot: plan.targetRoot });
  const after = await hashInventory(readLegacyCatalog({ rootPath: plan.sourceRoot, catalog: options.catalogPath ?? join(plan.sourceRoot, 'catalog.yaml'), taxonomyPath: options.taxonomyPath, registryPath: options.registryPath }));
  const result: MigrationResult = { ...plan, mode, status: blocked.length > 0 ? (audit.some((item) => item.action === 'committed' || item.action === 'already-present') ? 'partial' : 'blocked') : 'complete', before, after, audit, index: { indexPath: indexResult.indexPath, catalogRevision: indexResult.catalogRevision, componentCount: indexResult.componentCount }, idempotent: before.corpusHash === after.corpusHash && audit.every((item) => item.action !== 'committed' || item.revisionId !== null) };
  const reportPath = options.reportPath ?? join(plan.targetRoot, 'migration-report.json');
  result.reportPath = resolve(reportPath);
  result.rollbackPrerequisite = { ...result.rollbackPrerequisite, reportPath: result.reportPath };
  await mkdir(dirname(result.reportPath), { recursive: true });
  await writeFile(result.reportPath, stableStringify(result));
  return result;
}

export async function resumeLegacyMigration(options: MigrationOptions & { reportPath: string }): Promise<MigrationResult> {
  let expectedMigrationId: string | undefined;
  try { expectedMigrationId = (JSON.parse(await readFile(options.reportPath, 'utf8')) as { migrationId?: string }).migrationId; } catch { /* resume can recover from a missing report by replanning */ }
  return applyLegacyMigration({ ...options, expectedMigrationId, reportPath: options.reportPath }, 'resume');
}
