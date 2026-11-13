import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CONTRACT_VERSION, parseSourceEnvelope, stableStringify, type SourceEnvelope, type SourceFile } from '@blockbase/contracts';
import { chooseEntryPoint as sharedChooseEntryPoint } from '../catalog/entry-point.js';
import { IMPORT_ERROR_CODES, ImportError } from './errors.js';
import type { SourceContent } from './types.js';

const SOURCE_EXTENSIONS = new Set(['.css', '.js', '.jsx', '.json', '.mjs', '.ts', '.tsx', '.md', '.txt', '.yaml', '.yml']);

export function sha256(value: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function pathError(code: 'pathTraversal' | 'invalidPath', path: string): never {
  throw new ImportError(
    IMPORT_ERROR_CODES[code],
    code === 'pathTraversal' ? 'Imported paths must remain within the source root.' : 'Imported paths must be relative, non-empty, and normalized.',
    { path },
  );
}

/** Normalize a contract path and reject traversal before it reaches the filesystem. */
export function assertSafeRelativePath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || isAbsolute(value)) {
    return pathError('invalidPath', String(value));
  }
  const normalized = value.split('/').filter(Boolean).join('/');
  if (normalized !== value || normalized === '.' || value.split('/').some((part) => part === '..' || part === '.')) {
    return pathError('pathTraversal', value);
  }
  return normalized;
}

function relativePath(root: string, path: string): string {
  const result = relative(root, path).split(sep).join('/');
  if (!result || result === '..' || result.startsWith('../') || isAbsolute(result)) pathError('pathTraversal', result);
  return assertSafeRelativePath(result);
}

async function assertSourceRoot(path: string): Promise<string> {
  const absolute = resolve(path);
  let info;
  try {
    info = await lstat(absolute);
  } catch {
    throw new ImportError(IMPORT_ERROR_CODES.sourceNotFound, 'The import source does not exist.', { path: absolute });
  }
  if (info.isSymbolicLink()) {
    const target = await realpath(absolute).catch(() => absolute);
    throw new ImportError(
      target === absolute ? IMPORT_ERROR_CODES.symlinkUnsupported : IMPORT_ERROR_CODES.symlinkEscape,
      'Symbolic links are not accepted as import sources.',
      { path: absolute },
    );
  }
  if (!info.isFile() && !info.isDirectory()) throw new ImportError(IMPORT_ERROR_CODES.invalidPath, 'The import source must be a file or directory.', { path: absolute });
  return absolute;
}

async function assertRegularFile(path: string, root: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    const target = await realpath(path).catch(() => path);
    const escaped = !target.startsWith(`${root}${sep}`);
    throw new ImportError(escaped ? IMPORT_ERROR_CODES.symlinkEscape : IMPORT_ERROR_CODES.symlinkUnsupported, 'Symbolic links are not accepted in imported sources.', { path });
  }
  if (!info.isFile()) throw new ImportError(IMPORT_ERROR_CODES.invalidPath, 'Import sources may contain regular files only.', { path });
}

function isAsset(path: string): boolean {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  return !SOURCE_EXTENSIONS.has(extension);
}

function chooseEntryPoint(paths: string[], explicit?: string): string {
  if (explicit !== undefined) {
    const entry = assertSafeRelativePath(explicit);
    if (!paths.includes(entry)) throw new ImportError(IMPORT_ERROR_CODES.entryPointNotFound, 'The requested import entry point does not exist.', { entryPoint: entry });
    return entry;
  }
  const entry = sharedChooseEntryPoint(paths, { fallback: false });
  if (!entry) throw new ImportError(IMPORT_ERROR_CODES.entryPointMissing, 'The source does not declare or contain an entry point.');
  return entry;
}

function canonicalFiles(files: SourceFile[]): SourceFile[] {
  return files.slice().sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Canonicalize a source envelope without executing or interpreting source code.
 * Hashes are checked against content, and ordering is independent of directory traversal order.
 */
export function canonicalizeSourceEnvelope(input: SourceEnvelope): SourceEnvelope {
  let envelope: SourceEnvelope;
  try {
    envelope = parseSourceEnvelope(input);
  } catch (error) {
    throw new ImportError(IMPORT_ERROR_CODES.invalidEnvelope, error instanceof Error ? error.message : 'The source envelope is invalid.');
  }
  const files = canonicalFiles(envelope.files.map((file) => {
    const path = assertSafeRelativePath(file.path);
    const actual = sha256(Buffer.from(file.content, 'utf8'));
    if (file.contentHash !== actual) throw new ImportError(IMPORT_ERROR_CODES.hashMismatch, 'A source file content hash does not match its content.', { path, expected: actual, received: file.contentHash });
    return { ...file, path, contentHash: actual };
  }));
  const assets = envelope.assets.slice().sort((left, right) => left.path.localeCompare(right.path)).map((asset) => ({ ...asset, path: assertSafeRelativePath(asset.path) }));
  if (new Set(files.map((file) => file.path)).size !== files.length || new Set(assets.map((asset) => asset.path)).size !== assets.length || files.some((file) => assets.some((asset) => asset.path === file.path))) {
    throw new ImportError(IMPORT_ERROR_CODES.invalidEnvelope, 'The source envelope contains duplicate paths.');
  }
  const entryPoint = envelope.entryPoint === undefined ? undefined : assertSafeRelativePath(envelope.entryPoint);
  if (entryPoint !== undefined && !files.some((file) => file.path === entryPoint)) throw new ImportError(IMPORT_ERROR_CODES.entryPointNotFound, 'The requested import entry point does not exist.', { entryPoint });
  return { ...envelope, files, assets, ...(entryPoint ? { entryPoint } : {}) };
}

export async function readLocalSource(path: string, options: { entryPoint?: string } = {}): Promise<SourceContent> {
  const root = await assertSourceRoot(path);
  const info = await lstat(root);
  if (info.isFile()) {
    const bytes = await readFile(root);
    const relativeName = assertSafeRelativePath(root.slice(root.lastIndexOf(sep) + 1));
    if (isAsset(relativeName)) throw new ImportError(IMPORT_ERROR_CODES.entryPointMissing, 'The source does not contain a React entry point.', { path: relativeName });
    const envelope: SourceEnvelope = {
      schemaVersion: CONTRACT_VERSION,
      sourceType: 'file',
      files: [{ path: relativeName, content: bytes.toString('utf8'), contentHash: sha256(bytes) }],
      assets: [],
      entryPoint: chooseEntryPoint([relativeName], options.entryPoint),
      provenance: { sourceType: 'file', locator: root },
    };
    return { envelope: canonicalizeSourceEnvelope(envelope), assetBytes: new Map() };
  }

  const files: SourceFile[] = [];
  const assetBytes = new Map<string, Uint8Array>();
  async function visit(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) await assertRegularFile(absolute, root);
      if (entry.isDirectory()) await visit(absolute);
      else {
        await assertRegularFile(absolute, root);
        const pathName = relativePath(root, absolute);
        const bytes = await readFile(absolute);
        if (isAsset(pathName)) {
          assetBytes.set(pathName, bytes);
        } else {
          files.push({ path: pathName, content: bytes.toString('utf8'), contentHash: sha256(bytes) });
        }
      }
    }
  }
  await visit(root);
  const entryPoint = chooseEntryPoint(files.map((file) => file.path), options.entryPoint);
  const envelope: SourceEnvelope = {
    schemaVersion: CONTRACT_VERSION,
    sourceType: 'directory',
    files,
    assets: [...assetBytes.keys()].sort().map((pathName) => ({ path: pathName, mediaType: 'application/octet-stream', contentHash: sha256(assetBytes.get(pathName)!) })),
    entryPoint,
    provenance: { sourceType: 'directory', locator: root },
  };
  return { envelope: canonicalizeSourceEnvelope(envelope), assetBytes };
}

export function readStdinSource(content: string, options: { entryPoint?: string; locator?: string } = {}): SourceContent {
  const entryPoint = options.entryPoint ?? 'stdin.tsx';
  const envelope: SourceEnvelope = {
    schemaVersion: CONTRACT_VERSION,
    sourceType: 'stdin',
    files: [{ path: entryPoint, content, contentHash: sha256(Buffer.from(content, 'utf8')) }],
    assets: [],
    entryPoint,
    provenance: { sourceType: 'stdin', locator: options.locator ?? '<stdin>' },
  };
  return { envelope: canonicalizeSourceEnvelope(envelope), assetBytes: new Map() };
}

export function revisionHash(envelope: SourceEnvelope): string {
  const canonical = canonicalizeSourceEnvelope(envelope);
  const manifest = {
    files: canonical.files.map((file) => [file.path, file.contentHash]),
    assets: canonical.assets.map((asset) => [asset.path, asset.contentHash]),
  };
  return sha256(stableStringify(manifest));
}

export function sourceFingerprint(envelope: SourceEnvelope): string {
  return revisionHash(envelope);
}
