import { EXIT_CODES, type ExitCode, type OperationName } from '@blockbase/contracts';
import {
  HistoryError,
  InboxError,
  OrganizeError,
  addCollectionSlug,
  addInboxPaste,
  addInboxPath,
  addTag,
  createCollection,
  deleteCollection,
  discardInboxItem,
  importInboxItem,
  listCatalogHistory,
  listCollections,
  listFamilies,
  listInbox,
  listTags,
  removeCollectionSlug,
  removeTag,
  reorderCollectionSlug,
  restoreCatalogComponent,
  setFamily,
  showInboxItem,
  undoCatalogChanges,
  type ImportExtras,
} from '@blockbase/core';
import { failure, success } from './output.js';

type LibraryArgs = {
  operation: OperationName;
  catalogRoot: string;
  source?: string;
  path?: string;
  entryPoint?: string;
  namespace?: string;
  slug?: string;
  displayName?: string;
  tag?: string;
  /** inbox add: the paste format given with --from. */
  from?: '21st';
  /** inbox import: provenance options and repeatable --tag values. */
  extras?: ImportExtras;
  id?: string;
  title?: string;
  family?: string;
  create: boolean;
  index?: number;
  steps?: number;
  to?: string;
  limit?: number;
  stdin?: string;
};

export async function executeLibrary(args: LibraryArgs): Promise<{ exitCode: ExitCode; envelope: ReturnType<typeof success> | ReturnType<typeof failure> }> {
  try {
    const data = await dispatch(args);
    const warnings = data && typeof data === 'object' && 'discarded' in data && data.discarded === false
      ? [{ code: 'INBOX_DISCARD_FAILED', message: 'The component was imported, and the inbox item is still parked.' }]
      : [];
    return { exitCode: EXIT_CODES.ok, envelope: success(args.operation, data, warnings) };
  } catch (error) {
    if (error instanceof InboxError || error instanceof OrganizeError || error instanceof HistoryError) {
      const notFound = error.code.endsWith('NOT_FOUND') || error.code === 'HISTORY_INVALID_REVISION';
      const conflict = error.code.endsWith('AMBIGUOUS') || error.code.endsWith('DUPLICATE_COLLECTION') || error.code === 'HISTORY_BUSY' || error.code === 'HISTORY_NOTHING_TO_UNDO';
      const usage = error.code === 'ORGANIZE_INVALID_ARGUMENT' || error.code === 'HISTORY_INVALID_ARGUMENT';
      const unavailable = error.code === 'HISTORY_UNAVAILABLE' || error.code === 'HISTORY_FAILED';
      if (unavailable) return { exitCode: EXIT_CODES.internal, envelope: failure(args.operation, error.code, error.message, error.details) };
      return {
        exitCode: notFound ? EXIT_CODES.notFound : conflict ? EXIT_CODES.conflict : usage ? EXIT_CODES.usage : EXIT_CODES.invalidInput,
        envelope: failure(args.operation, error.code, error.message, error.details),
      };
    }
    throw error;
  }
}

async function dispatch(args: LibraryArgs): Promise<unknown> {
  const root = args.catalogRoot;
  switch (args.operation) {
    case 'inbox.add':
      if (args.stdin !== undefined) return addInboxPaste({ catalogRoot: root, content: args.stdin, label: args.displayName, entryPoint: args.entryPoint, ...(args.from ? { from: args.from } : {}) });
      if (!args.path) throw new InboxError('INBOX_INVALID_PATH', 'inbox add requires --path or a stdin paste.');
      return addInboxPath({ catalogRoot: root, sourcePath: args.path, label: args.displayName, entryPoint: args.entryPoint });
    case 'inbox.list':
      return { items: await listInbox(root) };
    case 'inbox.show':
      return showInboxItem(root, required(args.source, 'an inbox id'));
    case 'inbox.import': {
      const result = await importInboxItem(root, required(args.source, 'an inbox id'), {
        namespace: args.namespace,
        slug: args.slug,
        displayName: args.displayName,
        entryPoint: args.entryPoint,
        ...(args.extras ? { extras: args.extras } : {}),
      });
      const imported = result.imported;
      const data = {
        inboxId: result.item.id,
        discarded: result.discarded,
        revisionId: imported.revisionId,
        packagePath: imported.packagePath,
        manifest: imported.manifest,
      };
      // Same summaries as `import - --from 21st`, so the agent can report rewrites, warnings and suspicions.
      if ('reading' in imported) {
        return {
          ...data,
          paste: {
            format: imported.reading.format,
            files: imported.reading.files.map((file) => ({ path: file.path, role: file.role })),
            entryPoint: imported.reading.entryPoint,
            authorHint: imported.reading.authorHint ?? null,
            suspicions: imported.reading.suspicions,
            normalizations: imported.reading.normalizations,
            rawPastePath: imported.rawPastePath,
            warnings: imported.warnings,
          },
          demo: imported.demo,
        };
      }
      return imported.demo ? { ...data, demo: imported.demo } : data;
    }
    case 'inbox.discard':
      return discardInboxItem(root, required(args.source, 'an inbox id'));
    case 'tag.add':
      return addTag(root, required(args.source, 'a component id or slug'), required(args.tag, '--tag'));
    case 'tag.remove':
      return removeTag(root, required(args.source, 'a component id or slug'), required(args.tag, '--tag'));
    case 'tag.list':
      return listTags(root, args.source);
    case 'collection.create':
      return createCollection(root, required(args.id, '--id'), required(args.title, '--title'));
    case 'collection.add':
      return addCollectionSlug(root, required(args.id, '--id'), required(args.slug, '--slug'));
    case 'collection.remove':
      return removeCollectionSlug(root, required(args.id, '--id'), required(args.slug, '--slug'));
    case 'collection.reorder':
      return reorderCollectionSlug(root, required(args.id, '--id'), required(args.slug, '--slug'), args.index ?? Number.NaN);
    case 'collection.delete':
      return deleteCollection(root, required(args.id, '--id'));
    case 'collection.list':
      return listCollections(root);
    case 'family.set':
      return setFamily(root, required(args.source, 'a component id or slug'), required(args.family, '--family'), { name: args.displayName, create: args.create });
    case 'family.list':
      return listFamilies(root);
    case 'history.list':
      return listCatalogHistory(root, { component: args.source, limit: args.limit });
    case 'history.undo':
      return undoCatalogChanges(root, { steps: args.steps, to: args.to });
    case 'history.restore':
      return restoreCatalogComponent(root, required(args.source, 'a component id or slug'), required(args.to, '--to'));
    default:
      throw new Error(`Unsupported library operation '${args.operation}'.`);
  }
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new OrganizeError('ORGANIZE_INVALID_ARGUMENT', `${label} is required.`);
  return value;
}
