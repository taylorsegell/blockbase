#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { executeSourceAdapter, readAdapterManifest } from '@blockbase/core';

function value(argv: string[], flag: string): string | undefined { const index = argv.indexOf(flag); return index < 0 ? undefined : argv[index + 1]; }

async function main(argv: string[]): Promise<void> {
  const operation = argv[0];
  const manifestPath = value(argv, '--manifest');
  if (operation === 'manifest' && manifestPath) process.stdout.write(`${JSON.stringify(await readAdapterManifest(manifestPath), null, 2)}\n`);
  else if (operation === 'run' && manifestPath) {
    const command = value(argv, '--command');
    const locator = value(argv, '--locator');
    if (!command || !locator) throw new Error('adapter run requires --command and --locator.');
    const result = await executeSourceAdapter({ manifestPath, command, args: value(argv, '--args') ? JSON.parse(value(argv, '--args')!) : [], request: { schemaVersion: '1', operation: 'acquire', locator, ...(value(argv, '--allow-root') ? { allowRoot: value(argv, '--allow-root') } : {}), ...(argv.includes('--fetch') ? { fetch: true } : {}) } });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else throw new Error('Usage: blockbase-adapter <manifest|run> --manifest <adapter.json> [options].');
}

main(process.argv.slice(2)).catch((error) => { process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
