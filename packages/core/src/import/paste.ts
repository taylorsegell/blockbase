import { join } from 'node:path';
import { CONTRACT_VERSION, type SourceEnvelope } from '@blockbase/contracts';
import { rebuildIndex } from '../index/store.js';
import { recordCatalogOperation } from '../store/history/git.js';
import { RevisionStore } from '../store/revisions/store.js';
import { IMPORT_ERROR_CODES, ImportError } from './errors.js';
import {
  applyExtras,
  assertSourceType,
  DEMO_FILE_NAME,
  fileStem,
  installAfterCommit,
  prepareDemo,
  RAW_PASTE_FILE_NAME,
  type DemoSummary,
  type ImportExtrasOptions,
} from './extras.js';
import { canonicalizeSourceEnvelope, revisionHash, sha256 } from './local.js';
import { defaultManifest, importSummary, manifestFor, residualWarnings } from './service.js';
import { parseTwentyFirstPaste, TWENTYFIRST_PLACEHOLDER_COMPONENT, type TwentyFirstReading } from './twentyfirst.js';
import type { ImportedRevision, SourceContent } from './types.js';

export const PASTE_LOCATOR = '<paste>';

export type ImportedPaste = ImportedRevision & {
  reading: TwentyFirstReading;
  demo: DemoSummary;
  rawPastePath: string;
  /** Everything worth reporting about this paste; the same strings are recorded in quality.warnings. */
  warnings: string[];
};

// react and react-dom are covered by the manifest's framework (PD-4).
const FRAMEWORK_PACKAGES = new Set(['react', 'react-dom']);

function pasteEnvelope(files: { path: string; content: string }[], entryPoint: string, provenance: { sourceType: SourceEnvelope['provenance']['sourceType']; locator: string }): SourceEnvelope {
  return {
    schemaVersion: CONTRACT_VERSION,
    sourceType: 'paste',
    files: files.map((file) => ({ path: file.path, content: file.content, contentHash: sha256(Buffer.from(file.content, 'utf8')) })),
    assets: [],
    entryPoint,
    provenance,
  };
}

/** Install-list packages first (their range wins), then packages only seen in import lines (range `*`). */
function pasteDependencies(reading: TwentyFirstReading): { name: string; range: string }[] {
  const byName = new Map<string, string>();
  for (const item of reading.installPackages) if (!FRAMEWORK_PACKAGES.has(item.name) && !byName.has(item.name)) byName.set(item.name, item.range);
  for (const name of reading.importPackages) if (!FRAMEWORK_PACKAGES.has(name) && !byName.has(name)) byName.set(name, '*');
  return [...byName].map(([name, range]) => ({ name, range }));
}

/** `@/components/ui/*` and other `@/` or `~/` imports that name no pasted file. */
function aliasWarnings(reading: TwentyFirstReading, pastedStems: Set<string>): string[] {
  const warnings: string[] = [];
  for (const specifier of reading.aliasImports) {
    const last = specifier.split('/').pop() ?? '';
    if (pastedStems.has(fileStem(last))) continue;
    warnings.push(specifier.startsWith('@/components/ui/') ? `shadcn-missing:${specifier}` : `alias-unresolved:${specifier}`);
  }
  return warnings;
}

/**
 * Import a 21st.dev paste: the non-demo files become the block, the demo is installed beside
 * component.json, and the raw paste is kept as source-paste.txt. Nothing is written when the paste cannot be read.
 */
export async function importPaste(text: string, options: ImportExtrasOptions): Promise<ImportedPaste> {
  const extras = options.extras ?? {};
  assertSourceType(extras.sourceType);
  const reading = parseTwentyFirstPaste(text);
  if (!reading.hasFilenames && !options.displayName) {
    throw new ImportError(IMPORT_ERROR_CODES.pasteNameRequired, 'This paste has no file names. Give the component a name to import it.');
  }
  const provenance = { sourceType: extras.sourceType ?? 'paste' as const, locator: extras.sourceUrl ?? PASTE_LOCATOR };
  let blockFiles = reading.files.filter((file) => file.role !== 'demo').map(({ path, content }) => ({ path, content }));
  let entryPoint = reading.entryPoint;
  const entryStems = [fileStem(reading.entryPoint)];
  if (!reading.hasFilenames) {
    // The slug rule lives in defaultManifest; reuse it so the file name matches the component slug.
    const placeholder: SourceContent = { envelope: pasteEnvelope(blockFiles, entryPoint, provenance), assetBytes: new Map() };
    const slug = defaultManifest(placeholder, options).slug;
    entryPoint = `${slug}.tsx`;
    entryStems.push(slug);
    blockFiles = blockFiles.map((file) => (file.path === TWENTYFIRST_PLACEHOLDER_COMPONENT ? { ...file, path: entryPoint } : file));
  }
  const pastedStems = [...new Set([...reading.files.filter((file) => file.role !== 'demo').map((file) => fileStem(file.path)), ...entryStems])];
  const demoFile = reading.files.find((file) => file.role === 'demo');
  const demo = demoFile ? prepareDemo(demoFile.content, pastedStems, entryStems) : undefined;
  const source = pasteEnvelope(blockFiles, entryPoint, provenance);

  return recordCatalogOperation<ImportedPaste>(options.catalogRoot, { operation: 'import', summary: importSummary }, async () => {
    const envelope = canonicalizeSourceEnvelope(source);
    const content: SourceContent = { envelope, assetBytes: new Map() };
    const revisionId = revisionHash(envelope);
    const warnings = [...new Set([
      ...residualWarnings(content),
      ...aliasWarnings(reading, new Set(pastedStems)),
      ...reading.suspicions.map((suspicion) => `paste-suspect:${suspicion.file}:${suspicion.reason}`),
      ...(demo?.warnings ?? []),
    ])];
    const manifest = applyExtras(manifestFor(content, options, revisionId), { dependencies: pasteDependencies(reading), authorHint: reading.authorHint, warnings }, extras);
    const imported = await new RevisionStore(options).commit(content, manifest, { expectedRevision: options.expectedRevision, expectedManifestVersion: options.expectedManifestVersion });
    const files = [{ name: RAW_PASTE_FILE_NAME, content: text }];
    if (demo) files.push({ name: DEMO_FILE_NAME, content: demo.content });
    await installAfterCommit(imported, files, options.catalogRoot);
    await rebuildIndex({ catalogRoot: options.catalogRoot });
    return {
      ...imported,
      reading,
      demo: demo
        ? { installed: true, path: join(imported.componentPath, DEMO_FILE_NAME), rewrites: demo.rewrites, warnings: demo.warnings }
        : { installed: false, rewrites: [], warnings: [] },
      rawPastePath: join(imported.componentPath, RAW_PASTE_FILE_NAME),
      warnings,
    };
  });
}
