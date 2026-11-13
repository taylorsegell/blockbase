import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { SourceEnvelope } from '@blockbase/contracts';
import { canonicalizeSourceEnvelope } from '../import/local.js';
import { PREVIEW_DEPENDENCY_ALLOWLIST, inspectPreviewDependencies, inspectPreviewPlugins, type PreviewRefusal } from './policy.js';

export type PreviewPreparation = {
  schemaVersion: '1';
  status: 'prepared';
  rootPath: string;
  entryPoint: string;
  files: string[];
  dependencies: string[];
  dependencyReport: ReturnType<typeof inspectPreviewDependencies>;
};

export type PreviewPreparationResult = PreviewPreparation | { schemaVersion: '1'; status: 'refused'; refusal: PreviewRefusal };

function refusal(code: PreviewRefusal['code'], message: string, details?: Record<string, unknown>): { schemaVersion: '1'; status: 'refused'; refusal: PreviewRefusal } {
  return { schemaVersion: '1', status: 'refused', refusal: { code, message, ...(details ? { details } : {}) } };
}

function within(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
}

/** Resolve a prepared-root path without permitting traversal or absolute paths. */
export function assertPreviewPath(root: string, path: string): string {
  if (!path || path.includes('\0') || isAbsolute(path)) throw new Error('Preview paths must be relative and non-empty.');
  const target = resolve(root, path);
  if (!within(resolve(root), target)) throw new Error('Preview paths must remain within the disposable root.');
  return target;
}

async function assertNoSymlink(path: string, root: string): Promise<void> {
  const absoluteRoot = resolve(root);
  const target = resolve(path);
  if (!within(absoluteRoot, target)) throw new Error('Preview paths must remain within the disposable root.');
  let current = absoluteRoot;
  const segments = relative(absoluteRoot, target).split(sep).filter(Boolean);
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        const destination = await realpath(current).catch(() => current);
        throw new Error(destination === current ? 'Symlinks are not supported in preview roots.' : 'Symlink escapes are not supported in preview roots.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
}

export async function createPreviewRoot(prefix = 'blockbase-preview-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function disposePreviewRoot(rootPath: string): Promise<{ removed: boolean; error?: string }> {
  try {
    await rm(rootPath, { recursive: true, force: true });
    try {
      await lstat(rootPath);
      return { removed: false, error: 'The disposable preview root still exists after cleanup.' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: true };
      throw error;
    }
  } catch (error) {
    return { removed: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function preparePreview(
  input: SourceEnvelope,
  options: { plugins?: readonly string[]; allowlistedDependencies?: readonly string[]; rootPath?: string } = {},
): Promise<PreviewPreparationResult> {
  let envelope: SourceEnvelope;
  try {
    envelope = canonicalizeSourceEnvelope(input);
  } catch (error) {
    return refusal('invalid-request', error instanceof Error ? error.message : 'The preview source envelope is invalid.');
  }
  const dependencyReport = inspectPreviewDependencies(envelope, options.allowlistedDependencies ?? PREVIEW_DEPENDENCY_ALLOWLIST);
  if (!dependencyReport.allowed) {
    return refusal('dependency-not-allowlisted', 'The component imports a dependency that the constrained preview does not support.', { findings: dependencyReport.findings.filter((finding) => !finding.allowed) });
  }
  const pluginRefusal = inspectPreviewPlugins(options.plugins ?? []);
  if (pluginRefusal) return { schemaVersion: '1', status: 'refused', refusal: pluginRefusal };
  const entryPoint = envelope.entryPoint ?? envelope.files[0]?.path;
  if (!entryPoint) return refusal('invalid-request', 'The preview source does not contain an entry point.');
  const rootPath = options.rootPath ?? await createPreviewRoot();
  try {
    // A caller may provide a test-owned temp root, but a preview may never
    // write into a catalog or destination project. This also keeps cleanup
    // bounded to the OS temporary directory.
    if (!within(resolve(tmpdir()), resolve(rootPath))) throw new Error('Disposable preview roots must be inside the operating system temporary directory.');
    try {
      const rootInfo = await lstat(rootPath);
      if (rootInfo.isSymbolicLink()) throw new Error('Symlink escapes are not supported in preview roots.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(rootPath, { recursive: true });
    await assertNoSymlink(rootPath, rootPath);
    for (const file of envelope.files) {
      const destination = assertPreviewPath(rootPath, file.path);
      await assertNoSymlink(destination, rootPath);
      await mkdir(resolve(destination, '..'), { recursive: true });
      await writeFile(destination, file.content, { encoding: 'utf8', flag: 'wx' });
    }
    for (const asset of envelope.assets) {
      // Assets are hash-only in SourceEnvelope. Preparation deliberately does
      // not synthesize bytes or reach back into the catalog to obtain them.
      assertPreviewPath(rootPath, asset.path);
    }
    return { schemaVersion: '1', status: 'prepared', rootPath, entryPoint, files: envelope.files.map((file) => file.path), dependencies: dependencyReport.dependencies, dependencyReport };
  } catch (error) {
    await disposePreviewRoot(rootPath);
    const message = error instanceof Error ? error.message : String(error);
    return { schemaVersion: '1', status: 'refused', refusal: { code: message.toLowerCase().includes('symlink') ? 'symlink-escape' : 'path-escape', message } };
  }
}

/** Read only a file already inside a prepared root. */
export async function readPreparedFile(rootPath: string, path: string): Promise<string> {
  const target = assertPreviewPath(rootPath, path);
  await assertNoSymlink(target, rootPath);
  return readFile(target, 'utf8');
}
