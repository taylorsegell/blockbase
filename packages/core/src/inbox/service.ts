import { randomBytes } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { CONTRACT_VERSION, stableStringify } from '@blockbase/contracts';
import { importSourceWithExtras, type ImportExtras, type ImportedWithExtras } from '../import/extras.js';
import { importPaste, type ImportedPaste } from '../import/paste.js';
import { importSource } from '../import/service.js';
import { parseTwentyFirstPaste } from '../import/twentyfirst.js';
import { recordCatalogOperation } from '../store/history/git.js';
import type { ImportOptions } from '../import/types.js';
import { INBOX_ERROR_CODES, InboxError } from './errors.js';

export type InboxKind = 'paste' | 'path';

export type InboxItem = {
  schemaVersion: typeof CONTRACT_VERSION;
  id: string;
  kind: InboxKind;
  label: string;
  addedAt: string;
  originalPath: string | null;
  entryPoint: string | null;
  /** Present only for a 21st.dev paste; every other item has no `from` key. */
  from?: '21st';
};

export type InboxItemView = InboxItem & {
  payloadPath: string;
};

export type InboxAddPasteOptions = {
  catalogRoot: string;
  content: string;
  label?: string;
  entryPoint?: string;
  /** '21st': the paste is checked now and parked as payload/paste.txt for a 21st.dev paste import. */
  from?: '21st';
  now?: Date;
};

export type InboxAddPathOptions = {
  catalogRoot: string;
  sourcePath: string;
  label?: string;
  entryPoint?: string;
  now?: Date;
};

export type InboxImportOptions = ImportOptions & {
  catalogRoot: string;
  /** Provenance options and tags, applied as on `import`. */
  extras?: ImportExtras;
};

export type InboxImported = ImportedWithExtras | ImportedPaste;

export type InboxImportResult = { item: InboxItemView; imported: InboxImported; discarded: boolean };

const TWENTYFIRST_PASTE_FILE = 'paste.txt';

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FILE_NAME_PATTERN = /^[\w.-]+$/;

export function inboxRootFor(catalogRoot: string): string {
  return join(resolve(catalogRoot), 'inbox');
}

function itemDirectory(catalogRoot: string, id: string): string {
  assertId(id);
  return join(inboxRootFor(catalogRoot), id);
}

function assertId(id: string): void {
  if (!ID_PATTERN.test(id)) throw new InboxError(INBOX_ERROR_CODES.invalidId, 'Inbox ids must be lowercase letters, numbers, and hyphens.', { id });
}

function assertFileName(name: string): string {
  if (!FILE_NAME_PATTERN.test(name) || name === '.' || name === '..') {
    throw new InboxError(INBOX_ERROR_CODES.invalidPath, 'An inbox entry point must be a single file name.', { entryPoint: name });
  }
  return name;
}

function assertOutsideCatalog(catalogRoot: string, sourcePath: string): string {
  const root = resolve(catalogRoot);
  const source = resolve(sourcePath);
  if (source === root || source.startsWith(`${root}${sep}`)) {
    throw new InboxError(INBOX_ERROR_CODES.invalidPath, 'Inbox sources must live outside the catalog.', { path: source });
  }
  return source;
}

function createId(now: Date): string {
  const day = now.toISOString().slice(0, 10).replaceAll('-', '');
  return `${day}-${randomBytes(3).toString('hex')}`;
}

async function writeItem(directory: string, item: InboxItem): Promise<void> {
  await writeFile(join(directory, 'item.json'), stableStringify(item));
}

async function readItemFile(directory: string): Promise<InboxItem> {
  const value = JSON.parse(await readFile(join(directory, 'item.json'), 'utf8')) as Partial<InboxItem>;
  if (value.schemaVersion !== CONTRACT_VERSION || typeof value.id !== 'string' || (value.kind !== 'paste' && value.kind !== 'path') || typeof value.label !== 'string' || typeof value.addedAt !== 'string') {
    throw new InboxError(INBOX_ERROR_CODES.notFound, 'The inbox item record is unreadable.', { path: directory });
  }
  return {
    schemaVersion: CONTRACT_VERSION,
    id: value.id,
    kind: value.kind,
    label: value.label,
    addedAt: value.addedAt,
    originalPath: typeof value.originalPath === 'string' ? value.originalPath : null,
    entryPoint: typeof value.entryPoint === 'string' ? value.entryPoint : null,
    ...(value.from === '21st' ? { from: '21st' as const } : {}),
  };
}

function view(catalogRoot: string, item: InboxItem): InboxItemView {
  return { ...item, payloadPath: join(itemDirectory(catalogRoot, item.id), 'payload') };
}

export async function addInboxPaste(options: InboxAddPasteOptions): Promise<InboxItemView> {
  return recordCatalogOperation<InboxItemView>(options.catalogRoot, { operation: 'inbox.add', summary: (item) => `inbox add ${item.id}` }, async () => {
    if (options.content.length === 0) throw new InboxError(INBOX_ERROR_CODES.emptyPaste, 'An inbox paste must contain bytes.');
    const twentyFirst = options.from === '21st';
    // Read the paste now so an unreadable one is refused before anything is parked.
    if (twentyFirst) parseTwentyFirstPaste(options.content);
    const entryPoint = twentyFirst ? null : assertFileName(options.entryPoint ?? 'source.tsx');
    const item = await reserveItem(options.catalogRoot, {
      kind: 'paste',
      label: options.label?.trim() || (entryPoint ?? '21st paste'),
      originalPath: null,
      entryPoint,
      from: twentyFirst ? '21st' : undefined,
      now: options.now,
    });
    const directory = itemDirectory(options.catalogRoot, item.id);
    const payload = join(directory, 'payload');
    try {
      await mkdir(payload, { recursive: true });
      await writeFile(join(payload, entryPoint ?? TWENTYFIRST_PASTE_FILE), options.content);
      await writeItem(directory, item);
    } catch (error) {
      // A cleanup failure must not hide the original error.
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof InboxError) throw error;
      throw new InboxError(INBOX_ERROR_CODES.copyFailed, 'The inbox paste could not be stored.', { cause: error instanceof Error ? error.message : String(error) });
    }
    return view(options.catalogRoot, item);
  });
}

export async function addInboxPath(options: InboxAddPathOptions): Promise<InboxItemView> {
  return recordCatalogOperation<InboxItemView>(options.catalogRoot, { operation: 'inbox.add', summary: (item) => `inbox add ${item.id}` }, async () => {
    const sourcePath = assertOutsideCatalog(options.catalogRoot, options.sourcePath);
    let info;
    try {
      info = await stat(sourcePath);
    } catch {
      throw new InboxError(INBOX_ERROR_CODES.invalidPath, 'The inbox source path does not exist.', { path: sourcePath });
    }
    if (!info.isFile() && !info.isDirectory()) throw new InboxError(INBOX_ERROR_CODES.invalidPath, 'The inbox source must be a file or directory.', { path: sourcePath });
    const entryPoint = options.entryPoint ? assertFileName(options.entryPoint) : null;
    const item = await reserveItem(options.catalogRoot, {
      kind: 'path',
      label: options.label?.trim() || basename(sourcePath),
      originalPath: sourcePath,
      entryPoint,
      now: options.now,
    });
    const directory = itemDirectory(options.catalogRoot, item.id);
    const payload = join(directory, 'payload');
    try {
      // A nested repository would make the catalog history unable to stage anything.
      if (info.isDirectory()) await cp(sourcePath, payload, { recursive: true, filter: (path) => basename(path) !== '.git' });
      else {
        await mkdir(payload, { recursive: true });
        await cp(sourcePath, join(payload, basename(sourcePath)));
      }
      await writeItem(directory, item);
    } catch (error) {
      // A cleanup failure must not hide the original error.
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof InboxError) throw error;
      throw new InboxError(INBOX_ERROR_CODES.copyFailed, 'The inbox source could not be copied.', { path: sourcePath, cause: error instanceof Error ? error.message : String(error) });
    }
    return view(options.catalogRoot, item);
  });
}

async function reserveItem(catalogRoot: string, input: { kind: InboxKind; label: string; originalPath: string | null; entryPoint: string | null; from?: '21st'; now?: Date }): Promise<InboxItem> {
  const root = inboxRootFor(catalogRoot);
  await mkdir(root, { recursive: true });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = createId(input.now ?? new Date());
    const directory = join(root, id);
    try {
      await mkdir(directory);
      return {
        schemaVersion: CONTRACT_VERSION,
        id,
        kind: input.kind,
        label: input.label,
        addedAt: (input.now ?? new Date()).toISOString(),
        originalPath: input.originalPath,
        entryPoint: input.entryPoint,
        ...(input.from ? { from: input.from } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new InboxError(INBOX_ERROR_CODES.copyFailed, 'An inbox id could not be reserved.');
}

export async function listInbox(catalogRoot: string): Promise<InboxItemView[]> {
  const entries = await readdir(inboxRootFor(catalogRoot), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const items: InboxItemView[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    try {
      items.push(view(catalogRoot, await readItemFile(join(inboxRootFor(catalogRoot), entry.name))));
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      if (error instanceof InboxError || error instanceof SyntaxError || missing) continue;
      throw error;
    }
  }
  return items.sort((left, right) => left.addedAt.localeCompare(right.addedAt) || left.id.localeCompare(right.id));
}

export async function showInboxItem(catalogRoot: string, id: string): Promise<InboxItemView> {
  const directory = itemDirectory(catalogRoot, id);
  try {
    return view(catalogRoot, await readItemFile(directory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new InboxError(INBOX_ERROR_CODES.notFound, 'The inbox item was not found.', { id });
    throw error;
  }
}

export async function discardInboxItem(catalogRoot: string, id: string): Promise<InboxItemView> {
  return recordCatalogOperation<InboxItemView>(catalogRoot, { operation: 'inbox.discard', summary: (item) => `inbox discard ${item.id}` }, async () => {
    const item = await showInboxItem(catalogRoot, id);
    await rm(itemDirectory(catalogRoot, id), { recursive: true, force: true });
    return item;
  });
}

export async function importInboxItem(catalogRoot: string, id: string, options: Omit<InboxImportOptions, 'catalogRoot'> = {}): Promise<InboxImportResult> {
  return recordCatalogOperation<InboxImportResult>(catalogRoot, { operation: 'inbox.import', summary: (result) => `inbox import ${result.item.id} → ${result.imported.manifest.namespace}/${result.imported.manifest.slug}` }, async () => {
    const item = await showInboxItem(catalogRoot, id);
    const imported = item.from === '21st'
      ? await importPaste(await readFile(join(item.payloadPath, TWENTYFIRST_PASTE_FILE), 'utf8'), { ...options, catalogRoot })
      : await importPayload(catalogRoot, item, options);
    let discarded = true;
    try {
      await rm(itemDirectory(catalogRoot, id), { recursive: true, force: true });
    } catch {
      discarded = false;
    }
    return { item, imported, discarded };
  });
}

async function importPayload(catalogRoot: string, item: InboxItemView, options: Omit<InboxImportOptions, 'catalogRoot'>): Promise<ImportedWithExtras> {
  const payload = item.payloadPath;
  const info = await stat(payload);
  let source = payload;
  if (info.isDirectory()) {
    const children = await readdir(payload);
    if (item.entryPoint && children.includes(item.entryPoint) && children.length === 1) source = join(payload, item.entryPoint);
    else if (!item.entryPoint && children.length === 1) {
      const only = join(payload, children[0]);
      if ((await stat(only)).isFile()) source = only;
    }
  }
  const importOptions = { ...options, catalogRoot, entryPoint: options.entryPoint ?? item.entryPoint ?? undefined };
  return options.extras ? importSourceWithExtras(source, importOptions) : importSource(source, importOptions);
}

export async function inboxPayloadFiles(catalogRoot: string, id: string): Promise<string[]> {
  const item = await showInboxItem(catalogRoot, id);
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push(relative(item.payloadPath, path));
    }
  }
  await visit(item.payloadPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  return files.sort();
}
