import { basename, dirname } from 'node:path';
import { defaultCatalogRoot } from '@blockbase/core';

/** `--catalog`, then `BLOCKBASE_HOME`, then `~/.blocks`. A `catalog.yaml` path means its directory. */
export function resolveCatalogRoot(catalog?: string): string {
  const configured = catalog ?? process.env.BLOCKBASE_HOME;
  if (!configured) return defaultCatalogRoot(process.platform, process.env, process.env.HOME);
  return basename(configured) === 'catalog.yaml' ? dirname(configured) : configured;
}
