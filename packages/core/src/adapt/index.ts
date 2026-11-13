import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import {
  CONTRACT_VERSION,
  parseAdaptationBundle,
  parseComponentManifest,
  type AdaptationBundle,
  type AdaptedFile,
  type ComponentManifest,
  type DependencyDelta,
  type ProjectProfile,
  type SourceAsset,
  type SourceEnvelope,
  type TokenMapping,
} from '@blockbase/contracts';
import { inspectComponent } from '../search/service.js';
import { normalizeSource, type DependencyRecord, type NormalizationResult } from '../normalize/index.js';
import type { TokenOccurrence } from '../tokens/index.js';
import { inspectProject } from '../project/inspect.js';
import { resolveEntryPoint } from '../catalog/entry-point.js';
import { sha256 } from '../import/local.js';
import { stableStringify } from '@blockbase/contracts';
import type { RemoteCatalogClient } from '../remote/client.js';

/**
 * `catalogRoot` (local disk) and `catalogSource` (an already-constructed {@link CatalogSource},
 * e.g. a {@link RemoteCatalogSource}) are alternatives — exactly one must resolve for
 * `prepareComponentAdaptation`/`applyAdaptation` to look up a component. `catalogRoot` stays the
 * default/back-compat path (existing callers, e.g. `packages/mcp/src/server.ts`, only ever set
 * this) and is wrapped in a `LocalCatalogSource` internally when `catalogSource` is not supplied.
 * Nothing here ever accepts or forwards `projectPath` into a `CatalogSource` call — catalog
 * resolution and destination-project work stay on separate inputs.
 */
export type AdaptationOptions = {
  catalogRoot?: string;
  catalogSource?: CatalogSource;
  projectPath: string;
  revision?: string;
  outDir?: string;
};
export type AdaptationRequest = AdaptationOptions & { componentId: string };

export type AdaptationPlan = {
  schemaVersion: typeof CONTRACT_VERSION;
  bundleId: string;
  projectPath: string;
  revisionId: string;
  files: Array<{ path: string; operation: AdaptedFile['operation']; contentHash: string; targetHash?: string }>;
  dependencyDelta: DependencyDelta;
  writes: string[];
  blocked: string[];
};

export class AdaptationError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AdaptationError';
    this.code = code;
    this.details = details;
  }
}

function safeRelative(path: string): string {
  const normalized = path.split(sep).join('/');
  if (!normalized || normalized.startsWith('../') || normalized.includes('/../') || normalized === '..' || normalized.startsWith('/')) {
    throw new AdaptationError('ADAPT_INVALID_TARGET', 'An adapted file path escapes the destination project.', { path });
  }
  return normalized;
}

async function readSourceFiles(root: string): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];
  async function visit(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push({ path: relative(root, path).split(sep).join('/'), content: await readFile(path, 'utf8') });
    }
  }
  await visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Resolves inspect metadata and immutable source bytes for one component revision, independent
 * of whether the catalog lives on the laptop's disk or on a remote MCP server. This is the *only*
 * abstraction boundary this task introduces: everything downstream of `resolve()` (normalization,
 * token mapping, file placement, dependency deltas, staging, apply planning, writes, validation)
 * is unchanged and stays entirely on `AdaptationOptions.projectPath` / `AdaptationBundle.projectPath`
 * — a `CatalogSource` implementation only ever receives a `componentId` and an optional `revision`,
 * never a project path.
 */
export interface CatalogSource {
  /** Resolves the manifest and source files for `componentId` at `revision` (default: current). */
  resolve(componentId: string, revision?: string): Promise<CatalogSourceResolution>;
  /** Returns the component's current revision id, without fetching its source bytes. Used only for the apply-time stale-revision recheck. */
  currentRevision(componentId: string): Promise<string>;
}

export type CatalogSourceResolution = {
  componentId: string;
  revisionId: string;
  manifest: ComponentManifest;
  files: Array<{ path: string; content: string }>;
  assets: SourceAsset[];
};

/**
 * Wraps the existing on-disk lookup (`inspectComponent` + a fresh `component.json` re-read +
 * `readSourceFiles(original/)`) with zero behavior change from the pre-abstraction code: same
 * `ADAPT_INDEX_STALE`/`ADAPT_STALE_REVISION` checks, same file-read path, same empty `assets`
 * (local re-normalization has never read the separate `revisions/<id>/assets/` directory — only
 * `RemoteCatalogSource` below produces non-empty `assets` metadata).
 */
export class LocalCatalogSource implements CatalogSource {
  private readonly catalogRoot: string;

  constructor(catalogRoot: string) {
    this.catalogRoot = catalogRoot;
  }

  async resolve(componentId: string, revision?: string): Promise<CatalogSourceResolution> {
    const inspected = await inspectComponent(this.catalogRoot, componentId, revision);
    const onDiskManifest = parseComponentManifest(JSON.parse(await readFile(join(inspected.packagePath, 'component.json'), 'utf8')));
    if (onDiskManifest.currentRevision !== inspected.revisionId && !revision) {
      throw new AdaptationError('ADAPT_INDEX_STALE', 'The search index is stale; rebuild it before preparing an adaptation.', { componentId, indexed: inspected.revisionId, current: onDiskManifest.currentRevision });
    }
    if (revision && onDiskManifest.currentRevision !== revision) {
      throw new AdaptationError('ADAPT_STALE_REVISION', 'The requested component revision is no longer current.', { componentId, requested: revision, current: onDiskManifest.currentRevision });
    }
    const files = await readSourceFiles(join(inspected.revisionPath, 'original'));
    return { componentId: inspected.componentId, revisionId: inspected.revisionId, manifest: inspected.manifest, files, assets: [] };
  }

  async currentRevision(componentId: string): Promise<string> {
    const inspected = await inspectComponent(this.catalogRoot, componentId);
    const onDiskManifest = parseComponentManifest(JSON.parse(await readFile(join(inspected.packagePath, 'component.json'), 'utf8')));
    return onDiskManifest.currentRevision;
  }
}

/**
 * Wraps a `createRemoteCatalogClient` (task 5.2) instance's `inspect`/`getPackage` calls. Only
 * ever called with `componentId`/`revision` — never given, and never resolves, a local catalog
 * root or a project path. `getPackage` already verifies every file/asset path and content hash
 * (task 5.1's `parseRemoteComponentPackage`) before this class ever sees the package, so no
 * additional integrity checking happens here; this class only translates the already-verified
 * `RemoteComponentPackage` shape into the same `CatalogSourceResolution` shape `LocalCatalogSource`
 * produces, plus the one piece of business logic no lower layer can express: rejecting an
 * explicitly requested revision that the server reports is no longer current.
 */
export class RemoteCatalogSource implements CatalogSource {
  private readonly client: RemoteCatalogClient;

  constructor(client: RemoteCatalogClient) {
    this.client = client;
  }

  async resolve(componentId: string, revision?: string): Promise<CatalogSourceResolution> {
    const remotePackage = await this.client.getPackage(componentId, revision);
    if (revision !== undefined && remotePackage.manifest.currentRevision !== revision) {
      throw new AdaptationError('ADAPT_STALE_REVISION', 'The requested component revision is no longer current.', { componentId, requested: revision, current: remotePackage.manifest.currentRevision });
    }
    // Sorted to match LocalCatalogSource's readSourceFiles ordering exactly, so entry-point
    // detection (first tsx/jsx, or first file, when no index.* is present) and every other
    // order-sensitive step downstream behave identically regardless of catalog source.
    const files = remotePackage.files.map((file) => ({ path: file.path, content: file.content })).sort((a, b) => a.path.localeCompare(b.path));
    const assets: SourceAsset[] = remotePackage.assets.map((asset) => ({ path: asset.path, mediaType: asset.mediaType, contentHash: asset.contentHash }));
    return { componentId: remotePackage.componentId, revisionId: remotePackage.revisionId, manifest: remotePackage.manifest, files, assets };
  }

  async currentRevision(componentId: string): Promise<string> {
    const inspection = await this.client.inspect(componentId);
    return inspection.manifest.currentRevision;
  }
}

export function createLocalCatalogSource(catalogRoot: string): CatalogSource {
  return new LocalCatalogSource(catalogRoot);
}

export function createRemoteCatalogSource(client: RemoteCatalogClient): CatalogSource {
  return new RemoteCatalogSource(client);
}

/** Resolves the configured `CatalogSource` for `options`, preferring an explicit `catalogSource` over `catalogRoot`. */
function resolveCatalogSource(options: AdaptationOptions): CatalogSource {
  if (options.catalogSource) return options.catalogSource;
  if (options.catalogRoot) return new LocalCatalogSource(options.catalogRoot);
  throw new AdaptationError('ADAPT_MISSING_CATALOG_SOURCE', 'Either catalogRoot or catalogSource must be provided to prepare an adaptation.', {});
}

/** Resolves an optional `CatalogSource` for a stale-revision recheck (`applyAdaptation`); returns `undefined` when neither option is set, preserving the pre-abstraction "skip the recheck" behavior. */
function resolveOptionalCatalogSource(options: { catalogRoot?: string; catalogSource?: CatalogSource }): CatalogSource | undefined {
  if (options.catalogSource) return options.catalogSource;
  if (options.catalogRoot) return new LocalCatalogSource(options.catalogRoot);
  return undefined;
}

function hasTailwind(profile: ProjectProfile): boolean {
  return profile.styling.systems.includes('tailwind');
}

function variableCandidates(profile: ProjectProfile): string[] {
  return [...new Set([...Object.keys(profile.tokens.values), ...Object.keys(profile.tokens.aliases)])].sort();
}

function roleWords(role: string): string[] {
  return role.split('.').filter((word) => !['color', 'space', 'radius', 'font', 'shadow', 'motion', 'size'].includes(word));
}

function chooseDestinationToken(role: string, profile: ProjectProfile): string | undefined {
  const candidates = variableCandidates(profile);
  if (candidates.length === 0) return undefined;
  const words = roleWords(role);
  const scored = candidates.map((candidate) => {
    const lower = candidate.toLowerCase();
    let score = 0;
    for (const word of words) if (lower.includes(word)) score += 4;
    if (role.includes('surface') && /(surface|background|page|canvas|card)/.test(lower)) score += 3;
    if (role.includes('text.primary') && /(ink|foreground|content|text)/.test(lower)) score += 3;
    if (role.includes('text.muted') && /(muted|secondary|subtle)/.test(lower)) score += 3;
    if (role.includes('border') && /(border|divider|ring)/.test(lower)) score += 3;
    if (role.includes('action') && /(primary|accent|brand)/.test(lower)) score += 3;
    return { candidate, score };
  }).sort((a, b) => b.score - a.score || a.candidate.localeCompare(b.candidate));
  return scored[0]?.score ? scored[0].candidate : undefined;
}

function expressionFor(role: string, profile: ProjectProfile): string | undefined {
  const sourceVar = role.includes('surface.default') ? ['--background', '--surface', '--color-surface']
    : role.includes('surface.elevated') ? ['--card', '--surface-card']
      : role.includes('text.primary') ? ['--foreground', '--text', '--content-ink', '--color-ink']
        : role.includes('text.muted') ? ['--muted-foreground', '--muted', '--content-muted']
          : role.includes('border') ? ['--border', '--divider']
            : role.includes('action.primary') ? ['--primary', '--accent', '--brand'] : [];
  const known = variableCandidates(profile);
  const exact = sourceVar.find((name) => known.includes(name));
  const selected = exact ?? chooseDestinationToken(role, profile);
  return selected ? `var(${selected})` : undefined;
}

function utilityForExpression(utility: string, expression: string): string | undefined {
  const prefix = utility.match(/^(?:[a-z-]+:)*(bg|text|border|from|to|ring)-/)?.[1];
  if (prefix === 'bg' || prefix === 'from' || prefix === 'to') return `${prefix}-[${expression}]`;
  if (prefix === 'text') return `text-[${expression}]`;
  if (prefix === 'border' || prefix === 'ring') return `border-[${expression}]`;
  return undefined;
}

function helperReplacement(content: string, profile: ProjectProfile): string {
  const sourceClsx = /from\s*(['"])clsx\1/.test(content);
  const sourceClassnames = /from\s*(['"])classnames\1/.test(content);
  if (sourceClsx && profile.dependencies.runtime.classnames) {
    return content
      .replace(/import\s*\{\s*clsx\s*\}\s*from\s*(['"])clsx\1/, "import classNames from 'classnames'")
      .replaceAll('clsx', 'classNames');
  }
  if (sourceClassnames && profile.dependencies.runtime.clsx) return content.replaceAll('classnames', 'clsx');
  return content;
}

function mapOccurrences(normalized: NormalizationResult, profile: ProjectProfile): { mappings: TokenMapping[]; expressions: Map<string, string> } {
  const roles = [...new Set(normalized.tokenContract.tokens.map((token) => token.name))].sort();
  const expressions = new Map<string, string>();
  const mappings: TokenMapping[] = [];
  for (const role of roles) {
    const expression = expressionFor(role, profile);
    if (expression) {
      expressions.set(role, expression);
      mappings.push({ sourceToken: role, destinationExpression: expression, confidence: 'high' });
    } else {
      const definition = normalized.tokenContract.tokens.find((token) => token.name === role);
      const fallback = definition?.fallbackValue ?? definition?.defaultValue ?? '';
      mappings.push({ sourceToken: role, destinationExpression: fallback, confidence: 'low' });
    }
  }
  return { mappings, expressions };
}

function replaceSourceTokens(content: string, occurrences: TokenOccurrence[], expressions: Map<string, string>, tailwind: boolean): string {
  let output = content;
  const unique = new Map<string, TokenOccurrence>();
  for (const occurrence of occurrences) if (occurrence.tokenName && !unique.has(`${occurrence.source}:${occurrence.tokenName}`)) unique.set(`${occurrence.source}:${occurrence.tokenName}`, occurrence);
  for (const occurrence of [...unique.values()].sort((a, b) => b.source.length - a.source.length || a.source.localeCompare(b.source))) {
    const expression = occurrence.tokenName ? expressions.get(occurrence.tokenName) : undefined;
    if (!expression) continue;
    const replacement = occurrence.kind === 'tailwind'
      ? (tailwind ? utilityForExpression(occurrence.source, expression) ?? occurrence.source : occurrence.source)
      : expression;
    if (replacement !== occurrence.source) output = output.replaceAll(occurrence.source, replacement);
  }
  return output;
}

function cssRule(occurrence: TokenOccurrence, expression: string): string | undefined {
  const utility = occurrence.source;
  if (utility.startsWith('bg-')) return `  background-color: ${expression};`;
  if (utility.startsWith('text-')) return `  color: ${expression};`;
  if (utility.startsWith('border-')) return `  border-color: ${expression};`;
  if (/^p(?:[trblxy])?-/.test(utility)) return `  padding: ${expression};`;
  if (/^m(?:[trblxy])?-/.test(utility)) return `  margin: ${expression};`;
  if (utility.startsWith('rounded')) return `  border-radius: ${expression};`;
  return undefined;
}

function dependencyDelta(normalized: NormalizationResult, manifest: ComponentManifest, profile: ProjectProfile): DependencyDelta {
  const sourceRanges = new Map(manifest.dependencies.filter((item) => item.kind !== 'local').map((item) => [item.name, item.range]));
  const add: DependencyDelta['add'] = [];
  const conflicts: string[] = [];
  for (const record of normalized.dependencyContract.dependencies.filter((item) => item.kind === 'third-party')) {
    const name = record.packageName ?? record.specifier;
    if ((name === 'clsx' && profile.dependencies.runtime.classnames) || (name === 'classnames' && profile.dependencies.runtime.clsx)) continue;
    if (profile.dependencies.runtime[name] || profile.dependencies.development[name]) continue;
    const range = sourceRanges.get(name) ?? '*';
    add.push({ name, range: range.startsWith('workspace:') ? '*' : range, kind: 'runtime' });
  }
  for (const dependency of manifest.dependencies.filter((item) => item.kind !== 'local')) {
    const installed = profile.dependencies.runtime[dependency.name] ?? profile.dependencies.development[dependency.name];
    if (installed && installed !== dependency.range && /^\d/.test(installed) && /^\d/.test(dependency.range)) conflicts.push(`${dependency.name}: destination ${installed} does not satisfy source ${dependency.range}`);
  }
  return { add: add.sort((a, b) => a.name.localeCompare(b.name)), remove: [], conflicts: conflicts.sort() };
}

// Catalog-only files that describe a block inside the catalog; they never belong in the app.
const CATALOG_ONLY_FILES = new Set(['meta.yaml', 'meta.yml', 'block.md']);
// Entry basenames too generic to identify a block once it sits in a project; renamed after the component.
const GENERIC_ENTRY_NAMES = new Set(['component']);

function isCatalogOnlyFile(relativePath: string): boolean {
  return !relativePath.includes('/') && CATALOG_ONLY_FILES.has(relativePath.toLowerCase());
}

function blockFolderName(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'block';
}

function componentFileName(slug: string): string {
  return blockFolderName(slug).split('-').filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join('');
}

function rewriteRelativeImport(content: string, fromStem: string, toStem: string): string {
  const escaped = fromStem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return content.replace(new RegExp(`(['"])\\./${escaped}(\\.[a-z]+)?\\1`, 'g'), (_match, quote: string, ext: string | undefined) => `${quote}./${toStem}${ext ?? ''}${quote}`);
}

/** Reads the destination's own path-alias target (e.g. `@/` -> `src/`) from its tsconfig/jsconfig `paths`. */
async function destinationAliasTarget(projectPath: string, alias: string): Promise<string | undefined> {
  for (const name of ['tsconfig.json', 'tsconfig.app.json', 'jsconfig.json']) {
    const text = await readFile(join(projectPath, name), 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    try {
      const config = JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1')) as { compilerOptions?: { baseUrl?: unknown; paths?: Record<string, unknown> } };
      const target = config.compilerOptions?.paths?.[`${alias}*`];
      if (!Array.isArray(target) || typeof target[0] !== 'string') continue;
      const baseUrl = typeof config.compilerOptions?.baseUrl === 'string' ? config.compilerOptions.baseUrl.replace(/^\.\/?/, '').replace(/\/$/, '') : '';
      return [baseUrl, target[0].replace(/^\.\//, '').replace(/\*$/, '').replace(/\/$/, '')].filter(Boolean).join('/');
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * The import path a consumer uses for the placed entry file. With a destination alias, the path is
 * the alias plus the entry's location under the alias target (so `@/` -> `src/` and a placed
 * `src/components/halftone-flow/HalftoneFlow.tsx` give `@/components/halftone-flow/HalftoneFlow`);
 * an `index` entry is imported by its block folder (`@/components/halftone-flow`).
 */
async function componentDirectoryImport(projectPath: string, profile: ProjectProfile, blockFolder: string, fileName: string): Promise<{ directory: string; importPath: string }> {
  const directory = `${profile.conventions.componentDirectory.replace(/\/$/, '')}/${blockFolder}`;
  const alias = profile.conventions.importAlias;
  const base = fileName.replace(/\.[^.]+$/, '');
  if (!alias) return { directory, importPath: `./${[blockFolder, base === 'index' ? '' : base].filter(Boolean).join('/')}` };
  const target = (await destinationAliasTarget(projectPath, alias)) ?? '';
  const underAlias = target === '' ? directory : directory === target ? '' : directory.startsWith(`${target}/`) ? directory.slice(target.length + 1) : undefined;
  if (underAlias === undefined) return { directory, importPath: `./${[directory, base === 'index' ? '' : base].filter(Boolean).join('/')}` };
  const segments = [underAlias, base === 'index' ? '' : base].filter(Boolean).join('/');
  return { directory, importPath: segments ? `${alias.replace(/\/$/, '')}/${segments}` : alias.replace(/\/$/, '') };
}

/**
 * Rewrites source path-alias imports (`@/`, `~/`, tsconfig `paths`) for the destination layout:
 * an alias that resolves inside the component becomes a relative import (files keep their layout
 * relative to the entry), and one that does not is re-pointed at the destination alias.
 */
function rewriteAliasImports(content: string, sourcePath: string, records: readonly DependencyRecord[], destinationAlias: string | undefined): string {
  let output = content;
  for (const record of records) {
    if (record.filePath !== sourcePath || record.alias === undefined) continue;
    let replacement: string | undefined;
    if (record.path) {
      const target = relative(dirname(sourcePath), record.path).split(sep).join('/').replace(/\.(?:tsx|ts|jsx|js)$/, '').replace(/(^|\/)index$/, '');
      replacement = target === '' ? '.' : target.startsWith('.') ? target : `./${target}`;
    } else if (destinationAlias && record.alias.endsWith('/') && record.alias !== destinationAlias) {
      replacement = `${destinationAlias}${record.specifier.slice(record.alias.length)}`;
    }
    if (replacement === undefined || replacement === record.specifier) continue;
    for (const quote of ["'", '"']) output = output.replaceAll(`${quote}${record.specifier}${quote}`, `${quote}${replacement}${quote}`);
  }
  return output;
}

/** Distinct residual count at which adaptation risk becomes high; a single residual is only medium. */
const HIGH_RISK_RESIDUALS = 2;

function riskFor(residuals: string[], warnings: string[], dependencies: DependencyDelta): AdaptationBundle['risk'] {
  if (dependencies.conflicts.length > 0) return 'high';
  // Count distinct residuals: the bundle reports them de-duplicated, so risk uses the same count.
  const distinctResiduals = new Set(residuals).size;
  if (distinctResiduals >= HIGH_RISK_RESIDUALS) return 'high';
  if (distinctResiduals === 1 || warnings.length > 0 || dependencies.add.length > 0) return 'medium';
  return 'low';
}

function bundleWithoutId(input: Omit<AdaptationBundle, 'bundleId' | 'manifest'>): Omit<AdaptationBundle, 'bundleId' | 'manifest'> {
  return input;
}

export async function prepareComponentAdaptation(componentId: string, options: AdaptationOptions): Promise<AdaptationBundle> {
  const projectPath = resolve(options.projectPath);
  const profile = await inspectProject(projectPath);
  if (profile.conflicts.length > 0) throw new AdaptationError('ADAPT_PROJECT_CONFLICT', 'The destination project has unresolved token conflicts.', { conflicts: profile.conflicts });
  const source = resolveCatalogSource(options);
  const resolved = await source.resolve(componentId, options.revision);
  const sourceFiles = resolved.files;
  // This envelope describes re-reading the already-resolved revision's source files for
  // re-normalization, not how the component was first acquired — the component's own
  // provenance.sourceType (e.g. 'legacy-filed') is a free-form classification and is not a valid
  // SourceEnvelope.sourceType. This stays 'directory' regardless of catalog source (local disk or
  // remote package): it describes the shape of the re-normalization input, not its origin.
  const envelope: SourceEnvelope = {
    schemaVersion: CONTRACT_VERSION,
    sourceType: 'directory',
    files: sourceFiles.map((file) => ({ ...file, contentHash: sha256(file.content) })),
    assets: resolved.assets,
    provenance: { sourceType: 'directory', locator: resolved.manifest.provenance.locator },
  };
  const normalized = normalizeSource(envelope);
  const { mappings, expressions } = mapOccurrences(normalized, profile);
  const unmappedWarnings = mappings.filter((mapping) => mapping.confidence === 'low').map((mapping) => `Token ${mapping.sourceToken} has no destination token; preserved fallback ${mapping.destinationExpression}.`);
  const warnings = [...profile.evidence.filter((item) => item.confidence === 'low').map((item) => item.fact), ...normalized.report.warnings, ...unmappedWarnings];
  const residuals = normalized.residuals.map((item) => `${item.path}:${item.line}:${item.column} ${item.reason}`);
  const tailwind = hasTailwind(profile);
  const entry = resolved.manifest.slug;
  const entryPath = resolveEntryPoint(resolved.manifest, sourceFiles.map((file) => file.path));
  const sourceEntry = sourceFiles.find((file) => file.path === entryPath) ?? sourceFiles[0];
  const sourceEntryName = sourceEntry?.path.split('/').pop() ?? `${entry}.tsx`;
  const sourceEntryStem = sourceEntryName.replace(/\.[^.]+$/, '');
  const blockFolder = blockFolderName(entry);
  const blockDirectory = join(profile.conventions.componentDirectory, blockFolder);
  const renameEntry = GENERIC_ENTRY_NAMES.has(sourceEntryStem.toLowerCase());
  const entryStem = renameEntry ? componentFileName(entry) : sourceEntryStem;
  const entryName = `${entryStem}${sourceEntryName.slice(sourceEntryStem.length)}`;
  const placement = await componentDirectoryImport(projectPath, profile, blockFolder, entryName);
  const destinationFiles: AdaptedFile[] = [];
  const cssRules = new Map<string, Set<string>>();
  for (const source of sourceFiles) {
    const relativeToEntry = sourceEntry ? relative(dirname(sourceEntry.path), source.path).split(sep).join('/') : source.path;
    if (isCatalogOnlyFile(relativeToEntry)) continue;
    const isEntry = source === sourceEntry;
    const targetName = safeRelative(join(blockDirectory, isEntry ? entryName : relativeToEntry));
    let content = rewriteAliasImports(source.content, source.path, normalized.dependencyContract.dependencies, profile.conventions.importAlias);
    content = helperReplacement(content, profile);
    if (renameEntry && !isEntry && !relativeToEntry.includes('/')) content = rewriteRelativeImport(content, sourceEntryStem, entryStem);
    const fileOccurrences = normalized.occurrences.filter((occurrence) => occurrence.filePath === source.path);
    content = replaceSourceTokens(content, fileOccurrences, expressions, tailwind);
    if (!tailwind) {
      for (const occurrence of fileOccurrences) {
        const expression = occurrence.tokenName ? expressions.get(occurrence.tokenName) : undefined;
        if (!expression || occurrence.kind !== 'tailwind') continue;
        const rule = cssRule(occurrence, expression);
        if (rule) cssRules.set(occurrence.source, new Set([...(cssRules.get(occurrence.source) ?? []), rule]));
      }
    }
    const absolute = join(projectPath, targetName);
    const existing = await readFile(absolute, 'utf8').catch(() => undefined);
    destinationFiles.push({ path: targetName, content, operation: existing === undefined ? 'create' : 'replace', contentHash: sha256(content), ...(existing === undefined ? {} : { targetHash: sha256(existing) }) });
  }
  if (!tailwind && cssRules.size > 0) {
    const cssName = `${entryName.replace(/\.[^.]+$/, '')}.blockbase.css`;
    const cssPath = safeRelative(join(blockDirectory, cssName));
    const cssContent = [...cssRules.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([selector, rules]) => `.${selector.replace(/[^a-zA-Z0-9_-]/g, '')} {\n${[...rules].sort().join('\n')}\n}`).join('\n\n') + '\n';
    const main = destinationFiles.find((file) => file.path === safeRelative(join(blockDirectory, entryName)));
    if (main) main.content = `import './${cssName}';\n${main.content}`;
    const existing = await readFile(join(projectPath, cssPath), 'utf8').catch(() => undefined);
    destinationFiles.push({ path: cssPath, content: cssContent, operation: existing === undefined ? 'create' : 'replace', contentHash: sha256(cssContent), ...(existing === undefined ? {} : { targetHash: sha256(existing) }) });
  }
  for (const file of destinationFiles) file.contentHash = sha256(file.content);
  const dependencies = dependencyDelta(normalized, resolved.manifest, profile);
  const validationCommands = profile.validationCommands.slice().sort();
  const bundleBase: Omit<AdaptationBundle, 'bundleId' | 'manifest'> = {
    schemaVersion: CONTRACT_VERSION,
    componentId: resolved.componentId,
    revisionId: resolved.revisionId,
    projectPath,
    files: destinationFiles.sort((a, b) => a.path.localeCompare(b.path)),
    tokenMappings: mappings,
    dependencyDelta: dependencies,
    placement,
    providers: [],
    residuals: [...new Set(residuals)].sort(),
    warnings: [...new Set(warnings)].sort(),
    risk: riskFor(residuals, warnings, dependencies),
    validationCommands,
    provenance: {
      sourceType: resolved.manifest.provenance.sourceType,
      locator: resolved.manifest.provenance.locator,
      license: resolved.manifest.provenance.license,
      attributionStatus: resolved.manifest.provenance.attributionStatus,
      sourceHash: resolved.manifest.integrity.sourceHash,
    },
  };
  const bundleId = `bundle_${sha256(stableStringify(bundleWithoutId(bundleBase))).slice(-16)}`;
  const manifest = {
    schemaVersion: CONTRACT_VERSION,
    bundleId,
    componentId: resolved.componentId,
    revisionId: resolved.revisionId,
    generatedAt: '1970-01-01T00:00:00.000Z',
    projectPath,
    files: bundleBase.files.map(({ path, operation, contentHash, targetHash }) => ({ path, operation, contentHash, ...(targetHash ? { targetHash } : {}) })),
    validationCommands,
  };
  const bundle = parseAdaptationBundle({ ...bundleBase, bundleId, manifest });
  if (options.outDir) {
    const stagingRoot = resolve(options.outDir);
    if (stagingRoot === projectPath || stagingRoot.startsWith(`${projectPath}${sep}`)) throw new AdaptationError('ADAPT_INVALID_OUTPUT', 'The staging path must not be inside the destination project.', { outDir: stagingRoot, projectPath });
    await writeStaging(stagingRoot, bundle);
  }
  return bundle;
}

async function writeStaging(outDir: string, bundle: AdaptationBundle): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const root = resolve(outDir);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'bundle.json'), stableStringify(bundle));
  await writeFile(join(root, 'manifest.json'), stableStringify(bundle.manifest));
  for (const file of bundle.files) {
    const path = join(root, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
  }
}

export async function createApplyPlan(bundle: AdaptationBundle): Promise<AdaptationPlan> {
  const projectPath = resolve(bundle.projectPath);
  const files: AdaptationPlan['files'] = [];
  const blocked: string[] = [];
  for (const file of bundle.files) {
    const target = safeRelative(file.path);
    const path = join(projectPath, target);
    const current = await readFile(path, 'utf8').catch(() => undefined);
    if (file.operation === 'create' && current !== undefined) blocked.push(`${target}: target appeared after preparation`);
    if (file.operation !== 'create' && current === undefined) blocked.push(`${target}: target was removed after preparation`);
    if (file.targetHash && current !== undefined && sha256(current) !== file.targetHash) blocked.push(`${target}: target changed after preparation`);
    files.push({ path: target, operation: file.operation, contentHash: file.contentHash, ...(file.targetHash ? { targetHash: file.targetHash } : {}) });
  }
  return { schemaVersion: CONTRACT_VERSION, bundleId: bundle.bundleId, projectPath, revisionId: bundle.revisionId, files, dependencyDelta: bundle.dependencyDelta, writes: files.map((file) => file.path), blocked: blocked.sort() };
}

export async function applyAdaptation(bundle: AdaptationBundle, options: { catalogRoot?: string; catalogSource?: CatalogSource } = {}): Promise<AdaptationPlan> {
  const source = resolveOptionalCatalogSource(options);
  if (source) {
    const currentRevision = await source.currentRevision(bundle.componentId);
    if (currentRevision !== bundle.revisionId) throw new AdaptationError('ADAPT_STALE_REVISION', 'The adaptation revision is no longer current.', { componentId: bundle.componentId, bundleRevision: bundle.revisionId, currentRevision });
  }
  const plan = await createApplyPlan(bundle);
  if (plan.blocked.length > 0) throw new AdaptationError('ADAPT_TARGET_CHANGED', 'The destination changed after adaptation preparation.', { blocked: plan.blocked });
  const { mkdir, writeFile } = await import('node:fs/promises');
  for (const file of bundle.files) {
    const path = join(plan.projectPath, safeRelative(file.path));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
  }
  return plan;
}

export const adaptComponent = prepareComponentAdaptation;
export function prepareAdaptation(componentId: string, options: AdaptationOptions): Promise<AdaptationBundle>;
export function prepareAdaptation(request: AdaptationRequest): Promise<AdaptationBundle>;
export function prepareAdaptation(componentOrRequest: string | AdaptationRequest, options?: AdaptationOptions): Promise<AdaptationBundle> {
  return typeof componentOrRequest === 'string'
    ? prepareComponentAdaptation(componentOrRequest, options as AdaptationOptions)
    : prepareComponentAdaptation(componentOrRequest.componentId, componentOrRequest);
}
