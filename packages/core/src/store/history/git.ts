import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * The catalog root is its own git repository so a wrong agent change can be
 * rolled back. History is best effort: a missing or failing git never blocks a
 * catalog operation, and `doctor` reports the gap instead.
 */
export const CATALOG_GITIGNORE = [
  '# Managed by Blockbase. Derived, machine-local, and in-flight files stay out of history.',
  'index.sqlite',
  'index.sqlite-*',
  '.blockbase-service.json',
  'migration-report.json',
  '.DS_Store',
  'node_modules/',
  '*.lock',
  '*.tmp-*',
  '.staging-*',
  '',
].join('\n');

const IDENTITY = ['-c', 'user.name=Blockbase', '-c', 'user.email=blockbase@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.quotePath=false'];
const MAX_BUFFER = 64 * 1024 * 1024;

export type GitResult = { code: number; stdout: string; stderr: string };

export type HistoryStatus = {
  enabled: boolean;
  reason?: 'disabled' | 'git-missing' | 'catalog-missing';
  initialized?: boolean;
};

export type OperationTrailers = Record<string, string | undefined>;

const operationScope = new AsyncLocalStorage<true>();
let gitPresent: Promise<boolean> | undefined;

export function historyDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['0', 'off', 'false', 'no'].includes(String(env.BLOCKBASE_HISTORY ?? '').trim().toLowerCase());
}

/** Who made the change, e.g. `mcp:claude-code`; recorded as a commit trailer. */
export function historyActor(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.BLOCKBASE_ACTOR?.trim();
  return value ? value.replace(/[\r\n]/g, ' ') : undefined;
}

export function runGit(catalogRoot: string, args: string[]): Promise<GitResult> {
  return new Promise((resolveRun) => {
    execFile('git', ['-C', catalogRoot, ...IDENTITY, ...args], { maxBuffer: MAX_BUFFER, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -1) : 0;
      resolveRun({ code, stdout: String(stdout), stderr: String(stderr || (error && code === -1 ? error.message : '')) });
    });
  });
}

export function gitAvailable(): Promise<boolean> {
  gitPresent ??= runGit(process.cwd(), ['--version']).then((result) => result.code === 0);
  return gitPresent;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function hasCatalogHistory(catalogRoot: string): Promise<boolean> {
  return exists(join(resolve(catalogRoot), '.git'));
}

/** Retries while another Blockbase process holds git's index lock. */
async function runGitLocked(catalogRoot: string, args: string[]): Promise<GitResult> {
  let result = await runGit(catalogRoot, args);
  for (let attempt = 1; attempt <= 20 && result.code !== 0 && /index\.lock/.test(result.stderr); attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25 * attempt));
    result = await runGit(catalogRoot, args);
  }
  return result;
}

function trailerLines(trailers: OperationTrailers): string {
  return Object.entries(trailers)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
    .map(([key, value]) => `${key}: ${value.replace(/[\r\n]/g, ' ')}`)
    .join('\n');
}

/** Stages every change under the catalog root and commits it; returns the new commit, or undefined when nothing changed. */
export async function commitCatalogChanges(catalogRoot: string, subject: string, trailers: OperationTrailers = {}): Promise<string | undefined> {
  const root = resolve(catalogRoot);
  const added = await runGitLocked(root, ['add', '-A']);
  if (added.code !== 0) throw new Error(`git add failed: ${added.stderr.trim()}`);
  const staged = await runGit(root, ['diff', '--cached', '--quiet']);
  if (staged.code === 0) return undefined;
  const body = trailerLines(trailers);
  const committed = await runGitLocked(root, ['commit', '--quiet', '--no-verify', '-m', subject.replace(/[\r\n]+/g, ' '), ...(body ? ['-m', body] : [])]);
  if (committed.code !== 0) throw new Error(`git commit failed: ${committed.stderr.trim()}`);
  const head = await runGit(root, ['rev-parse', 'HEAD']);
  return head.code === 0 ? head.stdout.trim() : undefined;
}

/** Creates the catalog repository on first use and records whatever the catalog already holds. */
export async function ensureCatalogHistory(catalogRoot: string): Promise<HistoryStatus> {
  if (historyDisabled()) return { enabled: false, reason: 'disabled' };
  if (!(await gitAvailable())) return { enabled: false, reason: 'git-missing' };
  const root = resolve(catalogRoot);
  if (!(await exists(root))) return { enabled: false, reason: 'catalog-missing' };
  if (await hasCatalogHistory(root)) return { enabled: true, initialized: false };
  const initialized = await runGit(root, ['init', '--quiet', '--initial-branch=main']);
  if (initialized.code !== 0) throw new Error(`git init failed: ${initialized.stderr.trim()}`);
  if (!(await exists(join(root, '.gitignore')))) await writeFile(join(root, '.gitignore'), CATALOG_GITIGNORE);
  await commitCatalogChanges(root, 'Start catalog history', { 'Blockbase-Operation': 'history.start' });
  return { enabled: true, initialized: true };
}

export type CatalogOperation<T> = {
  /** Stable dotted name such as `tag.add`; recorded as the `Blockbase-Operation` trailer. */
  operation: string;
  /** One-line commit subject describing the change the operation made. */
  summary: (result: T) => string;
};

async function bestEffort(task: () => Promise<unknown>): Promise<void> {
  try {
    await task();
  } catch {
    // History must never fail a catalog write; `doctor` surfaces a broken repository.
  }
}

/**
 * Runs one catalog mutation and commits its result. Changes made outside
 * Blockbase since the last commit are committed first, so each operation stays
 * its own revertible commit. Nested operations (an inbox import calling the
 * importer) fold into the outermost one.
 */
export async function recordCatalogOperation<T>(catalogRoot: string, describe: CatalogOperation<T>, run: () => Promise<T>): Promise<T> {
  if (operationScope.getStore()) return run();
  return operationScope.run(true, async () => {
    const root = resolve(catalogRoot);
    await bestEffort(async () => {
      if ((await ensureCatalogHistory(root)).enabled) await commitCatalogChanges(root, 'Record changes made outside Blockbase', { 'Blockbase-Operation': 'external' });
    });
    const result = await run();
    await bestEffort(async () => {
      if ((await ensureCatalogHistory(root)).enabled) await commitCatalogChanges(root, describe.summary(result), { 'Blockbase-Operation': describe.operation, 'Blockbase-Actor': historyActor() });
    });
    return result;
  });
}
