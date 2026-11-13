import type { Plugin } from 'vite';

/** Lets framer-export generated.jsx paint under Vite Suspense. */
export function dumpSuspensePlugin(): Plugin {
  return {
    name: 'framer-dump-suspense',
    enforce: 'pre',
    transform(code, id) {
      const normalized = id.replace(/\\/g, '/');
      if (normalized.endsWith('/framer-core/framer.js')) {
        const from = 'var shouldSuspenseBoundariesBeActive = false';
        if (!code.includes(from)) return;
        return { code: code.replaceAll(from, 'var shouldSuspenseBoundariesBeActive = true'), map: null };
      }
      if (!normalized.includes('/framer-core/') || !normalized.endsWith('.generated.jsx')) return;
      if (!code.includes('iconModuleUrl') || code.includes('/* @vite-ignore */')) return;
      const next = code.replaceAll('/* webpackIgnore: true */', '/* webpackIgnore: true */ /* @vite-ignore */');
      if (next === code) return;
      return { code: next, map: null };
    },
  };
}
