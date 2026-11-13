import { CONTRACT_VERSION, type NormalizationReport, type SourceEnvelope, type SourceFile } from '@blockbase/contracts';
import { revisionHash } from '../import/local.js';
import type { ImportedRevision } from '../import/types.js';
import { extractTokens, type TokenExtractionResult, type TokenResidual } from '../tokens/index.js';

export const NORMALIZER_VERSION = '1.0.0';
export const NORMALIZATION_OUTCOMES = ['safe', 'needs-review', 'unsupported'] as const;
export type NormalizationOutcome = (typeof NORMALIZATION_OUTCOMES)[number];

export type NormalizedFile = {
  path: string;
  content: string;
  sourceHash: string;
  contentHash: string;
};

export type DependencyRecord = {
  specifier: string;
  packageName?: string;
  path?: string;
  /** Source path-alias prefix (e.g. `@/`, `~/`, a tsconfig `paths` key) when the import went through one. */
  alias?: string;
  kind: 'local' | 'third-party';
  status: 'resolved' | 'missing' | 'external';
  filePath: string;
  line: number;
  column: number;
};

export type DependencyContract = {
  dependencies: DependencyRecord[];
};

export type NormalizationResidualEvidence = TokenResidual & {
  fallback: string;
};

export type NormalizationResult = {
  sourceHash: string;
  normalizerVersion: string;
  status: NormalizationOutcome;
  normalizedFiles: NormalizedFile[];
  /** Alias retained for callers that use the contract's shorter field name. */
  files: NormalizedFile[];
  tokenContract: TokenExtractionResult['contract'];
  dependencyContract: DependencyContract;
  occurrences: TokenExtractionResult['occurrences'];
  coverage: TokenExtractionResult['coverage'];
  residuals: NormalizationResidualEvidence[];
  report: NormalizationReport & { status: 'complete' | 'partial' | 'unsupported'; outcome: NormalizationOutcome; residuals: NormalizationResidualEvidence[] };
};

type SourceLike = SourceEnvelope | ImportedRevision | { envelope: SourceEnvelope };

function sourceOf(input: SourceLike): SourceEnvelope {
  return 'envelope' in input ? input.envelope : input;
}

function lineColumn(content: string, offset: number): { line: number; column: number } {
  const before = content.slice(0, Math.max(0, offset));
  const lastBreak = before.lastIndexOf('\n');
  return { line: before.split('\n').length, column: offset - lastBreak };
}

function importPackageName(specifier: string): string {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

function localImportPath(filePath: string, specifier: string, files: readonly SourceFile[]): string | undefined {
  const base = filePath.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') base.pop();
    else base.push(segment);
  }
  const joined = base.join('/');
  const candidates = [joined, ...['.tsx', '.ts', '.jsx', '.js', '.css'].map((extension) => `${joined}${extension}`), ...['index.tsx', 'index.ts', 'index.jsx', 'index.js'].map((name) => `${joined}/${name}`)];
  return candidates.find((candidate) => files.some((file) => file.path === candidate));
}

type SourceAlias = { prefix: string; targets: string[] };

function stripJsonComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1');
}

/**
 * Path aliases the source was written against: root tsconfig/jsconfig `paths` entries, plus the
 * conventional `@/` and `~/` prefixes (resolved from the source root) when the config does not
 * define them. `@/x` has an empty npm scope, so it can never collide with a scoped `@scope/pkg`.
 */
function sourceAliases(files: readonly SourceFile[]): SourceAlias[] {
  const aliases = new Map<string, string[]>();
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const config = files.find((file) => file.path === name);
    if (!config) continue;
    try {
      const parsed = JSON.parse(stripJsonComments(config.content)) as { compilerOptions?: { baseUrl?: unknown; paths?: Record<string, unknown> } };
      const baseUrl = typeof parsed.compilerOptions?.baseUrl === 'string' ? parsed.compilerOptions.baseUrl.replace(/^\.\/?/, '').replace(/\/$/, '') : '';
      for (const [key, value] of Object.entries(parsed.compilerOptions?.paths ?? {})) {
        if (!Array.isArray(value) || aliases.has(key.replace(/\*$/, ''))) continue;
        const targets = value.filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => [baseUrl, entry.replace(/^\.\//, '').replace(/\*$/, '')].filter(Boolean).join('/').replace(/\/+$/, ''));
        if (targets.length > 0) aliases.set(key.replace(/\*$/, ''), targets);
      }
    } catch {
      // An unparsable config contributes no aliases; the conventional prefixes below still apply.
    }
  }
  for (const prefix of ['@/', '~/']) if (!aliases.has(prefix)) aliases.set(prefix, ['']);
  return [...aliases.entries()].map(([prefix, targets]) => ({ prefix, targets })).sort((a, b) => b.prefix.length - a.prefix.length || a.prefix.localeCompare(b.prefix));
}

function aliasMatch(specifier: string, aliases: readonly SourceAlias[]): SourceAlias | undefined {
  return aliases.find((alias) => alias.prefix.endsWith('/') ? specifier.startsWith(alias.prefix) : specifier === alias.prefix);
}

function dependencies(envelope: SourceEnvelope): { contract: DependencyContract; residuals: NormalizationResidualEvidence[] } {
  const records: DependencyRecord[] = [];
  const residuals: NormalizationResidualEvidence[] = [];
  const files = envelope.files;
  const seen = new Set<string>();
  const aliases = sourceAliases(files);
  for (const file of files.slice().sort((a, b) => a.path.localeCompare(b.path))) {
    const expression = /(?:import\s+(?:[\s\S]*?\s+from\s+)?|export\s+[\s\S]*?\s+from\s+|require\s*\()(['"])([^'"]+)\1/g;
    let match: RegExpExecArray | null;
    while ((match = expression.exec(file.content))) {
      const specifier = match[2];
      const offset = match.index + match[0].lastIndexOf(specifier);
      const point = lineColumn(file.content, offset);
      const key = `${file.path}:${specifier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (specifier.startsWith('.')) {
        const resolved = localImportPath(file.path, specifier, files);
        records.push({ specifier, ...(resolved ? { path: resolved } : {}), kind: 'local', status: resolved ? 'resolved' : 'missing', filePath: file.path, ...point });
        if (!resolved) residuals.push({ path: file.path, line: point.line, column: point.column, kind: 'unresolved-import', reason: `Local import '${specifier}' is not present in the immutable source envelope.`, source: specifier, fallbackValue: specifier, fallback: specifier, confidence: 0 });
      } else if (aliasMatch(specifier, aliases)) {
        const alias = aliasMatch(specifier, aliases)!;
        const rest = specifier.slice(alias.prefix.length);
        const resolved = alias.targets.map((target) => localImportPath('', `./${[target, rest].filter(Boolean).join('/')}`, files)).find(Boolean);
        records.push({ specifier, alias: alias.prefix, ...(resolved ? { path: resolved } : {}), kind: 'local', status: resolved ? 'resolved' : 'missing', filePath: file.path, ...point });
        if (!resolved) residuals.push({ path: file.path, line: point.line, column: point.column, kind: 'unresolved-import', reason: `Path-alias import '${specifier}' is not present in the immutable source envelope; it is not an npm dependency.`, source: specifier, fallbackValue: specifier, fallback: specifier, confidence: 0 });
      } else {
        records.push({ specifier, packageName: importPackageName(specifier), kind: 'third-party', status: 'external', filePath: file.path, ...point });
      }
    }
    for (const dynamic of file.content.matchAll(/\b(?:import|require)\s*\(\s*([^'"`][^)]*)\)/g)) {
      const offset = dynamic.index!;
      const point = lineColumn(file.content, offset);
      residuals.push({ path: file.path, line: point.line, column: point.column, kind: 'unsupported-syntax', reason: 'Dynamic imports are outside the deterministic dependency subset.', source: dynamic[0], fallbackValue: dynamic[0], fallback: dynamic[0], confidence: 0 });
    }
  }
  records.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line || a.column - b.column || a.specifier.localeCompare(b.specifier));
  return { contract: { dependencies: records }, residuals };
}

function unsupportedDynamicStyles(envelope: SourceEnvelope): NormalizationResidualEvidence[] {
  const residuals: NormalizationResidualEvidence[] = [];
  for (const file of envelope.files) {
    if (!/\.(?:tsx|jsx|ts|js)$/.test(file.path)) continue;
    for (const match of file.content.matchAll(/\bstyle\s*=\s*\{(?!\{)([^}]+)\}/g)) {
      const point = lineColumn(file.content, match.index!);
      residuals.push({ path: file.path, line: point.line, column: point.column, kind: 'unsupported-syntax', reason: 'Style objects must contain only statically represented values.', source: match[0], fallbackValue: match[0], fallback: match[0], confidence: 0 });
    }
  }
  return residuals;
}

function normalizeStatus(residuals: readonly NormalizationResidualEvidence[]): NormalizationOutcome {
  if (residuals.some((residual) => residual.kind === 'unsupported-syntax')) return 'unsupported';
  return residuals.length > 0 ? 'needs-review' : 'safe';
}

/**
 * Normalize a canonical source envelope without changing or executing its files.
 * The emitted source currently preserves the exact source bytes; tokenization is
 * represented by occurrences and contracts until a destination adapter chooses an
 * expression that is valid for its styling system.
 */
export function normalizeSource(input: SourceLike): NormalizationResult {
  const envelope = sourceOf(input);
  const sourceHash = revisionHash(envelope);
  const extraction = extractTokens(envelope, `tokens_${sourceHash.slice(-12)}`);
  const dependencyResult = dependencies(envelope);
  const residuals: NormalizationResidualEvidence[] = [
    ...extraction.residuals.map((entry) => ({ ...entry, fallback: entry.fallbackValue })),
    ...dependencyResult.residuals,
    ...unsupportedDynamicStyles(envelope),
  ].sort((a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0) || a.reason.localeCompare(b.reason));
  const status = normalizeStatus(residuals);
  const reportStatus = status === 'safe' ? 'complete' : status === 'needs-review' ? 'partial' : 'unsupported';
  const coverage = { total: extraction.coverage.normalized + residuals.length, normalized: extraction.coverage.normalized, residual: residuals.length };
  const report: NormalizationResult['report'] = {
    schemaVersion: CONTRACT_VERSION,
    sourceHash,
    normalizerVersion: NORMALIZER_VERSION,
    status: reportStatus,
    outcome: status,
    coverage,
    residuals,
    warnings: residuals.map((entry) => `${entry.path}:${entry.line}:${entry.column} ${entry.reason}`),
  };
  return {
    sourceHash,
    normalizerVersion: NORMALIZER_VERSION,
    status,
    normalizedFiles: envelope.files.slice().sort((a, b) => a.path.localeCompare(b.path)).map((file) => ({ path: file.path, content: file.content, sourceHash: file.contentHash, contentHash: file.contentHash })),
    files: envelope.files.slice().sort((a, b) => a.path.localeCompare(b.path)).map((file) => ({ path: file.path, content: file.content, sourceHash: file.contentHash, contentHash: file.contentHash })),
    tokenContract: extraction.contract,
    dependencyContract: dependencyResult.contract,
    occurrences: extraction.occurrences,
    coverage,
    residuals,
    report,
  };
}

export const normalizeRevision = normalizeSource;
export const normalizeEnvelope = normalizeSource;
export const normalize = normalizeSource;
