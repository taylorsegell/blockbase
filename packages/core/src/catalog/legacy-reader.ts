import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import { CONTRACT_VERSION } from '@blockbase/contracts';
import { CatalogNotFoundError } from './errors.js';
import { resolveCatalog } from './discovery.js';
import { validateCatalogTaxonomy } from './taxonomy.js';
import type { CatalogDiagnostic, LegacyCatalogInventory, LegacyCatalogRow } from './types.js';
import type { CatalogResolutionOptions } from './types.js';

export type LegacyCatalogOptions = CatalogResolutionOptions & {
  rootPath?: string;
  catalogPath?: string;
  taxonomyPath?: string;
  registryPath?: string | null;
};

function fileEvidence(file: string, value?: unknown) {
  return value === undefined ? { file } : { file, value };
}

function diagnostic(code: CatalogDiagnostic['code'], message: string, file: string, path?: string, value?: unknown): CatalogDiagnostic {
  return { code, severity: code === 'catalog.shared_path_exception' ? 'warning' : 'error', message, file, ...(path ? { path } : {}), evidence: fileEvidence(file, value) };
}

function safeRelativePath(root: string, catalogPath: string, value: unknown): { safe: boolean; path: string | null } {
  if (typeof value !== 'string' || value.length === 0) return { safe: false, path: null };
  const normalized = value.replaceAll('\\', '/');
  if (/^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(value)) return { safe: false, path: null };
  const candidate = resolve(root, normalized);
  const rel = relative(root, candidate);
  return { safe: rel !== '..' && !rel.startsWith(`..${sep}`), path: candidate };
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hashFile(path: string): string | null {
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function hashCorpus(root: string, files: string[]): string {
  const hash = createHash('sha256');
  for (const file of [...new Set(files)].sort()) {
    const absolute = resolve(file);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
    hash.update(relative(root, absolute).split(sep).join('/'));
    hash.update('\0');
    hash.update(readFileSync(absolute));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function collectFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  const stats = statSync(path);
  if (stats.isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => collectFiles(join(path, entry.name)));
}

function registrySlugs(path: string | null): Set<string> {
  if (!path || !existsSync(path) || !statSync(path).isFile()) return new Set();
  const text = readFileSync(path, 'utf8');
  const slugs = new Set<string>();
  for (const match of text.matchAll(/\bslug\s*:\s*['"]([^'"]+)['"]/g)) slugs.add(match[1]);
  return slugs;
}

function parseRows(value: unknown): unknown[] | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const blocks = (value as { blocks?: unknown }).blocks;
  return Array.isArray(blocks) ? blocks : null;
}

function rowFrom(value: unknown): LegacyCatalogRow | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return {
    name: typeof row.name === 'string' ? row.name : '',
    bucket: typeof row.bucket === 'string' ? row.bucket : '',
    slug: typeof row.slug === 'string' ? row.slug : '',
    path: typeof row.path === 'string' ? row.path : '',
    exported: typeof row.exported === 'string' ? row.exported : '',
    tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : [],
  };
}

function parseMetadata(path: string): { value: Record<string, unknown> | null; invalid: boolean } {
  try {
    const value = parse(readFileSync(path, 'utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { value: null, invalid: true };
    return { value: value as Record<string, unknown>, invalid: false };
  } catch {
    return { value: null, invalid: true };
  }
}

export function readLegacyCatalog(input: LegacyCatalogOptions | string = {}): LegacyCatalogInventory {
  const options: LegacyCatalogOptions = typeof input === 'string' ? { catalog: input } : input;
  const rootCandidate = options.rootPath ? join(resolve(options.rootPath), 'catalog.yaml') : undefined;
  const resolution = resolveCatalog({
    ...options,
    catalog: options.catalogPath ?? options.catalog ?? rootCandidate,
  });
  const catalogPath = resolution.catalogPath ?? (options.catalogPath ? resolve(options.catalogPath) : resolve(options.rootPath ?? process.cwd(), 'catalog.yaml'));
  const rootPath = resolve(options.rootPath ?? dirname(catalogPath));
  const taxonomyPath = resolve(options.taxonomyPath ?? join(rootPath, 'taxonomy.csv'));
  const registryPath = options.registryPath === undefined ? join(rootPath, 'preview', 'src', 'registry.tsx') : options.registryPath ? resolve(options.registryPath) : null;
  const diagnostics: CatalogDiagnostic[] = [];
  const catalogFiles = [catalogPath, taxonomyPath];
  let rows: LegacyCatalogRow[] = [];
  let rawCatalog: unknown = null;
  if (!resolution.found) diagnostics.push(diagnostic('catalog.missing', 'catalog.yaml was not found in the checked locations', catalogPath));
  else {
    try {
      rawCatalog = parse(readFileSync(catalogPath, 'utf8'));
      const parsedRows = parseRows(rawCatalog);
      if (!parsedRows) diagnostics.push(diagnostic('catalog.invalid_shape', 'catalog YAML must contain a blocks array', catalogPath));
      else parsedRows.forEach((value, index) => {
        const row = rowFrom(value);
        if (!row) diagnostics.push(diagnostic('catalog.invalid_shape', `catalog row ${index} must be an object`, catalogPath, String(index), value));
        else {
          rows.push(row);
          for (const key of ['name', 'bucket', 'slug', 'path', 'exported']) if (!row[key as keyof LegacyCatalogRow]) diagnostics.push(diagnostic('catalog.missing_field', `catalog row ${index} is missing '${key}'`, catalogPath, row.slug || String(index), value));
        }
      });
    } catch (error) {
      diagnostics.push(diagnostic('catalog.invalid_yaml', error instanceof Error ? error.message : 'catalog YAML is invalid', catalogPath));
    }
  }
  let taxonomyText = '';
  if (existsSync(taxonomyPath) && statSync(taxonomyPath).isFile()) taxonomyText = readFileSync(taxonomyPath, 'utf8');
  else diagnostics.push(diagnostic('catalog.missing_required_file', 'taxonomy.csv is required for legacy taxonomy validation', taxonomyPath));
  if (rawCatalog !== null && taxonomyText) diagnostics.push(...validateCatalogTaxonomy({ catalogRows: rows, taxonomyCsv: taxonomyText, catalogFile: catalogPath, taxonomyFile: taxonomyPath }));

  const pathRows = new Map<string, LegacyCatalogRow[]>();
  const identities = new Set<string>();
  for (const row of rows) {
    const identity = `${row.name}\u0000${row.slug}`;
    if (identities.has(identity)) diagnostics.push(diagnostic('catalog.duplicate_identity', `catalog identity '${row.name}/${row.slug}' is duplicated`, catalogPath, row.slug, row));
    identities.add(identity);
    const safe = safeRelativePath(rootPath, catalogPath, row.path);
    if (!safe.safe) diagnostics.push(diagnostic('catalog.path_traversal', `catalog path '${row.path}' escapes the catalog root`, catalogPath, row.slug, row));
    else if (safe.path) pathRows.set(row.path, [...(pathRows.get(row.path) ?? []), row]);
  }
  for (const [path, pathEntries] of pathRows) {
    const allowed = path === 'empty-states/dino-404' && pathEntries.some((entry) => entry.slug === 'dino-404') && pathEntries.some((entry) => entry.slug === 'snowboarder-404');
    if (pathEntries.length > 1 && !allowed) diagnostics.push(diagnostic('catalog.shared_path', `catalog path '${path}' is shared by multiple identities`, catalogPath, path, pathEntries));
    const directory = join(rootPath, path);
    if (!existsSync(directory) || !statSync(directory).isDirectory()) {
      diagnostics.push(diagnostic('catalog.missing_required_file', `component directory '${path}' is missing`, catalogPath, path));
      continue;
    }
    const files = readdirSync(directory);
    for (const required of ['meta.yaml', 'BLOCK.md']) if (!files.includes(required)) diagnostics.push(diagnostic('catalog.missing_required_file', `component '${path}' is missing ${required}`, join(directory, required), path));
    if (!files.includes('index.ts')) diagnostics.push(diagnostic('catalog.missing_index', `component '${path}' is missing index.ts`, join(directory, 'index.ts'), path));
    if (!files.some((file) => ['.ts', '.tsx', '.js', '.jsx'].includes(extname(file)) && file !== 'index.ts')) diagnostics.push(diagnostic('catalog.missing_required_file', `component '${path}' has no source file`, directory, path));
    const metadataPath = join(directory, 'meta.yaml');
    if (files.includes('meta.yaml')) {
      const parsed = parseMetadata(metadataPath);
      if (parsed.invalid) diagnostics.push(diagnostic('catalog.metadata_invalid_yaml', `metadata at '${path}' is not valid YAML`, metadataPath, path));
      else if (parsed.value) {
        for (const key of ['name', 'bucket', 'slug', 'exported', 'tags']) {
          const catalogValue = rowFrom(pathEntries[0])?.[key as keyof LegacyCatalogRow];
          if (catalogValue !== undefined && parsed.value[key] !== undefined && !sameValue(catalogValue, parsed.value[key])) diagnostics.push(diagnostic('catalog.metadata_disagreement', `catalog and metadata disagree on '${key}' for '${path}'`, metadataPath, path, { catalog: catalogValue, metadata: parsed.value[key] }));
        }
      }
    }
    catalogFiles.push(...collectFiles(directory));
  }
  const registry = registrySlugs(registryPath && existsSync(registryPath) ? registryPath : null);
  for (const row of rows) if (registryPath && existsSync(registryPath) && !registry.has(row.slug)) diagnostics.push(diagnostic('catalog.registry_missing', `catalog slug '${row.slug}' is absent from the preview registry`, registryPath, row.slug, row));
  if (registryPath && existsSync(registryPath)) catalogFiles.push(registryPath);
  const sortDiagnostics = diagnostics.sort((left, right) => `${left.code}\0${left.file ?? ''}\0${left.path ?? ''}\0${left.message}`.localeCompare(`${right.code}\0${right.file ?? ''}\0${right.path ?? ''}\0${right.message}`));
  const invalidManifests = sortDiagnostics.filter((item) => item.code === 'catalog.metadata_invalid_yaml').length;
  const metadataDisagreements = sortDiagnostics.filter((item) => item.code === 'catalog.metadata_disagreement').length;
  const missingIndexes = sortDiagnostics.filter((item) => item.code === 'catalog.missing_index').length;
  const registryMissing = sortDiagnostics.filter((item) => item.code === 'catalog.registry_missing').length;
  return {
    schemaVersion: CONTRACT_VERSION,
    rootPath, catalogPath, taxonomyPath, registryPath: registryPath && existsSync(registryPath) ? registryPath : null, resolution,
    entries: rows, entryCount: rows.length, uniquePathCount: new Set(rows.map((row) => row.path)).size, diagnostics: sortDiagnostics,
    counts: { entries: rows.length, uniquePaths: new Set(rows.map((row) => row.path)).size, invalidManifests, metadataDisagreements, missingIndexes, registrySlugs: registry.size, registryMissing },
    catalogHash: hashFile(catalogPath), taxonomyHash: hashFile(taxonomyPath), corpusHash: hashCorpus(rootPath, catalogFiles),
  };
}

export function readLegacyCatalogOrThrow(input: LegacyCatalogOptions | string = {}): LegacyCatalogInventory {
  const result = readLegacyCatalog(input);
  if (!result.resolution.found) throw new CatalogNotFoundError(result.resolution);
  return result;
}

export const inspectLegacyCatalog = readLegacyCatalog;
export const diagnoseLegacyCatalog = readLegacyCatalog;
