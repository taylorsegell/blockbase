import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createServer, searchForWorkspaceRoot, type InlineConfig } from 'vite';
import { blockbaseCatalogPlugin } from './vite-plugin-blockbase-catalog.js';
import { dumpSuspensePlugin } from './vite-plugin-dump-suspense.js';

export type PreviewServerOptions = {
  catalogRoot: string;
  port: number;
  host?: '127.0.0.1';
  allowedHosts?: string[];
  open?: boolean;
};

export type PreviewServer = {
  url: string;
  port: number;
  catalogRoot: string;
  close(): Promise<void>;
};

/** apps/preview, resolved from this file (dist/server/index.js or src/server/index.ts). */
const previewRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));

const previewRequire = createRequire(join(previewRoot, 'package.json'));

/**
 * Directory of an installed dependency, found through Node's own lookup paths from the preview
 * package. Works for pnpm's per-package node_modules and for npm's hoisted layout, where the
 * dependency sits beside this package rather than inside it.
 */
function packageDir(name: string): string {
  const paths = previewRequire.resolve.paths(name) ?? [];
  for (const base of paths) {
    const candidate = join(base, name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
  }
  throw new Error(`Cannot find dependency "${name}" from ${previewRoot}. Reinstall @blockbase/preview.`);
}

/** `pkg` or `pkg/subpath` resolved to a filesystem path through packageDir. */
const nm = (spec: string): string => {
  const parts = spec.split('/');
  const nameLength = spec.startsWith('@') ? 2 : 1;
  return resolve(packageDir(parts.slice(0, nameLength).join('/')), ...parts.slice(nameLength));
};

/** Vite's dependency pre-bundle cache. Per-user and outside the package and the catalog. */
function viteCacheDir(): string {
  if (process.env.XDG_CACHE_HOME) return join(process.env.XDG_CACHE_HOME, 'blockbase', 'vite');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'blockbase', 'vite');
  return join(homedir(), '.cache', 'blockbase', 'vite');
}

const OPTIMIZE_INCLUDE = [
  'react',
  'react-dom',
  'framer-motion',
  'motion',
  'lucide-react',
  'dotted-map',
  'recharts',
  'class-variance-authority',
  'gsap',
  'gsap/ScrollTrigger',
  '@studio-freight/lenis',
  'lenis',
  'lenis/react',
  'date-fns',
  'radix-ui',
  'react-markdown',
  // Used by the shell itself; listing them avoids a mid-session re-optimization and reload.
  'motion/react',
  'clsx',
  'tailwind-merge',
  '@radix-ui/react-slot',
  '@radix-ui/react-menubar',
  'react-icons/fi',
];

function aliases(): Record<string, string> {
  return {
    '@': resolve(previewRoot, 'src'),
    framer: resolve(previewRoot, 'src/shims/framer.ts'),
    react: nm('react'),
    'react-dom': nm('react-dom'),
    'react/jsx-runtime': nm('react/jsx-runtime'),
    'react/jsx-dev-runtime': nm('react/jsx-dev-runtime'),
    'framer-motion': nm('framer-motion'),
    'motion/react': nm('motion/dist/es/react.mjs'),
    'lucide-react': nm('lucide-react'),
    'class-variance-authority': nm('class-variance-authority'),
    'dotted-map': nm('dotted-map'),
    recharts: nm('recharts'),
    'next/image': resolve(previewRoot, 'src/shims/next-image.tsx'),
    'react-icons/fi': nm('react-icons/fi'),
    'react-icons': nm('react-icons'),
    clsx: nm('clsx'),
    'tailwind-merge': nm('tailwind-merge'),
    gsap: nm('gsap'),
    'gsap/ScrollTrigger': nm('gsap/ScrollTrigger.js'),
    '@studio-freight/lenis': nm('@studio-freight/lenis'),
    'lenis/react': nm('lenis/dist/lenis-react.mjs'),
    lenis: nm('lenis/dist/lenis.mjs'),
    'date-fns': nm('date-fns'),
    'radix-ui': nm('radix-ui'),
    'react-markdown': nm('react-markdown'),
  };
}

/**
 * The outermost `node_modules` roots holding the aliased dependencies (npm's hoisted tree, or pnpm's
 * virtual store), so Vite may serve their files and their own transitive dependencies via /@fs.
 */
function dependencyRoots(): string[] {
  const marker = `${sep}node_modules`;
  const roots = Object.values(aliases()).map((path) => {
    const at = path.indexOf(marker);
    return at === -1 ? dirname(path) : path.slice(0, at + marker.length);
  });
  return [...new Set(roots)];
}

export async function startPreviewServer(options: PreviewServerOptions): Promise<PreviewServer> {
  const catalogRoot = resolve(options.catalogRoot);
  let url = '';
  const config: InlineConfig = {
    root: previewRoot,
    configFile: false,
    // The Vite cache lives in the user cache dir: the installed package may be read-only, and it
    // must never land in the catalog.
    cacheDir: viteCacheDir(),
    plugins: [
      dumpSuspensePlugin(),
      blockbaseCatalogPlugin({ catalogRoot, previewRoot, getUrl: () => url }),
      react(),
      tailwindcss(),
    ],
    resolve: {
      dedupe: ['react', 'react-dom', 'framer-motion', 'lucide-react', 'recharts', 'class-variance-authority'],
      alias: aliases(),
    },
    server: {
      host: '127.0.0.1',
      port: options.port,
      strictPort: true,
      open: options.open ?? false,
      allowedHosts: ['localhost', '127.0.0.1', ...(options.allowedHosts ?? [])],
      // Setting fs.allow disables Vite's automatic workspace-root detection, so keep it explicit.
      fs: { allow: [...new Set([searchForWorkspaceRoot(previewRoot), previewRoot, ...dependencyRoots(), catalogRoot])] },
    },
    optimizeDeps: { include: OPTIMIZE_INCLUDE },
    appType: 'spa',
  };
  const server = await createServer(config);
  try {
    await server.listen();
  } catch (error) {
    // createServer already started the watcher and optimizer; without close() the process never exits.
    await server.close().catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    if ((error as { code?: string }).code === 'EADDRINUSE' || /already in use/i.test(message)) {
      // Vite's strictPort failure is a plain Error; give callers a stable code.
      throw Object.assign(new Error(message), { code: 'EADDRINUSE', port: options.port });
    }
    throw error;
  }
  const address = server.httpServer?.address() as AddressInfo | null;
  const port = address?.port ?? options.port;
  url = `http://127.0.0.1:${port}/`;
  return {
    url,
    port,
    catalogRoot,
    close: () => server.close(),
  };
}
