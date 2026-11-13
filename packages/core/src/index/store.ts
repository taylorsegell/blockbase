import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { CONTRACT_VERSION, parseComponentManifest, stableStringify, type ComponentManifest } from '@blockbase/contracts';
import { IndexError, INDEX_ERROR_CODES, type IndexFailureClassification } from './errors.js';
import type { IndexOptions, IndexRebuildResult, IndexRebuildProgress, IndexRow, IndexStatus } from './types.js';

export const INDEX_SCHEMA_VERSION = 1;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const require = createRequire(import.meta.url);
let sqliteModule: typeof import('node:sqlite') | undefined;

function databaseSync(): typeof import('node:sqlite').DatabaseSync {
  if (!sqliteModule) {
    // node:sqlite is experimental on the supported Node 24 runtime. Keep its
    // warning out of the CLI's machine-readable stderr while loading it.
    const defaultWarningListener = process.listeners('warning')[0] as ((warning: Error) => void) | undefined;
    process.removeAllListeners('warning');
    process.on('warning', (warning) => {
      if (warning.name !== 'ExperimentalWarning' || !warning.message.includes('SQLite')) defaultWarningListener?.(warning);
    });
    sqliteModule = require('node:sqlite') as typeof import('node:sqlite');
  }
  return sqliteModule.DatabaseSync;
}

export function indexPathFor(catalogRoot: string): string {
  return join(catalogRoot, 'index.sqlite');
}

function repairAction(catalogRoot: string) {
  return {
    id: 'rebuild-index',
    label: 'Rebuild the SQLite index from committed component manifests',
    safe: true,
    command: `blockbase catalog rebuild --catalog ${catalogRoot} --json`,
  };
}

async function reportProgress(options: IndexOptions, progress: IndexRebuildProgress): Promise<void> {
  await options.onProgress?.(progress);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function favoriteFromManifest(manifest: ComponentManifest): boolean {
  // Favorites are mutable metadata. Keep the base manifest contract backward
  // compatible while accepting the two names used by existing catalog clients.
  const value = manifest as ComponentManifest & { favorite?: unknown; isFavorite?: unknown; metadata?: { favorite?: unknown } };
  return value.favorite === true || value.isFavorite === true || value.metadata?.favorite === true;
}

export function indexRecoveryAction(catalogRoot: string) {
  return repairAction(catalogRoot);
}

async function manifestPaths(catalogRoot: string): Promise<string[]> {
  const root = join(catalogRoot, 'components');
  const namespaces = await readdir(root, { withFileTypes: true }).catch(() => []);
  const paths: string[] = [];
  for (const namespace of namespaces.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!namespace.isDirectory()) continue;
    const slugs = await readdir(join(root, namespace.name), { withFileTypes: true });
    for (const slug of slugs.sort((left, right) => left.name.localeCompare(right.name))) {
      if (slug.isDirectory()) paths.push(join(root, namespace.name, slug.name, 'component.json'));
    }
  }
  return paths;
}

async function sourceSymbols(manifestPath: string, manifest: ComponentManifest): Promise<string> {
  const revision = manifest.currentRevision.replace(/^sha256:/, '');
  const sourceRoot = join(dirname(manifestPath), 'revisions', revision, 'original');
  const files: string[] = [];
  async function visit(path: string): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) files.push(await readFile(child, 'utf8'));
    }
  }
  await visit(sourceRoot);
  const symbols = new Set<string>();
  for (const content of files) {
    for (const symbol of content.match(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g) ?? []) symbols.add(symbol);
  }
  return [...symbols].sort((left, right) => left.localeCompare(right)).join(' ');
}

async function rowsFromManifests(catalogRoot: string): Promise<IndexRow[]> {
  const rows: IndexRow[] = [];
  for (const path of await manifestPaths(catalogRoot)) {
    let manifest: ComponentManifest;
    try {
      manifest = parseComponentManifest(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) {
      throw new IndexError(INDEX_ERROR_CODES.manifestInvalid, 'A committed component manifest could not be indexed.', { path, cause: error instanceof Error ? error.message : String(error) });
    }
    rows.push({
      componentId: manifest.componentId,
      namespace: manifest.namespace,
      slug: manifest.slug,
      displayName: manifest.displayName,
      description: manifest.description,
      aliases: sortedUnique(manifest.aliases),
      tags: sortedUnique(manifest.tags),
      category: manifest.category,
      framework: manifest.framework,
      stylingModes: [...manifest.stylingModes].sort(),
      currentRevision: manifest.currentRevision,
      favorite: favoriteFromManifest(manifest),
      sourcePath: path,
      manifest,
    });
  }
  rows.sort((left, right) => left.componentId.localeCompare(right.componentId));
  const identities = new Set<string>();
  for (const row of rows) {
    if (identities.has(row.componentId)) throw new IndexError(INDEX_ERROR_CODES.manifestInvalid, 'Component manifests contain duplicate IDs.', { componentId: row.componentId });
    identities.add(row.componentId);
  }
  return rows;
}

function canonicalRow(row: IndexRow, symbols: string): string {
  return stableStringify({
    componentId: row.componentId,
    namespace: row.namespace,
    slug: row.slug,
    displayName: row.displayName,
    description: row.description,
    aliases: row.aliases,
    tags: row.tags,
    category: row.category,
    framework: row.framework,
    stylingModes: row.stylingModes,
    currentRevision: row.currentRevision,
    favorite: row.favorite,
    manifest: row.manifest,
    sourceSymbols: symbols,
  });
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

function schemaSql(): string {
  return `
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA user_version = ${INDEX_SCHEMA_VERSION};
    CREATE TABLE index_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    CREATE TABLE components (
      component_id TEXT PRIMARY KEY NOT NULL,
      namespace TEXT NOT NULL,
      slug TEXT NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT NOT NULL,
      aliases_json TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      category TEXT NOT NULL,
      framework TEXT NOT NULL,
      styling_modes_json TEXT NOT NULL,
      current_revision TEXT NOT NULL,
      source_path TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      source_symbols TEXT NOT NULL
    );
    CREATE TABLE component_tags (
      component_id TEXT NOT NULL REFERENCES components(component_id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (component_id, tag)
    );
    CREATE TABLE component_favorites (
      component_id TEXT PRIMARY KEY NOT NULL REFERENCES components(component_id) ON DELETE CASCADE,
      favorite INTEGER NOT NULL CHECK (favorite IN (0, 1))
    );
    CREATE TABLE component_compatibility (
      component_id TEXT PRIMARY KEY NOT NULL REFERENCES components(component_id) ON DELETE CASCADE,
      language TEXT NOT NULL,
      runtime TEXT NOT NULL,
      framework_range TEXT NOT NULL,
      client_server TEXT NOT NULL,
      framework TEXT NOT NULL,
      styling_modes_json TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE component_fts USING fts5(
      component_id UNINDEXED,
      display_name,
      description,
      aliases,
      tags,
      category,
      framework,
      styling_modes,
      props,
      slots,
      events,
      accessibility,
      source_symbols,
      dependency_names
    );
  `;
}

function insertRow(db: DatabaseSync, row: IndexRow, symbols: string): void {
  db.prepare(`INSERT INTO components
    (component_id, namespace, slug, display_name, description, aliases_json, tags_json, category, framework, styling_modes_json, current_revision, source_path, manifest_json, source_symbols)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.componentId, row.namespace, row.slug, row.displayName, row.description, JSON.stringify(row.aliases), JSON.stringify(row.tags), row.category,
    row.framework, JSON.stringify(row.stylingModes), row.currentRevision, row.sourcePath, stableStringify(row.manifest), symbols,
  );
  const insertTag = db.prepare('INSERT INTO component_tags (component_id, tag) VALUES (?, ?)');
  for (const tag of row.tags) insertTag.run(row.componentId, tag);
  db.prepare('INSERT INTO component_favorites (component_id, favorite) VALUES (?, ?)').run(row.componentId, row.favorite ? 1 : 0);
  db.prepare(`INSERT INTO component_compatibility
    (component_id, language, runtime, framework_range, client_server, framework, styling_modes_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    row.componentId, row.manifest.compatibility.language, row.manifest.compatibility.runtime,
    row.manifest.compatibility.frameworkRange, row.manifest.compatibility.clientServer,
    row.framework, JSON.stringify(row.stylingModes),
  );
  const searchable = row.manifest;
  db.prepare(`INSERT INTO component_fts
    (component_id, display_name, description, aliases, tags, category, framework, styling_modes, props, slots, events, accessibility, source_symbols, dependency_names)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.componentId, row.displayName, row.description, row.aliases.join(' '), row.tags.join(' '), row.category, row.framework,
    row.stylingModes.join(' '), searchable.interface.props.join(' '), searchable.interface.slots.join(' '), searchable.interface.events.join(' '),
    searchable.interface.accessibilityNotes.join(' '), symbols, searchable.dependencies.map((dependency) => dependency.name).join(' '),
  );
}

function resultFromRows(rows: IndexRow[], symbolsById: Map<string, string>): IndexRebuildResult {
  const content = rows.map((row) => canonicalRow(row, symbolsById.get(row.componentId) ?? '')).join('');
  const catalogRevision = `sha256:${hash(content)}`;
  return {
    schemaVersion: CONTRACT_VERSION,
    indexPath: '',
    indexSchemaVersion: INDEX_SCHEMA_VERSION,
    catalogRevision,
    searchableContentHash: `sha256:${hash(content)}`,
    componentCount: rows.length,
    projectionCounts: {
      components: rows.length,
      tags: rows.reduce((count, row) => count + row.tags.length, 0),
      favorites: rows.filter((row) => row.favorite).length,
      compatibility: rows.length,
    },
    source: 'manifests',
  };
}

export async function rebuildIndex(options: IndexOptions): Promise<IndexRebuildResult> {
  const indexPath = options.indexPath ?? indexPathFor(options.catalogRoot);
  await reportProgress(options, { phase: 'scan', completed: 0, total: 0 });
  const rows = await rowsFromManifests(options.catalogRoot);
  await reportProgress(options, { phase: 'scan', completed: rows.length, total: rows.length });
  const symbolsById = new Map<string, string>();
  for (const [index, row] of rows.entries()) {
    symbolsById.set(row.componentId, await sourceSymbols(row.sourcePath, row.manifest));
    await reportProgress(options, { phase: 'symbols', completed: index + 1, total: rows.length, componentId: row.componentId });
  }
  const result = resultFromRows(rows, symbolsById);
  result.indexPath = indexPath;
  await mkdir(dirname(indexPath), { recursive: true });
  const temporary = `${indexPath}.tmp-${process.pid}-${randomUUID()}`;
  const DatabaseSync = databaseSync();
  let published = false;
  try {
    const db = new DatabaseSync(temporary, { timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS });
    try {
      db.exec(schemaSql());
      db.prepare('INSERT INTO index_meta (key, value) VALUES (?, ?)').run('schema_version', String(INDEX_SCHEMA_VERSION));
      db.prepare('INSERT INTO index_meta (key, value) VALUES (?, ?)').run('catalog_revision', result.catalogRevision);
      db.prepare('INSERT INTO index_meta (key, value) VALUES (?, ?)').run('searchable_content_hash', result.searchableContentHash);
      for (const [index, row] of rows.entries()) {
        insertRow(db, row, symbolsById.get(row.componentId) ?? '');
        await reportProgress(options, { phase: 'write', completed: index + 1, total: rows.length, componentId: row.componentId });
      }
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
    const file = await open(temporary, 'r');
    try { await file.sync(); } finally { await file.close(); }
    await rename(temporary, indexPath);
    await syncDirectory(dirname(indexPath));
    published = true;
    await reportProgress(options, { phase: 'publish', completed: 1, total: 1 });
  } finally {
    if (!published) await rm(temporary, { force: true }).catch(() => undefined);
    // The temporary WAL/SHM files are disposable and can remain after a
    // failed SQLite transaction; never let them shadow the authoritative index.
    await rm(`${temporary}-wal`, { force: true }).catch(() => undefined);
    await rm(`${temporary}-shm`, { force: true }).catch(() => undefined);
  }
  return result;
}

export type OpenIndex = {
  db: DatabaseSync;
  close: () => void;
  indexPath: string;
  catalogRevision: string;
};

function failureDetails(path: string, catalogRoot: string, classification: IndexFailureClassification, cause?: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    indexPath: path,
    classification,
    recoveryAction: repairAction(catalogRoot),
    ...extra,
    ...(cause === undefined ? {} : { cause: cause instanceof Error ? cause.message : String(cause) }),
  };
}

function indexFailureCode(classification: IndexFailureClassification): typeof INDEX_ERROR_CODES[keyof typeof INDEX_ERROR_CODES] {
  return classification === 'missing' ? INDEX_ERROR_CODES.notFound : classification === 'schema-mismatch' ? INDEX_ERROR_CODES.schemaMismatch : INDEX_ERROR_CODES.corrupt;
}

function failureMessage(classification: IndexFailureClassification): string {
  if (classification === 'missing') return 'The SQLite search index does not exist.';
  if (classification === 'schema-mismatch') return 'The SQLite search index uses an incompatible schema.';
  if (classification === 'incomplete') return 'The SQLite search index is incomplete.';
  return 'The SQLite search index contains malformed or corrupt data.';
}

function classifyOpenFailure(error: unknown): IndexFailureClassification {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes('enoent') || message.includes('no such file')) return 'missing';
  if (message.includes('index_meta')) return 'schema-mismatch';
  return message.includes('no such table') || message.includes('no such column') ? 'incomplete' : 'malformed';
}

export async function openIndex(options: IndexOptions): Promise<OpenIndex> {
  const path = options.indexPath ?? indexPathFor(options.catalogRoot);
  try {
    await stat(path);
  } catch {
    throw new IndexError(INDEX_ERROR_CODES.notFound, failureMessage('missing'), failureDetails(path, options.catalogRoot, 'missing'));
  }
  const DatabaseSync = databaseSync();
  let db: DatabaseSync | undefined;
  try {
    const opened = new DatabaseSync(path, { readOnly: true, timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS });
    db = opened;
    const schema = opened.prepare("SELECT value FROM index_meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
    const revision = opened.prepare("SELECT value FROM index_meta WHERE key = 'catalog_revision'").get() as { value?: string } | undefined;
    const userVersion = opened.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
    if (schema?.value !== String(INDEX_SCHEMA_VERSION) || userVersion?.user_version !== INDEX_SCHEMA_VERSION) {
      throw new IndexError(INDEX_ERROR_CODES.schemaMismatch, failureMessage('schema-mismatch'), failureDetails(path, options.catalogRoot, 'schema-mismatch', undefined, {
        expectedSchemaVersion: INDEX_SCHEMA_VERSION,
        actualSchemaVersion: schema?.value ?? userVersion?.user_version ?? null,
      }));
    }
    if (!revision?.value) throw new Error('missing catalog revision');
    for (const table of ['components', 'component_tags', 'component_favorites', 'component_compatibility', 'component_fts']) {
      opened.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
    }
    if (options.verify) {
      const quickCheck = opened.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
      if (quickCheck?.quick_check !== 'ok') throw new Error(`quick_check failed: ${quickCheck?.quick_check ?? 'unknown'}`);
    }
    return { db: opened, close: () => opened.close(), indexPath: path, catalogRevision: revision.value };
  } catch (error) {
    try { db?.close(); } catch { /* opening corruption can leave no closeable handle */ }
    if (error instanceof IndexError) throw error;
    const classification = classifyOpenFailure(error);
    throw new IndexError(indexFailureCode(classification), failureMessage(classification), failureDetails(path, options.catalogRoot, classification, error));
  }
}

export async function diagnoseIndex(options: IndexOptions): Promise<IndexStatus> {
  const path = options.indexPath ?? indexPathFor(options.catalogRoot);
  try {
    const opened = await openIndex({ ...options, verify: true });
    opened.close();
    return {
      indexPath: path,
      healthy: true,
      classification: 'healthy',
      schemaVersion: INDEX_SCHEMA_VERSION,
      catalogRevision: opened.catalogRevision,
      recoveryAction: repairAction(options.catalogRoot),
    };
  } catch (error) {
    const classification = error instanceof IndexError && typeof error.details.classification === 'string'
      ? error.details.classification as IndexStatus['classification']
      : 'malformed';
    return {
      indexPath: path,
      healthy: false,
      classification,
      ...(error instanceof IndexError && typeof error.details.cause === 'string' ? { cause: error.details.cause } : {}),
      recoveryAction: repairAction(options.catalogRoot),
    };
  }
}

export const indexStatus = diagnoseIndex;
export const getIndexStatus = diagnoseIndex;
export const inspectIndex = diagnoseIndex;

export async function repairIndex(options: IndexOptions): Promise<IndexRebuildResult> {
  return rebuildIndex(options);
}
