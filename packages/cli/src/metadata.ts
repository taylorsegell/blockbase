#!/usr/bin/env node

import { defaultCatalogRoot, exportCatalogMetadata, initialCatalogMetadata, openIndex } from '@blockbase/core';

function value(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function output(valueToWrite: unknown, json: boolean): void {
  if (json) process.stdout.write(JSON.stringify({ schemaVersion: '1', ok: true, data: valueToWrite }, null, 2) + '\n');
  else process.stdout.write(`${JSON.stringify(valueToWrite, null, 2)}\n`);
}

async function main(argv: string[]): Promise<number> {
  const catalogRoot = value(argv, '--catalog') ?? process.env.BLOCKBASE_HOME ?? defaultCatalogRoot(process.platform, process.env, process.env.HOME);
  const json = argv.includes('--json');
  if (argv[0] !== 'export') throw new Error('Usage: blockbase-metadata export --catalog <path> [--json]. The set-tags and set-collections subcommands were removed; use `blockbase tag` and `blockbase collection` instead.');
  const index = await openIndex({ catalogRoot });
  const rows = index.db.prepare('SELECT slug, tags_json FROM components ORDER BY slug').all() as Array<{ slug: string; tags_json: string }>;
  index.close();
  const knownSlugs = new Set(rows.map((entry) => entry.slug));
  const fallback = initialCatalogMetadata(Object.fromEntries(rows.map((entry) => [entry.slug, JSON.parse(entry.tags_json) as string[]])), [], knownSlugs);
  return output(await exportCatalogMetadata(catalogRoot, fallback), json), 0;
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
