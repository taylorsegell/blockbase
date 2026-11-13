import { createReadStream, existsSync, statSync } from 'node:fs';
import { readdir, readFile, realpath } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, posix, resolve, sep } from 'node:path';
import * as core from '@blockbase/core';
import type { Plugin, ViteDevServer } from 'vite';

export type CatalogEntry = {
  componentId: string;
  namespace: string;
  slug: string;
  displayName: string;
  category: string;
  tags: string[];
  bucket: string | null;
  entryPoint: string | null;
  revisionId: string;
  /** True when the component folder holds a `demo.tsx` that renders it with sample props. */
  hasDemo: boolean;
};

export type InternalEntry = CatalogEntry & { originalDir: string; demoPath: string | null };

/**
 * A component's preview demo lives beside component.json, outside the hashed revision, and imports
 * the current revision through this specifier: `import { AgentPlan } from '@block';`.
 */
export const DEMO_FILE = 'demo.tsx';
export const DEMO_SELF_SPECIFIER = '@block';

export const VIRTUAL_ID = 'virtual:blockbase-catalog';
const RESOLVED_VIRTUAL_ID = `\0${VIRTUAL_ID}`;
export const CATALOG_CHANGED_EVENT = 'blockbase:catalog-changed';

export type CatalogPluginOptions = {
  catalogRoot: string;
  /**
   * Root of the preview package whose own sources need Tailwind classes generated. Tailwind's
   * automatic source detection skips node_modules, which is where an installed package lives.
   */
  previewRoot?: string;
  /** Reported by /api/health. Filled in by startPreviewServer once the port is bound. */
  getUrl?: () => string;
};

function fallbackChooseEntryPoint(files: string[]): string | undefined {
  const sorted = files.slice().sort();
  for (const name of ['index.tsx', 'index.jsx', 'index.ts', 'index.js']) {
    if (sorted.includes(name)) return name;
  }
  return sorted.find((file) => /\.(?:tsx|jsx)$/.test(file)) ?? sorted[0];
}

type EntryPointApi = {
  resolveEntryPoint?: (manifest: { entryPoint?: string; displayName: string }, files: string[]) => string | undefined;
};

/** Uses the shared core rule when this core build exports it. */
function pickEntryPoint(manifest: { entryPoint?: string; displayName: string }, files: string[]): string | undefined {
  const api = core as unknown as EntryPointApi;
  if (typeof api.resolveEntryPoint === 'function') return api.resolveEntryPoint(manifest, files);
  if (manifest.entryPoint && files.includes(manifest.entryPoint)) return manifest.entryPoint;
  return fallbackChooseEntryPoint(files);
}

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  let items;
  try {
    items = await readdir(join(dir, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const item of items) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else if (item.isFile()) out.push(rel);
  }
  return out;
}

async function readBuckets(catalogRoot: string): Promise<{ bucket: Map<string, string>; entry: Map<string, string> }> {
  const bucket = new Map<string, string>();
  const entry = new Map<string, string>();
  try {
    const report = JSON.parse(await readFile(join(catalogRoot, 'migration-report.json'), 'utf8')) as {
      entries?: Array<{ entryPoint?: string; manifest?: { componentId?: string }; source?: { bucket?: string } }>;
    };
    for (const item of report.entries ?? []) {
      const id = item.manifest?.componentId;
      if (!id) continue;
      if (typeof item.source?.bucket === 'string') bucket.set(id, item.source.bucket);
      if (typeof item.entryPoint === 'string') entry.set(id, item.entryPoint);
    }
  } catch {
    // migration-report.json is optional.
  }
  return { bucket, entry };
}

async function buildEntries(catalogRoot: string): Promise<InternalEntry[]> {
  const [components, report] = await Promise.all([core.listCatalogComponents(catalogRoot), readBuckets(catalogRoot)]);
  const result: InternalEntry[] = [];
  for (const component of components) {
    const manifest = component.manifest;
    const revisionHex = manifest.currentRevision.replace(/^sha256:/, '');
    const originalDir = join(catalogRoot, 'components', manifest.namespace, manifest.slug, 'revisions', revisionHex, 'original');
    const files = await listFiles(originalDir);
    let entryPoint = pickEntryPoint(manifest as { entryPoint?: string; displayName: string }, files) ?? null;
    const migrated = report.entry.get(manifest.componentId);
    if (!(manifest as { entryPoint?: string }).entryPoint && migrated && files.includes(migrated)) entryPoint = migrated;
    const demoPath = join(catalogRoot, 'components', manifest.namespace, manifest.slug, DEMO_FILE);
    const hasDemo = existsSync(demoPath);
    result.push({
      componentId: manifest.componentId,
      namespace: manifest.namespace,
      slug: manifest.slug,
      displayName: manifest.displayName,
      category: manifest.category,
      tags: [...manifest.tags],
      bucket: report.bucket.get(manifest.componentId) ?? null,
      entryPoint,
      revisionId: manifest.currentRevision,
      hasDemo,
      originalDir,
      demoPath: hasDemo ? demoPath : null,
    });
  }
  return result;
}

function publicEntry({ originalDir: _originalDir, demoPath: _demoPath, ...entry }: InternalEntry): CatalogEntry {
  return entry;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function statusFor(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof HttpError) return { status: error.status, code: error.code, message: error.message };
  const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : '';
  const message = error instanceof Error ? error.message : String(error);
  if (code) {
    if (/NOT_FOUND|COMPONENT_NOT_FOUND/.test(code)) return { status: 404, code, message };
    if (/AMBIGUOUS|DUPLICATE|RESERVED|CONFLICT|SELECTION_REQUIRED|STALE|LOCKED/.test(code)) return { status: 409, code, message };
    if (/^(ORGANIZE|INBOX|IMPORT|INDEX_MANIFEST)/.test(code)) return { status: 400, code, message };
  }
  return { status: 500, code: code || 'INTERNAL_ERROR', message };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new HttpError(400, 'BODY_TOO_LARGE', 'Request body is too large.');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must be a JSON object.');
  }
}

/**
 * Writes must come from the page itself. A cross-site page can send a "simple" POST (text/plain,
 * no preflight) to 127.0.0.1; requiring JSON forces a CORS preflight, and a foreign Origin is refused.
 */
function assertSameOriginJson(req: IncomingMessage): void {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Write requests must use Content-Type: application/json.');
  const origin = req.headers.origin;
  if (origin === undefined) return;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'FORBIDDEN_ORIGIN', 'Write requests must come from the preview page.');
  }
  if (originHost !== req.headers.host) throw new HttpError(403, 'FORBIDDEN_ORIGIN', 'Write requests must come from the preview page.');
}

function str(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new HttpError(400, 'INVALID_ARGUMENT', `${name} must be a non-empty string.`);
  return value;
}

const toPosix = (path: string) => path.replace(/\\/g, '/');

const ASSET_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * Revisions store non-text files under `revisions/<id>/assets`, but source still refers to them
 * as siblings (`new URL('./file.svg', import.meta.url)`). The browser then requests
 * `/@fs/<catalog>/.../original/<path>`. When that file is absent and the same relative path
 * exists under `assets`, return the asset so the preview can serve it.
 */
export function revisionAssetPath(requestPath: string, catalogRoot: string): string | null {
  const pathname = requestPath.split('?')[0] ?? '';
  if (!pathname.startsWith('/@fs/')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname.slice('/@fs'.length));
  } catch {
    return null;
  }
  const filePath = resolve(decoded);
  const root = resolve(catalogRoot);
  if (filePath !== root && !filePath.startsWith(root + sep)) return null;
  const marker = `${sep}revisions${sep}`;
  const originalSeg = `${sep}original${sep}`;
  const revisionAt = filePath.indexOf(marker);
  if (revisionAt < 0) return null;
  const afterRevision = filePath.slice(revisionAt + marker.length);
  const originalAt = afterRevision.indexOf(originalSeg);
  if (originalAt < 0) return null;
  const revisionId = afterRevision.slice(0, originalAt);
  const relative = afterRevision.slice(originalAt + originalSeg.length);
  if (!revisionId || revisionId.includes(sep)) return null;
  if (!relative || relative.split(sep).includes('..') || relative.split(sep).includes('')) return null;
  if (existsSync(filePath)) return null;
  const componentDir = filePath.slice(0, revisionAt);
  const assetsRoot = resolve(componentDir, 'revisions', revisionId, 'assets');
  const asset = resolve(assetsRoot, relative);
  if (asset !== assetsRoot && !asset.startsWith(assetsRoot + sep)) return null;
  try {
    if (!statSync(asset).isFile()) return null;
  } catch {
    return null;
  }
  return asset;
}

function serveRevisionAsset(res: ServerResponse, file: string): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', ASSET_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-cache');
  const stream = createReadStream(file);
  stream.on('error', () => {
    if (!res.headersSent) res.statusCode = 404;
    res.end();
  });
  stream.pipe(res);
}

/**
 * Legacy blocks import siblings by their legacy location, e.g. `../../buttons/socials` from
 * `<ns>/<slug>/File.tsx`. In the catalog the importer lives at
 * `components/<ns>/<slug>/revisions/<sha>/original/File.tsx`, so the same specifier points nowhere.
 * Re-run the path arithmetic from the importer's logical legacy location and, when it lands in
 * another catalog component (`<ns>/<slug>[/<rest>]`), return that component's current original path.
 * Returns null whenever the specifier stays inside the importer's own component or the target is
 * not in the catalog, so Vite keeps its normal resolution and error reporting.
 */
export function mapLegacySiblingImport(
  specifier: string,
  importer: string,
  componentsRoots: string[],
  find: (namespace: string, slug: string) => InternalEntry | undefined,
): string | null {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  const file = toPosix(importer.split('?')[0]);
  const prefix = componentsRoots.map((root) => `${toPosix(root).replace(/\/$/, '')}/`).find((root) => file.startsWith(root));
  if (!prefix) return null;
  const parts = file.slice(prefix.length).split('/');
  if (parts.length < 6 || parts[2] !== 'revisions' || parts[4] !== 'original') return null;
  const [namespace, slug] = parts;
  const logical = [namespace, slug, ...parts.slice(5)].join('/');
  const target = posix.normalize(posix.join(posix.dirname(logical), specifier));
  if (target === '..' || target.startsWith('../') || target.startsWith('/')) return null;
  const targetParts = target.split('/');
  if (targetParts.length < 2 || targetParts.some((part) => part === '' || part === '.' || part === '..')) return null;
  const [targetNamespace, targetSlug, ...rest] = targetParts;
  if (targetNamespace === namespace && targetSlug === slug) return null;
  const entry = find(targetNamespace, targetSlug);
  if (!entry) return null;
  if (rest.length > 0) return join(entry.originalDir, ...rest);
  return entry.entryPoint ? join(entry.originalDir, entry.entryPoint) : null;
}

export function blockbaseCatalogPlugin(options: CatalogPluginOptions): Plugin {
  const catalogRoot = resolve(options.catalogRoot);
  let cache: Promise<InternalEntry[]> | undefined;
  const entries = () => (cache ??= buildEntries(catalogRoot));
  const resetCache = () => {
    cache = undefined;
  };
  let componentsRoots: Promise<string[]> | undefined;
  const getComponentsRoots = () =>
    (componentsRoots ??= realpath(catalogRoot).then(
      (real) => [...new Set([join(catalogRoot, 'components'), join(real, 'components')])],
      () => [join(catalogRoot, 'components')],
    ));

  async function families() {
    const [taxonomy, list] = await Promise.all([core.readTaxonomy(catalogRoot), entries()]);
    const known = new Set(taxonomy.families.map((family) => family.slug));
    const extra = [...new Set(list.map((entry) => entry.category))].filter((slug) => !known.has(slug)).sort();
    return [
      ...taxonomy.families.map(({ slug, name }) => ({ slug, name })),
      ...extra.map((slug) => ({ slug, name: slug })),
    ];
  }

  async function state() {
    const components = await core.listCatalogComponents(catalogRoot);
    const tagsBySlug: Record<string, string[]> = {};
    for (const component of components) {
      tagsBySlug[component.componentId] = component.tags;
      tagsBySlug[component.slug] = component.tags;
    }
    const known = new Set(components.map((component) => component.slug));
    const fallback = core.initialCatalogMetadata(
      Object.fromEntries(components.map((component) => [component.slug, component.tags])),
      [],
      known,
    );
    const metadata = await core.readCatalogMetadata(catalogRoot, fallback);
    return { tagsBySlug, collections: metadata.collections, metadataVersion: metadata.metadataVersion };
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (!path.startsWith('/api/')) return false;
    const method = req.method ?? 'GET';
    try {
      if (method !== 'GET' && method !== 'HEAD') assertSameOriginJson(req);
      if (method === 'GET' && path === '/api/health') {
        const list = await entries();
        sendJson(res, 200, { schemaVersion: '1', catalogRoot, url: options.getUrl?.() ?? '', count: list.length });
      } else if (method === 'GET' && path === '/api/catalog') {
        const [list, fam] = await Promise.all([entries(), families()]);
        sendJson(res, 200, { entries: list.map(publicEntry), families: fam });
      } else if (method === 'GET' && path === '/api/state') {
        sendJson(res, 200, await state());
      } else if (method === 'GET' && path === '/api/search') {
        sendJson(res, 200, await core.searchComponents(catalogRoot, url.searchParams.get('q') ?? ''));
      } else if (method === 'GET' && path.startsWith('/api/components/')) {
        const id = decodeURIComponent(path.slice('/api/components/'.length));
        sendJson(res, 200, await core.inspectComponent(catalogRoot, id));
      } else if (method === 'POST' && path === '/api/tags') {
        const body = await readBody(req);
        const componentId = str(body.componentId, 'componentId');
        if (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== 'string')) {
          throw new HttpError(400, 'INVALID_ARGUMENT', 'tags must be an array of strings.');
        }
        const wanted = [...new Set((body.tags as string[]).map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
        const components = await core.listCatalogComponents(catalogRoot);
        const current = core.resolveCatalogComponent(components, componentId);
        const have = new Set(current.tags);
        for (const tag of wanted.filter((tag) => !have.has(tag))) await core.addTag(catalogRoot, current.componentId, tag);
        for (const tag of [...have].filter((tag) => !wanted.includes(tag))) await core.removeTag(catalogRoot, current.componentId, tag);
        resetCache();
        sendJson(res, 200, await state());
      } else if (method === 'POST' && path === '/api/collections') {
        const body = await readBody(req);
        const op = body.op;
        const id = str(body.id, 'id');
        let result;
        if (op === 'create') result = await core.createCollection(catalogRoot, id, str(body.title ?? body.id, 'title'));
        else if (op === 'add') result = await core.addCollectionSlug(catalogRoot, id, str(body.slug, 'slug'));
        else if (op === 'remove') result = await core.removeCollectionSlug(catalogRoot, id, str(body.slug, 'slug'));
        else if (op === 'reorder') {
          if (typeof body.index !== 'number') throw new HttpError(400, 'INVALID_ARGUMENT', 'index must be a number.');
          result = await core.reorderCollectionSlug(catalogRoot, id, str(body.slug, 'slug'), body.index);
        } else if (op === 'delete') result = await core.deleteCollection(catalogRoot, id);
        else throw new HttpError(400, 'INVALID_ARGUMENT', 'op must be create, add, remove, reorder, or delete.');
        sendJson(res, 200, { collections: result.collections });
      } else {
        throw new HttpError(404, 'NOT_FOUND', `No API route for ${method} ${path}.`);
      }
    } catch (error) {
      const { status, code, message } = statusFor(error);
      sendJson(res, status, { code, message });
    }
    return true;
  }

  return {
    name: 'blockbase-catalog',
    enforce: 'pre',
    async resolveId(id, importer, resolveOptions) {
      if (id === VIRTUAL_ID) return RESOLVED_VIRTUAL_ID;
      if (id === DEMO_SELF_SPECIFIER && importer) {
        const file = toPosix(importer.split('?')[0]);
        const root = (await getComponentsRoots()).map((dir) => `${toPosix(dir)}/`).find((dir) => file.startsWith(dir));
        const [namespace, slug, name, ...rest] = root ? file.slice(root.length).split('/') : [];
        if (name !== DEMO_FILE || rest.length > 0) return undefined;
        const owner = (await entries()).find((entry) => entry.namespace === namespace && entry.slug === slug);
        return owner?.entryPoint ? join(owner.originalDir, owner.entryPoint) : undefined;
      }
      if (!importer || (!id.startsWith('./') && !id.startsWith('../'))) return undefined;
      const roots = await getComponentsRoots();
      const clean = toPosix(importer.split('?')[0]);
      if (!roots.some((root) => clean.startsWith(`${toPosix(root)}/`))) return undefined;
      const list = await entries();
      const target = mapLegacySiblingImport(id, importer, roots, (namespace, slug) =>
        list.find((entry) => entry.namespace === namespace && entry.slug === slug),
      );
      if (!target) return undefined;
      const resolved = await this.resolve(target, importer, { ...resolveOptions, skipSelf: true });
      return resolved ?? undefined;
    },
    async load(id) {
      if (id !== RESOLVED_VIRTUAL_ID) return undefined;
      const list = await entries();
      const fsUrl = (file: string) => `/@fs/${file.split(sep).join('/').replace(/^\//, '')}`;
      const loaders = list
        .filter((entry) => entry.entryPoint)
        .map((entry) => `  ${JSON.stringify(entry.componentId)}: () => import(${JSON.stringify(fsUrl(join(entry.originalDir, entry.entryPoint as string)))}),`);
      const demos = list
        .filter((entry) => entry.demoPath && entry.entryPoint)
        .map((entry) => `  ${JSON.stringify(entry.componentId)}: () => import(${JSON.stringify(fsUrl(entry.demoPath as string))}),`);
      return [
        `export const loaders = {\n${loaders.join('\n')}\n};`,
        `export const demos = {\n${demos.join('\n')}\n};`,
        `export const entries = ${JSON.stringify(list.map(publicEntry))};`,
      ].join('\n');
    },
    transform(code, id) {
      const clean = id.split('?')[0].replace(/\\/g, '/');
      if (!clean.endsWith('/src/index.css')) return undefined;
      const glob = `${catalogRoot.replace(/\\/g, '/')}/components/**/*.{tsx,ts,jsx}`;
      const own = options.previewRoot ? `@source "${resolve(options.previewRoot).replace(/\\/g, '/')}/src/**/*.{tsx,ts,jsx}";\n` : '';
      return { code: `@source "${glob}";\n${own}${code}`, map: null };
    },
    configureServer(server: ViteDevServer) {
      // Registered directly (not via a returned post-hook) so /api/* runs before Vite's HTML fallback.
      server.middlewares.use((req, res, next) => {
        const asset = revisionAssetPath(req.url ?? '', catalogRoot);
        if (asset && (req.method === 'GET' || req.method === 'HEAD')) {
          if (req.method === 'HEAD') {
            res.statusCode = 200;
            res.setHeader('Content-Type', ASSET_TYPES[extname(asset).toLowerCase()] ?? 'application/octet-stream');
            res.end();
            return;
          }
          serveRevisionAsset(res, asset);
          return;
        }
        route(req, res).then(
          (handled) => {
            if (!handled) next();
          },
          (error) => {
            const { status, code, message } = statusFor(error);
            sendJson(res, status, { code, message });
          },
        );
      });

      const componentsDir = join(catalogRoot, 'components');
      server.watcher.add(componentsDir);
      const onManifestEvent = (file: string, event: 'add' | 'change' | 'unlink') => {
        const posixFile = file.replace(/\\/g, '/');
        // A demo's edits reach the page through HMR; only its appearance or removal changes the virtual module.
        const isDemo = posixFile.endsWith(`/${DEMO_FILE}`) && event !== 'change';
        if (!posixFile.endsWith('/component.json') && !isDemo) return;
        if (!resolve(file).startsWith(componentsDir)) return;
        resetCache();
        const mod = server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_ID);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: 'custom', event: CATALOG_CHANGED_EVENT });
      };
      server.watcher.on('add', (file) => onManifestEvent(file, 'add'));
      server.watcher.on('change', (file) => onManifestEvent(file, 'change'));
      server.watcher.on('unlink', (file) => onManifestEvent(file, 'unlink'));
    },
  };
}

