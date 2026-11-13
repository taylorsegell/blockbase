import type { SourceEnvelope } from '@blockbase/contracts';

export const PREVIEW_POLICY_VERSION = '1' as const;

/**
 * The only package code that a preview may link. Local relative imports are
 * allowed after they have been copied into the disposable preparation root.
 * This is intentionally a small list: adding a package is a security policy
 * change, not a convenience default.
 */
export const PREVIEW_DEPENDENCY_ALLOWLIST = Object.freeze([
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
] as const);

export const PREVIEW_EXECUTION_POLICY = Object.freeze({
  schemaVersion: PREVIEW_POLICY_VERSION,
  dependencyPolicy: {
    allowlistedPackages: PREVIEW_DEPENDENCY_ALLOWLIST,
    allowRelativeImports: true,
    installDependencies: false,
  },
  buildPolicy: {
    allowlistedCommands: [] as readonly string[],
    allowlistedPlugins: [] as readonly string[],
    shell: false,
    packageScripts: false,
  },
  networkPolicy: {
    loopbackOnly: true,
    previewNetwork: 'none' as const,
  },
  browserPolicy: {
    iframeSandbox: ['allow-scripts'] as readonly string[],
    hostBridge: false,
    topNavigation: false,
    popups: false,
  },
});

export type PreviewDependencyFinding = {
  specifier: string;
  sourcePath: string;
  kind: 'package' | 'builtin' | 'relative' | 'absolute';
  allowed: boolean;
  reason?: string;
};

export type PreviewDependencyReport = {
  dependencies: string[];
  findings: PreviewDependencyFinding[];
  allowed: boolean;
};

export type PreviewRefusalCode =
  | 'invalid-request'
  | 'dependency-not-allowlisted'
  | 'unsupported-build-plugin'
  | 'path-escape'
  | 'symlink-escape'
  | 'build-required'
  | 'build-failed'
  | 'timeout'
  | 'cleanup-failed';

export type PreviewRefusal = {
  code: PreviewRefusalCode;
  message: string;
  details?: Record<string, unknown>;
};

export type PreviewRefusalResult = {
  schemaVersion: '1';
  status: 'refused';
  refusal: PreviewRefusal;
};

function packageName(specifier: string): string {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0] ?? specifier;
}

function allowedPackage(specifier: string, allowlist: readonly string[]): boolean {
  return allowlist.some((allowed) => specifier === allowed || specifier.startsWith(`${allowed}/`));
}

function importSpecifiers(text: string): string[] {
  const results = new Set<string>();
  // This is deliberately a lexical check. It never parses, imports, or
  // evaluates source and errs toward refusal for unusual import syntax.
  const patterns = [
    /\bimport\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) results.add(match[1]);
  }
  return [...results].sort();
}

export function inspectPreviewDependencies(
  envelope: SourceEnvelope,
  allowlist: readonly string[] = PREVIEW_DEPENDENCY_ALLOWLIST,
): PreviewDependencyReport {
  const findings: PreviewDependencyFinding[] = [];
  for (const file of envelope.files) {
    for (const specifier of importSpecifiers(file.content)) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      const absolute = specifier.startsWith('/') || /^[A-Za-z]:[\\/]/.test(specifier);
      const builtin = specifier.startsWith('node:') || ['fs', 'fs/promises', 'child_process', 'net', 'http', 'https', 'module', 'os', 'path', 'process'].includes(specifier);
      const allowed = relative ? true : !absolute && !builtin && allowedPackage(specifier, allowlist);
      findings.push({
        specifier,
        sourcePath: file.path,
        kind: relative ? 'relative' : absolute ? 'absolute' : builtin ? 'builtin' : 'package',
        allowed,
        ...(allowed ? {} : { reason: absolute ? 'Absolute imports cannot leave the prepared root.' : builtin ? 'Node builtins are not available to preview content.' : `Package '${packageName(specifier)}' is not in the preview allowlist.` }),
      });
    }
  }
  const dependencies = [...new Set(findings.filter((finding) => finding.kind === 'package').map((finding) => packageName(finding.specifier)))].sort();
  return { dependencies, findings, allowed: findings.every((finding) => finding.allowed) };
}

export function inspectPreviewPlugins(plugins: readonly string[], allowlist: readonly string[] = PREVIEW_EXECUTION_POLICY.buildPolicy.allowlistedPlugins): PreviewRefusal | undefined {
  const unsupported = plugins.find((plugin) => !allowlist.includes(plugin));
  if (!unsupported) return undefined;
  return {
    code: 'unsupported-build-plugin',
    message: `Build plugin '${unsupported}' is not supported by the constrained preview runner.`,
    details: { plugin: unsupported, allowlistedPlugins: [...allowlist] },
  };
}
