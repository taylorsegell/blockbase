import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SERVICE_INVENTORY_NAME = '.blockbase-service.json';

export type ServiceInventory = {
  schemaVersion: '1';
  platform: 'darwin' | 'linux';
  path: string;
  sha256: string;
  label: string;
  port: number;
  /** Optional for inventories written before it was recorded. */
  allowedHosts?: string[];
  installedAt: string;
};

export function sha256Of(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function serviceInventoryPath(catalogRoot: string): string {
  return join(catalogRoot, SERVICE_INVENTORY_NAME);
}

export function readServiceInventory(catalogRoot: string): ServiceInventory | undefined {
  try {
    const parsed = JSON.parse(readFileSync(serviceInventoryPath(catalogRoot), 'utf8')) as Partial<ServiceInventory>;
    if (parsed.schemaVersion !== '1' || (parsed.platform !== 'darwin' && parsed.platform !== 'linux')) return undefined;
    if (typeof parsed.path !== 'string' || typeof parsed.sha256 !== 'string' || typeof parsed.label !== 'string' || typeof parsed.port !== 'number' || typeof parsed.installedAt !== 'string') return undefined;
    if (parsed.allowedHosts !== undefined && (!Array.isArray(parsed.allowedHosts) || parsed.allowedHosts.some((host) => typeof host !== 'string'))) delete parsed.allowedHosts;
    return parsed as ServiceInventory;
  } catch {
    return undefined;
  }
}

export function writeServiceInventory(catalogRoot: string, inventory: ServiceInventory): void {
  mkdirSync(catalogRoot, { recursive: true });
  writeFileSync(serviceInventoryPath(catalogRoot), `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
}

export function removeServiceInventory(catalogRoot: string): void {
  rmSync(serviceInventoryPath(catalogRoot), { force: true });
}
