import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { stableStringify } from '@blockbase/contracts';
import { rebuildIndex } from '../../index/store.js';
import { metadataPathFor } from '../../metadata/service.js';
import { listCatalogComponents, resolveCatalogComponent, resyncTagMetadata } from '../../organize/service.js';
import { OrganizeError } from '../../organize/errors.js';
import { removePackageTemporaries } from '../revisions/store.js';
import { HISTORY_ERROR_CODES, HistoryError } from './errors.js';
import { commitCatalogChanges, ensureCatalogHistory, gitAvailable, hasCatalogHistory, historyActor, historyDisabled, runGit } from './git.js';

const COMPONENT_REF = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIELD = '\x1f';
const RECORD = '\x1e';

export type HistoryEntry = {
  commit: string;
  shortCommit: string;
  committedAt: string;
  summary: string;
  operation?: string;
  actor?: string;
  /** `namespace/slug` of every component the commit touched. */
  components: string[];
  /** Catalog files outside `components/` the commit touched, e.g. `metadata.json`. */
  files: string[];
};

export type HistoryHealth = {
  enabled: boolean;
  reason?: 'disabled' | 'git-missing' | 'not-initialized';
  uncommittedPaths: string[];
};

export type UndoResult = {
  commit?: string;
  restoredTo: string;
  undone: HistoryEntry[];
};

export type RestoreResult = {
  commit?: string;
  component: string;
  restoredFrom: string;
  removed: boolean;
};

async function requireHistory(catalogRoot: string): Promise<string> {
  const root = resolve(catalogRoot);
  if (historyDisabled()) throw new HistoryError(HISTORY_ERROR_CODES.unavailable, 'Catalog history is turned off (BLOCKBASE_HISTORY).', { catalogRoot: root });
  if (!(await gitAvailable())) throw new HistoryError(HISTORY_ERROR_CODES.unavailable, 'Catalog history needs git on PATH.', { catalogRoot: root });
  const status = await ensureCatalogHistory(root).catch((error: unknown) => {
    throw new HistoryError(HISTORY_ERROR_CODES.failed, 'The catalog repository could not be created.', { catalogRoot: root, cause: error instanceof Error ? error.message : String(error) });
  });
  if (!status.enabled) throw new HistoryError(HISTORY_ERROR_CODES.unavailable, 'The catalog root does not exist.', { catalogRoot: root });
  return root;
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await runGit(root, args);
  if (result.code !== 0) throw new HistoryError(HISTORY_ERROR_CODES.failed, `git ${args[0]} failed.`, { args, stderr: result.stderr.trim() });
  return result.stdout;
}

function touched(paths: string[]): { components: string[]; files: string[] } {
  const components = new Set<string>();
  const files = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/');
    if (parts[0] === 'components' && parts.length >= 3) components.add(`${parts[1]}/${parts[2]}`);
    else files.add(parts[0] === 'inbox' && parts.length >= 2 ? `inbox/${parts[1]}` : path);
  }
  return { components: [...components].sort(), files: [...files].sort() };
}

function parseLog(stdout: string): HistoryEntry[] {
  return stdout
    .split(RECORD)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [header, ...paths] = record.split('\n');
      const [commit, shortCommit, committedAt, summary, operation, actor] = header.split(FIELD);
      return { commit, shortCommit, committedAt, summary, operation: operation?.trim() || undefined, actor: actor?.trim() || undefined, ...touched(paths.map((path) => path.trim()).filter(Boolean)) };
    });
}

const LOG_FORMAT = `--format=${RECORD}${['%H', '%h', '%cI', '%s', '%(trailers:key=Blockbase-Operation,valueonly,separator=)', '%(trailers:key=Blockbase-Actor,valueonly,separator=)'].join(FIELD)}`;

async function logEntries(root: string, args: string[]): Promise<HistoryEntry[]> {
  return parseLog(await git(root, ['log', LOG_FORMAT, '--name-only', ...args]));
}

/** Resolves an id, slug, or `namespace/slug` to the component's catalog path; `namespace/slug` also names a component that no longer exists. */
async function componentRef(root: string, input: string): Promise<string> {
  try {
    const component = resolveCatalogComponent(await listCatalogComponents(root), input);
    return `${component.namespace}/${component.slug}`;
  } catch (error) {
    if (error instanceof OrganizeError && error.code === 'ORGANIZE_NOT_FOUND' && COMPONENT_REF.test(input)) return input;
    throw error;
  }
}

async function resolveCommit(root: string, revision: string): Promise<string> {
  if (!revision || revision.startsWith('-')) throw new HistoryError(HISTORY_ERROR_CODES.invalidRevision, 'Pass a commit from `blockbase history`.', { revision });
  const result = await runGit(root, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]);
  if (result.code !== 0) throw new HistoryError(HISTORY_ERROR_CODES.invalidRevision, 'That commit is not in the catalog history.', { revision });
  return result.stdout.trim();
}

/** Refuses to roll back while another catalog write holds a lock. */
async function assertIdle(root: string): Promise<void> {
  const locks: string[] = [];
  if (await stat(`${metadataPathFor(root)}.lock`).then(() => true, () => false)) locks.push('metadata.json.lock');
  const namespaces = await readdir(join(root, 'components'), { withFileTypes: true }).catch(() => []);
  for (const namespace of namespaces) {
    if (!namespace.isDirectory()) continue;
    for (const entry of await readdir(join(root, 'components', namespace.name)).catch(() => [])) {
      if (entry.endsWith('.lock')) locks.push(`components/${namespace.name}/${entry}`);
    }
  }
  if (locks.length > 0) throw new HistoryError(HISTORY_ERROR_CODES.busy, 'Another catalog write is in progress; retry the rollback when it finishes.', { locks });
}

async function readVersion(path: string, key: 'manifestVersion' | 'metadataVersion'): Promise<number | undefined> {
  try {
    const value = (JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>)[key];
    return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Snapshots the optimistic-concurrency versions a rollback is about to rewind. */
async function versionsBefore(root: string, components: string[]): Promise<Map<string, { key: 'manifestVersion' | 'metadataVersion'; version: number }>> {
  const versions = new Map<string, { key: 'manifestVersion' | 'metadataVersion'; version: number }>();
  for (const component of components) {
    const path = join(root, 'components', component, 'component.json');
    const version = await readVersion(path, 'manifestVersion');
    if (version !== undefined) versions.set(path, { key: 'manifestVersion', version });
  }
  const metadataVersion = await readVersion(metadataPathFor(root), 'metadataVersion');
  if (metadataVersion !== undefined) versions.set(metadataPathFor(root), { key: 'metadataVersion', version: metadataVersion });
  return versions;
}

/**
 * Restored files carry older version numbers; moving them past the pre-rollback
 * value keeps a client that read the newer state from writing over the rollback.
 */
async function advanceVersions(versions: Map<string, { key: 'manifestVersion' | 'metadataVersion'; version: number }>): Promise<void> {
  for (const [path, { key, version }] of versions) {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    value[key] = Math.max(typeof value[key] === 'number' ? (value[key] as number) : 0, version) + 1;
    await writeFile(path, stableStringify(value));
  }
}

async function changedBetween(root: string, from: string, pathspec: string): Promise<string[]> {
  return touched((await git(root, ['diff', '--name-only', from, 'HEAD', '--', pathspec])).split('\n').filter(Boolean)).components;
}

export async function catalogHistoryHealth(catalogRoot: string): Promise<HistoryHealth> {
  const root = resolve(catalogRoot);
  if (historyDisabled()) return { enabled: false, reason: 'disabled', uncommittedPaths: [] };
  if (!(await gitAvailable())) return { enabled: false, reason: 'git-missing', uncommittedPaths: [] };
  if (!(await hasCatalogHistory(root))) return { enabled: false, reason: 'not-initialized', uncommittedPaths: [] };
  const status = await runGit(root, ['status', '--porcelain', '--untracked-files=all']);
  return { enabled: true, uncommittedPaths: status.stdout.split('\n').filter(Boolean).map((line) => line.slice(3)) };
}

export async function listCatalogHistory(catalogRoot: string, options: { component?: string; limit?: number } = {}): Promise<{ entries: HistoryEntry[]; component?: string }> {
  const root = await requireHistory(catalogRoot);
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1) throw new HistoryError(HISTORY_ERROR_CODES.invalidArgument, 'The history limit must be a positive integer.', { limit });
  const component = options.component ? await componentRef(root, options.component) : undefined;
  const entries = await logEntries(root, ['-n', String(limit), ...(component ? ['--', `components/${component}`] : [])]);
  return { entries, ...(component ? { component } : {}) };
}

/**
 * Rolls the whole catalog back by `steps` commits, or to `to`, as one new
 * commit. Nothing is rewritten, so an undo can itself be undone.
 */
export async function undoCatalogChanges(catalogRoot: string, options: { steps?: number; to?: string } = {}): Promise<UndoResult> {
  const root = await requireHistory(catalogRoot);
  await assertIdle(root);
  await commitCatalogChanges(root, 'Record changes made outside Blockbase', { 'Blockbase-Operation': 'external' });
  let target: string;
  if (options.to !== undefined) target = await resolveCommit(root, options.to);
  else {
    const steps = options.steps ?? 1;
    if (!Number.isInteger(steps) || steps < 1) throw new HistoryError(HISTORY_ERROR_CODES.invalidArgument, 'Undo steps must be a positive integer.', { steps });
    const count = Number((await git(root, ['rev-list', '--count', 'HEAD'])).trim());
    if (steps >= count) throw new HistoryError(HISTORY_ERROR_CODES.nothingToUndo, 'There are not that many changes to undo.', { steps, available: count - 1 });
    target = await resolveCommit(root, `HEAD~${steps}`);
  }
  const undone = await logEntries(root, [`${target}..HEAD`]);
  if (undone.length === 0) throw new HistoryError(HISTORY_ERROR_CODES.nothingToUndo, 'The catalog already matches that commit.', { restoredTo: target });
  const changed = await changedBetween(root, target, 'components');
  const versions = await versionsBefore(root, changed);
  await git(root, ['restore', `--source=${target}`, '--staged', '--worktree', '--', '.']);
  // Ignored crash leftovers (`*.tmp-*`) would keep an emptied package folder alive; clean them before git clean.
  for (const component of changed) await removePackageTemporaries(join(root, 'components', component));
  await git(root, ['clean', '-d', '-f', '-q', '--', 'components', 'inbox']);
  await advanceVersions(versions);
  const label = undone.length === 1 ? undone[0].summary : `${undone.length} changes`;
  const commit = await commitCatalogChanges(root, `Undo ${label}`, { 'Blockbase-Operation': 'history.undo', 'Blockbase-Actor': historyActor(), 'Blockbase-Restores': target, 'Blockbase-Undoes': undone.map((entry) => entry.shortCommit).join(' ') });
  await rebuildIndex({ catalogRoot: root });
  return { commit, restoredTo: target, undone };
}

/** Puts one component back as it was at `revision`; if it did not exist then, it is removed. */
export async function restoreCatalogComponent(catalogRoot: string, input: string, revision: string): Promise<RestoreResult> {
  const root = await requireHistory(catalogRoot);
  await assertIdle(root);
  const component = await componentRef(root, input);
  await commitCatalogChanges(root, 'Record changes made outside Blockbase', { 'Blockbase-Operation': 'external' });
  const source = await resolveCommit(root, revision);
  const pathspec = `components/${component}`;
  const existedThen = (await runGit(root, ['cat-file', '-e', `${source}:${pathspec}`])).code === 0;
  const existsNow = (await runGit(root, ['ls-files', '--error-unmatch', '--', pathspec])).code === 0;
  if (!existedThen && !existsNow) throw new HistoryError(HISTORY_ERROR_CODES.invalidRevision, 'That component is in neither the commit nor the current catalog.', { component, revision });
  const versions = await versionsBefore(root, [component]);
  if (existedThen) await git(root, ['restore', `--source=${source}`, '--staged', '--worktree', '--', pathspec]);
  else await git(root, ['rm', '-r', '--quiet', '--', pathspec]);
  await git(root, ['clean', '-d', '-f', '-q', '--', pathspec]);
  await advanceVersions(versions);
  await resyncTagMetadata(root);
  const short = (await git(root, ['rev-parse', '--short', source])).trim();
  const commit = await commitCatalogChanges(root, existedThen ? `Restore ${component} to ${short}` : `Remove ${component} (absent at ${short})`, { 'Blockbase-Operation': 'history.restore', 'Blockbase-Actor': historyActor(), 'Blockbase-Restores': source });
  await rebuildIndex({ catalogRoot: root });
  return { commit, component, restoredFrom: source, removed: !existedThen };
}
