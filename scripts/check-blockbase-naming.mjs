#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');

// These are integration surfaces, not catalog content. Preview/UI identifiers
// are intentionally excluded until the approved preview migration; they are
// reported below as bounded legacy input rather than silently treated as new.
const roots = [
  'integrations/agent',
  'packages/cli/src',
];

const intentionalLegacyInput = [];

const forbidden = [
  { id: 'legacy-organizer-command', pattern: /\bblock-organizer\b/g },
  { id: 'legacy-preview-package', pattern: /\bblocks-preview\b/g },
  { id: 'legacy-library-global', pattern: /__BLOCKS_[A-Z0-9_]+__/g },
  { id: 'legacy-environment-prefix', pattern: /\bBLOCKS_[A-Z0-9_]+\b/g },
];

function filesUnder(path) {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => filesUnder(join(path, entry.name)));
}

const files = roots.flatMap((root) => filesUnder(join(repositoryRoot, root))).sort();
const hits = [];
for (const path of files) {
  const content = readFileSync(path, 'utf8');
  for (const item of forbidden) {
    for (const match of content.matchAll(item.pattern)) {
      const line = content.slice(0, match.index).split('\n').length;
      hits.push({ id: item.id, file: relative(repositoryRoot, path), line, value: match[0] });
    }
  }
}

const report = {
  schemaVersion: '1',
  command: 'naming-sweep',
  status: hits.length === 0 ? 'passed' : 'failed',
  scannedFiles: files.map((path) => relative(repositoryRoot, path)),
  forbiddenIdentifiers: forbidden.map(({ id }) => id),
  intentionalLegacyInput,
  hits,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (hits.length > 0) process.exitCode = 1;
