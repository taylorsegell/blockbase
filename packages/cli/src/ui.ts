import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXIT_CODES, type CliWarning } from '@blockbase/contracts';
import { cliPackageRoot } from './paths.js';
import { CliFailure } from './errors.js';
import { DEFAULT_UI_PORT, readServiceInventory, serviceStatus, type ServiceStatus } from './service/index.js';
import { success, writeJson } from './output.js';

export type PreviewServerOptions = { catalogRoot: string; port: number; host?: '127.0.0.1'; allowedHosts?: string[]; open?: boolean };
export type PreviewServer = { url: string; port: number; catalogRoot: string; close(): Promise<void> };
type PreviewModule = { startPreviewServer(options: PreviewServerOptions): Promise<PreviewServer> };

export function uiUrl(port: number): string {
  return `http://127.0.0.1:${port}/#home`;
}

/**
 * `BLOCKBASE_PREVIEW_ENTRY` is a test hook. Otherwise the preview server is the installed
 * `@blockbase/preview` package, falling back to the checkout's built `apps/preview` when the
 * package is not linked (a fresh clone before `pnpm install` has linked it).
 */
function previewEntry(): string {
  if (process.env.BLOCKBASE_PREVIEW_ENTRY) return process.env.BLOCKBASE_PREVIEW_ENTRY;
  try {
    const resolved = import.meta.resolve('@blockbase/preview/server');
    if (resolved.startsWith('file:')) {
      const path = fileURLToPath(resolved);
      if (existsSync(path)) return path;
    }
  } catch {
    // Not resolvable from here; try the checkout location.
  }
  return join(cliPackageRoot(), '..', '..', 'apps', 'preview', 'dist', 'server', 'index.js');
}

async function loadPreview(): Promise<PreviewModule> {
  const entry = previewEntry();
  const notBuilt = (cause?: string) => new CliFailure('PREVIEW_NOT_BUILT', 'The catalog page server is not available.', EXIT_CODES.notFound, { entry, ...(cause ? { cause } : {}) }, [
    { id: 'build', label: 'In a Blockbase checkout, build the workspace', safe: true, command: 'pnpm build' },
    { id: 'reinstall', label: 'If installed from npm, reinstall the package', safe: false, command: 'npm install -g @blockbase/cli@latest' },
  ]);
  if (!existsSync(entry)) throw notBuilt();
  let loaded: Partial<PreviewModule>;
  try {
    loaded = (await import(pathToFileURL(entry).href)) as Partial<PreviewModule>;
  } catch (error) {
    throw notBuilt(error instanceof Error ? error.message : String(error));
  }
  if (typeof loaded.startPreviewServer !== 'function') throw notBuilt('The module does not export startPreviewServer.');
  return loaded as PreviewModule;
}

export type UiRunOptions = { catalogRoot: string; port: number; allowedHosts: string[]; open: boolean; json: boolean };

export async function runUi(options: UiRunOptions): Promise<number> {
  if (!existsSync(options.catalogRoot) || !statSync(options.catalogRoot).isDirectory()) {
    throw new CliFailure('CATALOG_NOT_FOUND', `No catalog directory at ${options.catalogRoot}.`, EXIT_CODES.notFound, { catalogRoot: options.catalogRoot }, [
      { id: 'setup', label: 'Create the catalog', safe: false, command: 'blockbase setup --json' },
    ]);
  }
  const preview = await loadPreview();
  let server: PreviewServer;
  try {
    server = await preview.startPreviewServer({
      catalogRoot: options.catalogRoot,
      port: options.port,
      host: '127.0.0.1',
      ...(options.allowedHosts.length > 0 ? { allowedHosts: options.allowedHosts } : {}),
      ...(options.open ? { open: true } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if ((error as { code?: string }).code === 'EADDRINUSE' || /already in use/i.test(message)) {
      throw new CliFailure('UI_PORT_IN_USE', `Port ${options.port} is already in use.`, EXIT_CODES.conflict, { port: options.port }, [
        { id: 'status', label: 'Check whether the catalog page is already running', safe: true, command: 'blockbase ui status --json' },
      ]);
    }
    throw error;
  }
  const info = { url: uiUrl(server.port), port: server.port, catalogRoot: server.catalogRoot };
  if (options.json) writeJson(success('ui', info));
  else process.stdout.write(`Catalog page: ${info.url}\n`);
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await server.close();
  return EXIT_CODES.ok;
}

export type Health = { running: boolean; catalogRoot?: string; count?: number };

/**
 * A healthy catalog page answers JSON with a `catalogRoot`. A bare 200 is the dev server's SPA
 * fallback for an unknown path, so it must not count as running.
 */
export async function probeHealth(port: number, timeoutMs = 2000): Promise<Health> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200 || !(response.headers.get('content-type') ?? '').includes('application/json')) return { running: false };
    const body = (await response.json()) as { catalogRoot?: unknown; count?: unknown } | null;
    if (!body || typeof body.catalogRoot !== 'string') return { running: false };
    return { running: true, catalogRoot: body.catalogRoot, ...(typeof body.count === 'number' ? { count: body.count } : {}) };
  } catch {
    return { running: false };
  }
}

export async function waitForHealth(port: number, timeoutMs: number): Promise<Health> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const health = await probeHealth(port, 1000);
    if (health.running || Date.now() >= deadline) return health;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export function configuredPort(port: number | undefined, catalogRoot: string): number {
  return port ?? readServiceInventory(catalogRoot)?.port ?? DEFAULT_UI_PORT;
}

export async function runUiStatus(options: { catalogRoot: string; port?: number }): Promise<{ data: { running: boolean; url: string; catalogRoot?: string; count?: number; service: ServiceStatus }; warnings: CliWarning[] }> {
  const port = configuredPort(options.port, options.catalogRoot);
  const health = await probeHealth(port);
  const service = serviceStatus(options.catalogRoot, port);
  return {
    data: { running: health.running, url: uiUrl(port), ...(health.catalogRoot !== undefined ? { catalogRoot: health.catalogRoot } : {}), ...(health.count !== undefined ? { count: health.count } : {}), service: service.status },
    warnings: service.warnings,
  };
}
