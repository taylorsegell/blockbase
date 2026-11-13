import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { SOURCE_TYPES, type ComponentManifest, type SourceType } from '@blockbase/contracts';
import { rebuildIndex } from '../index/store.js';
import { recordCatalogOperation } from '../store/history/git.js';
import { RevisionStore } from '../store/revisions/store.js';
import { IMPORT_ERROR_CODES, ImportError } from './errors.js';
import { assertSafeRelativePath, canonicalizeSourceEnvelope, readLocalSource, readStdinSource, revisionHash } from './local.js';
import { importSummary, manifestFor } from './service.js';
import type { ImportedRevision, ImportOptions, LocalImportInput, SourceContent } from './types.js';

/** Source details and a demo given by the person importing; explicit values always win. */
export type ImportExtras = {
  sourceType?: SourceType;
  sourceUrl?: string;
  license?: string;
  author?: string;
  tags?: string[];
  /** Directory imports only: this file becomes the catalog-page demo instead of part of the block. */
  demoFile?: string;
};

/** Values read from the source itself; they fill gaps but never override explicit options. */
export type DerivedExtras = {
  dependencies?: { name: string; range: string }[];
  authorHint?: string;
  tags?: string[];
  warnings?: string[];
};

export type ImportExtrasOptions = ImportOptions & { extras?: ImportExtras };

export type DemoRewrite = { from: string; to: string };
export type PreparedDemo = { content: string; rewrites: DemoRewrite[]; warnings: string[] };
export type DemoSummary = { installed: boolean; path?: string; rewrites: DemoRewrite[]; warnings: string[] };
export type ImportedWithExtras = ImportedRevision & { demo?: DemoSummary };

export const DEMO_FILE_NAME = 'demo.tsx';
export const RAW_PASTE_FILE_NAME = 'source-paste.txt';
export const DEMO_BLOCK_SPECIFIER = '@block';

const unique = <T>(values: T[]): T[] => [...new Set(values)];

/** Throw when an explicit source type is not one the envelope contract accepts. */
export function assertSourceType(value: string | undefined): void {
  if (value !== undefined && !(SOURCE_TYPES as readonly string[]).includes(value)) {
    throw new ImportError(IMPORT_ERROR_CODES.invalidEnvelope, `The source type must be one of: ${SOURCE_TYPES.join(', ')}.`, { sourceType: value });
  }
}

/** Merge order: the base manifest, then values read from the source, then explicit options. */
export function applyExtras(manifest: ComponentManifest, derived: DerivedExtras = {}, explicit: ImportExtras = {}): ComponentManifest {
  const tags = unique([...manifest.tags, ...(derived.tags ?? []), ...(explicit.tags ?? [])]);
  const known = new Set(manifest.dependencies.map((dependency) => dependency.name));
  const dependencies = [...manifest.dependencies];
  for (const dependency of derived.dependencies ?? []) {
    if (known.has(dependency.name)) continue;
    known.add(dependency.name);
    dependencies.push({ name: dependency.name, range: dependency.range, kind: 'runtime' });
  }
  const license = explicit.license ?? manifest.provenance.license ?? 'unknown';
  const author = explicit.author ?? derived.authorHint ?? manifest.provenance.author;
  const attributionStatus = author !== undefined || explicit.license !== undefined ? 'known' : manifest.provenance.attributionStatus;
  return {
    ...manifest,
    tags,
    dependencies,
    provenance: {
      ...manifest.provenance,
      license,
      attributionStatus,
      ...(author !== undefined ? { author } : {}),
    },
    quality: { ...manifest.quality, warnings: unique([...manifest.quality.warnings, ...(derived.warnings ?? [])]) },
  };
}

const SPECIFIER = /(\bfrom\s*|\bimport\s*)(['"])([^'"\n]+)\2/g;
const BLOCK_PATTERNS = [/^\.\/(.+)$/, /^\.\.\/(.+)$/, /^@\/components\/ui\/(.+)$/, /^@\/components\/(.+)$/];

function pastedStemOf(specifier: string): string | undefined {
  for (const pattern of BLOCK_PATTERNS) {
    const match = pattern.exec(specifier);
    if (match) return match[1];
  }
  return undefined;
}

const isLocalSpecifier = (specifier: string): boolean => ['.', '/', '@/', '~/'].some((prefix) => specifier.startsWith(prefix));

/**
 * Point the demo at the block: only specifiers that name a pasted file that is the entry point
 * become `@block`. Every byte outside a rewritten specifier is kept as given.
 */
export function prepareDemo(demoText: string, pastedStems: string[], entryStem: string | string[]): PreparedDemo {
  const stems = new Set(pastedStems);
  const entries = new Set(Array.isArray(entryStem) ? entryStem : [entryStem]);
  const rewrites: DemoRewrite[] = [];
  const warnings: string[] = [];
  let hasBlock = false;
  const content = demoText.replace(SPECIFIER, (whole, lead: string, quote: string, specifier: string) => {
    if (specifier === DEMO_BLOCK_SPECIFIER) {
      hasBlock = true;
      return whole;
    }
    const stem = pastedStemOf(specifier);
    if (stem !== undefined && stems.has(stem)) {
      if (entries.has(stem)) {
        hasBlock = true;
        rewrites.push({ from: specifier, to: DEMO_BLOCK_SPECIFIER });
        return `${lead}${quote}${DEMO_BLOCK_SPECIFIER}${quote}`;
      }
      warnings.push(`demo-import-nonentry:${specifier}`);
      return whole;
    }
    if (isLocalSpecifier(specifier)) warnings.push(`demo-import-unresolved:${specifier}`);
    return whole;
  });
  const head: string[] = [];
  if (!hasBlock) head.push('demo-no-block-import');
  if (!/\bexport\s+default\b/.test(content)) head.push('demo-no-default-export');
  return { content, rewrites, warnings: unique([...head, ...warnings]) };
}

/** File name without its extension, used to match demo imports against pasted files. */
export function fileStem(path: string): string {
  return basename(path, extname(path));
}

/** Write each file beside component.json through a temp file and a rename, so a reader never sees half a file. */
export async function installBesideManifest(componentPath: string, files: { name: string; content: string }[]): Promise<void> {
  for (const file of files) {
    const target = join(componentPath, file.name);
    const temp = `${target}.tmp-${randomUUID()}`;
    try {
      await writeFile(temp, file.content);
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true, recursive: true }).catch(() => undefined);
      throw error;
    }
  }
}

/**
 * Install files beside a just-committed manifest. On failure a fresh package is removed only when it
 * still holds the revision this call committed; otherwise the committed revision stays and the error says so.
 */
export async function installAfterCommit(imported: ImportedRevision, files: { name: string; content: string }[], catalogRoot: string): Promise<void> {
  try {
    await installBesideManifest(imported.componentPath, files);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    const fresh = (imported.manifest as ComponentManifest & { manifestVersion?: number }).manifestVersion === 1;
    if (fresh) {
      const current = await readFile(join(imported.componentPath, 'component.json'), 'utf8')
        .then((text) => (JSON.parse(text) as { currentRevision?: unknown }).currentRevision, () => undefined);
      if (current === imported.revisionId) {
        await rm(imported.componentPath, { recursive: true, force: true });
        throw new ImportError(IMPORT_ERROR_CODES.commitFailed, 'The demo or the raw paste could not be written, so nothing was imported.', { stage: 'demo', cause });
      }
      throw new ImportError(IMPORT_ERROR_CODES.commitFailed, 'The demo or the raw paste could not be written; the component was changed by another import meanwhile and was left in place.', { stage: 'demo', committed: true, cause });
    }
    await rebuildIndex({ catalogRoot }).catch(() => undefined);
    throw new ImportError(IMPORT_ERROR_CODES.commitFailed, 'The demo or the raw paste could not be written; the new revision was kept.', { stage: 'demo', committed: true, cause });
  }
}

async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

function demoError(message: string, demo: string): never {
  throw new ImportError(IMPORT_ERROR_CODES.invalidPath, message, { demo });
}

/** importSource plus source details and an optional demo file, for any local source. */
export async function importSourceWithExtras(input: LocalImportInput, options: ImportExtrasOptions): Promise<ImportedWithExtras> {
  const extras = options.extras ?? {};
  assertSourceType(extras.sourceType);
  return recordCatalogOperation<ImportedWithExtras>(options.catalogRoot, { operation: 'import', summary: importSummary }, async () => {
    const source = typeof input === 'string' ? input : input.source;
    let content: SourceContent;
    if (source === '-') {
      const stdin = typeof input === 'string' ? options.stdin ?? await stdinText() : input.stdin ?? options.stdin ?? await stdinText();
      content = readStdinSource(stdin, { entryPoint: options.entryPoint, locator: '<stdin>' });
    } else {
      content = await readLocalSource(source, { entryPoint: options.entryPoint });
    }

    let demo: { content: string; rewrites: DemoRewrite[]; warnings: string[] } | undefined;
    if (extras.demoFile !== undefined) {
      if (content.envelope.sourceType !== 'directory') demoError('A demo file can only be given for a folder import.', extras.demoFile);
      const demoPath = assertSafeRelativePath(extras.demoFile);
      const demoSource = content.envelope.files.find((file) => file.path === demoPath);
      if (!demoSource) demoError('The demo file is not in the imported folder.', demoPath);
      if (content.envelope.entryPoint === demoPath) demoError('The demo file cannot also be the entry point.', demoPath);
      const files = content.envelope.files.filter((file) => file.path !== demoPath);
      content = { ...content, envelope: { ...content.envelope, files } };
      const entryPath = content.envelope.entryPoint ?? files[0]?.path ?? '';
      demo = prepareDemo(demoSource.content, files.map((file) => fileStem(file.path)), fileStem(entryPath));
    }

    content = {
      ...content,
      envelope: {
        ...content.envelope,
        provenance: {
          ...content.envelope.provenance,
          ...(extras.sourceType !== undefined ? { sourceType: extras.sourceType } : {}),
          ...(extras.sourceUrl !== undefined ? { locator: extras.sourceUrl } : {}),
        },
      },
    };
    const envelope = canonicalizeSourceEnvelope(content.envelope);
    const revisionId = revisionHash(envelope);
    const base = manifestFor({ ...content, envelope }, options, revisionId);
    const manifest = applyExtras(base, { warnings: demo?.warnings ?? [] }, extras);
    const imported = await new RevisionStore(options).commit({ ...content, envelope }, manifest, { expectedRevision: options.expectedRevision, expectedManifestVersion: options.expectedManifestVersion });
    let summary: DemoSummary | undefined;
    if (demo) {
      await installAfterCommit(imported, [{ name: DEMO_FILE_NAME, content: demo.content }], options.catalogRoot);
      summary = { installed: true, path: join(imported.componentPath, DEMO_FILE_NAME), rewrites: demo.rewrites, warnings: demo.warnings };
    }
    await rebuildIndex({ catalogRoot: options.catalogRoot });
    return summary ? { ...imported, demo: summary } : imported;
  });
}
