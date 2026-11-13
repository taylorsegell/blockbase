import { homedir } from 'node:os';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  CatalogLocationKind,
  CatalogResolution,
  CatalogResolutionOptions,
  CatalogResolutionSource,
  CheckedCatalogLocation,
} from './types.js';
import { CONTRACT_VERSION } from '@blockbase/contracts';

const MIGRATED_INDEX_FILENAME = 'index.sqlite';

/**
 * Resolves a user- or platform-supplied catalog value to the concrete marker file that proves a
 * catalog is present there: `catalog.yaml` for the pre-migration legacy format, or `index.sqlite`
 * for a real migrated catalog produced by `catalog migrate --apply`. An explicit literal path to
 * either marker is used as-is (an operator who already knows exactly what they're pointing at is
 * never overridden), unless it is an existing directory. For a directory, a migrated index wins
 * when present and no legacy `catalog.yaml` also exists there — the common case, since a location
 * is normally one format or the other — otherwise the legacy path is assumed, preserving the
 * original missing-catalog behavior for a location that has neither.
 */
function asCatalogPath(value: string, cwd: string): string {
  const absolute = isAbsolute(value) ? value : resolve(cwd, value);
  // A directory is always a catalog root, even one named like a marker (such as `~/work/catalog`).
  if (locationKind(absolute) !== 'directory') {
    if (/(?:^|[\\/])catalog(?:\.(?:ya?ml|json))?$/i.test(absolute)) return absolute;
    if (new RegExp(`(?:^|[\\\\/])${MIGRATED_INDEX_FILENAME}$`, 'i').test(absolute)) return absolute;
  }
  const migratedIndexPath = join(absolute, MIGRATED_INDEX_FILENAME);
  if (existsSync(migratedIndexPath) && !existsSync(join(absolute, 'catalog.yaml'))) return migratedIndexPath;
  return join(absolute, 'catalog.yaml');
}
function platformRoot(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  return join(home, '.blocks');
}

function locationKind(path: string): CatalogLocationKind {
  if (!existsSync(path)) return 'missing';
  try {
    const stats = statSync(path);
    if (stats.isFile()) return 'file';
    if (stats.isDirectory()) return 'directory';
    return 'other';
  } catch {
    return 'other';
  }
}

export function defaultCatalogRoot(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): string {
  return platformRoot(platform, env, homeDir);
}

/**
 * Resolves the catalog from `options.catalog`, then `BLOCKBASE_HOME`, then `~/.blocks`.
 * The highest-priority configured location is authoritative: if it has no catalog, resolution
 * reports not-found and never falls back to a lower-priority location. Every candidate is still
 * listed in `checkedLocations` for diagnostics.
 */
export function resolveCatalog(options: CatalogResolutionOptions = {}): CatalogResolution {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? homedir();
  const candidates: Array<{ path: string; source: CatalogResolutionSource }> = [];
  if (options.catalog) candidates.push({ path: asCatalogPath(options.catalog, cwd), source: 'explicit' });
  if (env.BLOCKBASE_HOME) candidates.push({ path: asCatalogPath(env.BLOCKBASE_HOME, cwd), source: 'environment' });
  candidates.push({ path: asCatalogPath(platformRoot(platform, env, home), cwd), source: 'platform-default' });

  const unique = new Map<string, CatalogResolutionSource>();
  for (const candidate of candidates) {
    if (!unique.has(candidate.path)) unique.set(candidate.path, candidate.source);
  }
  const checkedLocations: CheckedCatalogLocation[] = [...unique.entries()].map(([path, source]) => {
    const kind = locationKind(path);
    return { path, source, exists: kind !== 'missing', kind, selected: false };
  });
  const authoritative = candidates[0].source;
  const selected = checkedLocations.find((location) => location.source === authoritative && location.kind === 'file');
  if (selected) selected.selected = true;
  return {
    schemaVersion: CONTRACT_VERSION,
    found: selected !== undefined,
    catalogPath: selected?.path ?? null,
    resolvedPath: selected?.path ?? null,
    rootPath: selected ? resolve(selected.path, '..') : null,
    source: selected?.source ?? null,
    winningSource: selected?.source ?? null,
    checkedLocations,
  };
}
