import { basename, extname } from 'node:path';
import { CONTRACT_VERSION, parseComponentManifest, type ComponentManifest, type SourceEnvelope } from '@blockbase/contracts';
import { rebuildIndex } from '../index/store.js';
import { recordCatalogOperation } from '../store/history/git.js';
import { RevisionStore } from '../store/revisions/store.js';
import { IMPORT_ERROR_CODES, ImportError } from './errors.js';
import { canonicalizeSourceEnvelope, readLocalSource, readStdinSource, revisionHash } from './local.js';
import type { ImportedRevision, ImportOptions, LocalImportInput, SourceContent } from './types.js';

export function importSummary(imported: ImportedRevision): string {
  return `import ${imported.manifest.namespace}/${imported.manifest.slug}@${imported.revisionId.slice('sha256:'.length, 'sha256:'.length + 8)}`;
}

function slugify(value: string): string {
  const result = value.replace(/\.[^.]+$/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  if (!result) throw new ImportError(IMPORT_ERROR_CODES.invalidPath, 'The component slug cannot be empty.');
  return result;
}

// XML namespace URIs (inline SVG `xmlns`, `xmlns:xlink`) are identifiers, not fetched assets.
const REMOTE_URL = /https?:\/\/(?!www\.w3\.org\/)/;

export function residualWarnings(source: SourceContent): string[] {
  const warnings: string[] = [];
  for (const file of source.envelope.files) {
    if (basename(file.path).toLowerCase() === 'demo.tsx') warnings.push(`demo-file:${file.path}`);
    if (REMOTE_URL.test(file.content)) warnings.push(`remote-url:${file.path}`);
  }
  return warnings;
}

export function defaultManifest(source: SourceContent, options: ImportOptions, revisionId?: string): ComponentManifest {
  const entryPoint = source.envelope.entryPoint ?? source.envelope.files[0]?.path;
  const displayName = options.displayName ?? basename(entryPoint ?? 'component', extname(entryPoint ?? ''));
  const slug = options.slug ?? slugify(displayName);
  const namespace = options.namespace ?? 'local';
  const sourceHash = revisionId ?? 'sha256:pending';
  return {
    schemaVersion: CONTRACT_VERSION,
    componentId: `cmp_${slugify(namespace)}_${slugify(slug)}`,
    namespace,
    slug,
    displayName,
    description: `Imported React component ${displayName}.`,
    aliases: [],
    tags: [],
    category: 'imported',
    framework: 'react',
    stylingModes: [],
    currentRevision: sourceHash,
    ...(source.envelope.entryPoint ? { entryPoint: source.envelope.entryPoint } : {}),
    provenance: {
      sourceType: source.envelope.provenance.sourceType,
      locator: source.envelope.provenance.locator,
      license: 'unknown',
      attributionStatus: 'unknown',
    },
    compatibility: {
      language: 'typescript',
      runtime: 'react',
      frameworkRange: '*',
      clientServer: 'either',
    },
    interface: { props: [], slots: [], events: [], accessibilityNotes: [] },
    dependencies: [],
    tokens: { schemaVersion: CONTRACT_VERSION, contractId: `tokens_${slug}_v1`, tokens: [] },
    quality: {
      parseStatus: 'passed',
      previewStatus: 'unknown',
      normalizationCoverage: 0,
      riskLevel: 'low',
      warnings: residualWarnings(source),
    },
    integrity: { sourceHash, assetHashes: [] },
  };
}

export function manifestFor(source: SourceContent, options: ImportOptions, revisionId: string): ComponentManifest {
  const manifest = options.manifest ? structuredClone(options.manifest) : defaultManifest(source, options, revisionId);
  if (typeof manifest.framework !== 'string') {
    throw new ImportError(IMPORT_ERROR_CODES.invalidEnvelope, 'The component manifest is invalid.');
  }
  if (manifest.framework.toLowerCase() !== 'react') {
    throw new ImportError(IMPORT_ERROR_CODES.unsupportedFramework, 'Only React source envelopes are supported by this importer.', { framework: manifest.framework });
  }
  const updated: ComponentManifest = {
    ...manifest,
    currentRevision: revisionId,
    ...(manifest.entryPoint === undefined && source.envelope.entryPoint ? { entryPoint: source.envelope.entryPoint } : {}),
    provenance: {
      ...manifest.provenance,
      sourceType: source.envelope.provenance.sourceType,
      locator: source.envelope.provenance.locator,
    },
  };
  try {
    parseComponentManifest(updated);
  } catch (error) {
    throw new ImportError(IMPORT_ERROR_CODES.invalidEnvelope, error instanceof Error ? error.message : 'The component manifest is invalid.');
  }
  return updated;
}

export async function importEnvelope(source: SourceEnvelope, options: ImportOptions, assetBytes: Map<string, Uint8Array> = new Map()): Promise<ImportedRevision> {
  return recordCatalogOperation<ImportedRevision>(options.catalogRoot, { operation: 'import', summary: importSummary }, async () => {
    const envelope = canonicalizeSourceEnvelope(source);
    const content: SourceContent = { envelope, assetBytes };
    const revisionId = revisionHash(envelope);
    const manifest = manifestFor(content, options, revisionId);
    const imported = await new RevisionStore(options).commit(content, manifest, { expectedRevision: options.expectedRevision, expectedManifestVersion: options.expectedManifestVersion });
    await rebuildIndex({ catalogRoot: options.catalogRoot });
    return imported;
  });
}

async function stdinContent(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

export async function importSource(input: LocalImportInput, options: ImportOptions): Promise<ImportedRevision> {
  return recordCatalogOperation<ImportedRevision>(options.catalogRoot, { operation: 'import', summary: importSummary }, async () => {
    const source = typeof input === 'string' ? input : input.source;
    let content: SourceContent;
    if (source === '-') {
      const stdin = typeof input === 'string' ? options.stdin ?? await stdinContent() : input.stdin ?? options.stdin ?? await stdinContent();
      content = readStdinSource(stdin, { entryPoint: options.entryPoint, locator: '<stdin>' });
    } else {
      content = await readLocalSource(source, { entryPoint: options.entryPoint });
    }
    const envelope = canonicalizeSourceEnvelope(content.envelope);
    const revisionId = revisionHash(envelope);
    const manifest = manifestFor({ ...content, envelope }, options, revisionId);
    const imported = await new RevisionStore(options).commit({ ...content, envelope }, manifest, { expectedRevision: options.expectedRevision, expectedManifestVersion: options.expectedManifestVersion });
    await rebuildIndex({ catalogRoot: options.catalogRoot });
    return imported;
  });
}

export const importLocalSource = importSource;
export const importComponent = importSource;
export async function importFile(path: string, options: ImportOptions): Promise<ImportedRevision> {
  return importSource(path, options);
}
export async function importDirectory(path: string, options: ImportOptions): Promise<ImportedRevision> {
  return importSource(path, options);
}
export async function importStdin(content: string, options: ImportOptions): Promise<ImportedRevision> {
  return importSource('-', { ...options, stdin: content });
}
export { canonicalizeSourceEnvelope, readLocalSource, readStdinSource } from './local.js';
