import type { ComponentManifest } from '@blockbase/contracts';

const INDEX_CANDIDATES = ['index.tsx', 'index.ts', 'index.jsx', 'index.js'];

export type ChooseEntryPointOptions = {
  /**
   * When false, only an `index.*` file (root first, then nested) or a sole file qualifies.
   * The importer uses this so an ambiguous multi-file source still requires an explicit entry point.
   * Default: true (fall back to the first component-like file, then the first file).
   */
  fallback?: boolean;
};

function sorted(files: string[]): string[] {
  return files.slice().sort();
}

/**
 * One shared entry-point rule.
 * 1. Root `index.tsx|ts|jsx|js` (in that order).
 * 2. Nested `*\/index.tsx|ts|jsx|js` (same order, first path alphabetically).
 * 3. (fallback) first `.tsx/.jsx`, then first `.ts/.js`, then first file, alphabetically.
 * With `fallback: false`, step 3 only applies to a source with exactly one file.
 */
export function chooseEntryPoint(files: string[], options: ChooseEntryPointOptions = {}): string | undefined {
  const root = INDEX_CANDIDATES.find((candidate) => files.includes(candidate));
  if (root) return root;
  const ordered = sorted(files);
  for (const candidate of INDEX_CANDIDATES) {
    const nested = ordered.find((path) => path.endsWith(`/${candidate}`));
    if (nested) return nested;
  }
  if (options.fallback === false) return files.length === 1 ? files[0] : undefined;
  return ordered.find((path) => /\.(?:tsx|jsx)$/.test(path))
    ?? ordered.find((path) => /\.(?:ts|js)$/.test(path))
    ?? ordered[0];
}

/** Prefer the persisted manifest entry point when it still names a file; otherwise use the shared heuristic. */
export function resolveEntryPoint(manifest: Pick<ComponentManifest, 'entryPoint' | 'displayName'>, files: string[]): string | undefined {
  if (manifest.entryPoint && files.includes(manifest.entryPoint)) return manifest.entryPoint;
  return chooseEntryPoint(files);
}
