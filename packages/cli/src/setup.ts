import { existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_CODES } from '@blockbase/contracts';
import { rebuildIndex } from '@blockbase/core';
import { CliFailure } from './errors.js';
import { installService, readServiceInventory, resolveServiceSettings, serviceStatus } from './service/index.js';
import { SERVICE_INVENTORY_NAME } from './service/inventory.js';
import { configuredPort, probeHealth, uiUrl, waitForHealth } from './ui.js';

export type CatalogState = 'present' | 'legacy' | 'created';
export type SetupServiceState = 'installed' | 'refreshed' | 'running' | 'skipped' | 'failed';
export type SetupIssue = { code: string; message: string; repair?: string };

export type SetupResult = {
  schemaVersion: '1';
  catalogRoot: string;
  catalog: CatalogState;
  service: SetupServiceState;
  url: string;
  issues: SetupIssue[];
};

export type SetupOptions = {
  catalogRoot: string;
  port?: number;
  allowedHosts?: string[];
  noService?: boolean;
};

const TOLERATED = (name: string) => name === '.DS_Store' || name === 'components' || name === 'inbox' || name === SERVICE_INVENTORY_NAME || name === 'index.sqlite' || name.startsWith('index.sqlite-') || name.startsWith('index.sqlite.');

function healthTimeoutMs(): number {
  const override = Number(process.env.BLOCKBASE_SETUP_HEALTH_TIMEOUT_MS);
  return Number.isFinite(override) && override >= 0 && process.env.BLOCKBASE_SETUP_HEALTH_TIMEOUT_MS !== undefined ? override : 15_000;
}

async function ensureCatalog(root: string): Promise<CatalogState> {
  if (existsSync(join(root, 'index.sqlite'))) return 'present';
  if (existsSync(join(root, 'catalog.yaml'))) return 'legacy';
  if (existsSync(root)) {
    if (!lstatSync(root).isDirectory()) throw conflict(root, [root]);
    const unmanaged = readdirSync(root).filter((name) => !TOLERATED(name));
    const components = join(root, 'components');
    const badComponents = existsSync(components) && !looksLikeComponentsDir(components) ? ['components'] : [];
    if (unmanaged.length > 0 || badComponents.length > 0) throw conflict(root, [...unmanaged, ...badComponents]);
  }
  mkdirSync(join(root, 'components'), { recursive: true });
  await rebuildIndex({ catalogRoot: root });
  return 'created';
}

/**
 * A `components/` directory is only ours when it is empty or already holds at least one
 * `<namespace>/<slug>/component.json`; any other content means this is someone else's folder.
 */
function looksLikeComponentsDir(dir: string): boolean {
  if (!lstatSync(dir).isDirectory()) return false;
  const namespaces = readdirSync(dir).filter((name) => name !== '.DS_Store');
  if (namespaces.length === 0) return true;
  return namespaces.some((namespace) => {
    const nsDir = join(dir, namespace);
    if (!lstatSync(nsDir).isDirectory()) return false;
    return readdirSync(nsDir).some((slug) => existsSync(join(nsDir, slug, 'component.json')));
  });
}

function conflict(root: string, entries: string[]): CliFailure {
  return new CliFailure('SETUP_CATALOG_CONFLICT', `${root} already holds files that are not a Blockbase catalog; setup wrote nothing.`, EXIT_CODES.conflict, { catalogRoot: root, entries: entries.slice(0, 20) }, [
    { id: 'choose-catalog', label: 'Point setup at an empty directory with --catalog or BLOCKBASE_HOME', safe: true, command: 'blockbase setup --catalog <path> --json' },
  ]);
}

export async function runSetup(options: SetupOptions): Promise<SetupResult> {
  const catalogRoot = options.catalogRoot;
  const { port, allowedHosts } = resolveServiceSettings({ catalogRoot, port: options.port, allowedHosts: options.allowedHosts });
  let reportedPort = port;
  const issues: SetupIssue[] = [];
  const catalog = await ensureCatalog(catalogRoot);
  if (catalog === 'legacy') {
    issues.push({ code: 'catalog-legacy', message: 'This directory holds a legacy catalog.yaml; migrate it before serving the catalog page.', repair: 'blockbase catalog migrate --json' });
  }
  let service: SetupServiceState = 'skipped';
  if (!options.noService && catalog !== 'legacy') {
    try {
      const installed = installService({ catalogRoot, port, allowedHosts });
      const health = await waitForHealth(port, healthTimeoutMs());
      if (health.running) service = installed.state === 'present' ? 'running' : installed.state;
      else {
        service = 'failed';
        issues.push({ code: 'service-not-healthy', message: `The login service was installed but port ${port} did not answer within the wait window; see ~/Library/Logs/blockbase-ui.err.log or journalctl --user -u blockbase-ui.`, repair: 'blockbase ui service status --json' });
      }
    } catch (error) {
      if (!(error instanceof CliFailure)) throw error;
      service = 'failed';
      // A failed refresh puts the previous definition and inventory back, so the port that is actually
      // served is the one the inventory records, not the one that was requested.
      reportedPort = readServiceInventory(catalogRoot)?.port ?? port;
      const repair = error.recoveryActions.find((action) => action.command)?.command;
      issues.push({ code: `service-${error.code.replace(/^SERVICE_/, '').toLowerCase().replaceAll('_', '-')}`, message: error.message, ...(repair ? { repair } : {}) });
    }
  }
  return { schemaVersion: '1', catalogRoot, catalog, service, url: uiUrl(reportedPort), issues };
}

/** Read-only probes shared with `agent check`. */
export function catalogMarker(catalogRoot: string): 'present' | 'missing' | 'legacy' {
  if (existsSync(join(catalogRoot, 'index.sqlite'))) return 'present';
  if (existsSync(join(catalogRoot, 'catalog.yaml'))) return 'legacy';
  return 'missing';
}

export async function uiMarker(catalogRoot: string): Promise<'running' | 'installed' | 'absent'> {
  const status = serviceStatus(catalogRoot);
  const health = await probeHealth(configuredPort(undefined, catalogRoot), 1000);
  if (health.running) return 'running';
  return status.status.installed ? 'installed' : 'absent';
}
