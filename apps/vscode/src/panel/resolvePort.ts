import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Mirrors DEFAULT_UI_PORT in packages/cli/src/service/index.ts. */
export const DEFAULT_UI_PORT = 47821;
/** Mirrors SERVICE_INVENTORY_NAME in packages/cli/src/service/inventory.ts. */
const SERVICE_INVENTORY_NAME = ".blockbase-service.json";

/** Same rule as the CLI: BLOCKBASE_HOME (a catalog.yaml path means its directory), then ~/.blocks. */
export function defaultCatalogRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.BLOCKBASE_HOME;
  if (!configured) return path.join(homedir(), ".blocks");
  return path.basename(configured) === "catalog.yaml" ? path.dirname(configured) : configured;
}

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function inventoryPort(catalogRoot: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path.join(catalogRoot, SERVICE_INVENTORY_NAME), "utf8")) as { port?: unknown };
    return isPort(parsed.port) ? parsed.port : undefined;
  } catch {
    return undefined;
  }
}

/** `blockbase.port` setting (0 = auto), then the installed service's port, then 47821. */
export function resolveCatalogPort(options: { setting: unknown; catalogRoot?: string }): number {
  if (isPort(options.setting)) return options.setting;
  return inventoryPort(options.catalogRoot ?? defaultCatalogRoot()) ?? DEFAULT_UI_PORT;
}
