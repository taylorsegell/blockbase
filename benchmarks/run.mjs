#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectComponent, openIndex, rebuildIndex, searchComponents } from '../packages/core/dist/index.js';

const root = resolve(import.meta.dirname, '..');
const fixture = resolve(root, 'packages/contracts/fixtures/v1/component-manifest.json');
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const entries = Number(option('--entries', 10_000));
const samples = Number(option('--samples', 25));
const reportPath = option('--write-report');
if (!Number.isInteger(entries) || entries < 1 || !Number.isInteger(samples) || samples < 3) {
  throw new Error('--entries must be positive and --samples must be at least 3.');
}

const template = JSON.parse(await readFile(fixture, 'utf8'));
const tempRoot = await mkdtemp(join(tmpdir(), 'blockbase-benchmark-'));
const catalogRoot = join(tempRoot, 'catalog-data');
const source = 'export function BenchmarkEntry() { return <div>Benchmark entry</div>; }\n';
try {
  const namespaceRoot = join(catalogRoot, 'components', 'benchmark');
  await mkdir(namespaceRoot, { recursive: true });
  for (let index = 0; index < entries; index += 1) {
    const slug = `entry-${String(index).padStart(5, '0')}`;
    const revision = hash(`${slug}:${source}`);
    const componentRoot = join(namespaceRoot, slug);
    await mkdir(join(componentRoot, 'revisions', revision, 'original'), { recursive: true });
    await writeFile(join(componentRoot, 'revisions', revision, 'original', 'BenchmarkEntry.tsx'), source);
    await writeFile(join(componentRoot, 'component.json'), `${JSON.stringify({
      ...template,
      componentId: `cmp_benchmark_${String(index).padStart(5, '0')}`,
      namespace: 'benchmark', slug, displayName: `Benchmark Entry ${String(index).padStart(5, '0')}`,
      description: 'A generated benchmark catalog entry for typical text search.',
      aliases: [`benchmark-${index}`], tags: ['benchmark', index % 2 === 0 ? 'even' : 'odd'],
      currentRevision: `sha256:${revision}`,
      provenance: { ...template.provenance, locator: `benchmark/${slug}/BenchmarkEntry.tsx` },
      integrity: { sourceHash: `sha256:${hash(source)}`, assetHashes: [] },
    }, null, 2)}\n`);
  }
  const rebuild = await rebuildIndex({ catalogRoot });
  const exactId = `cmp_benchmark_${String(Math.floor(entries / 2)).padStart(5, '0')}`;
  const query = 'generated benchmark entry';
  await inspectComponent(catalogRoot, exactId);
  await searchComponents(catalogRoot, query);
  const index = await openIndex({ catalogRoot });
  const exactStatement = index.db.prepare('SELECT component_id FROM components WHERE component_id = ?');
  const time = async (fn) => { const start = process.hrtime.bigint(); await fn(); return Number(process.hrtime.bigint() - start) / 1e6; };
  const exact = [], search = [];
  for (let index = 0; index < samples; index += 1) {
    exact.push(await time(() => exactStatement.get(exactId)));
    search.push(await time(() => searchComponents(catalogRoot, query)));
  }
  index.close();
  const report = {
    schemaVersion: '1', harness: 'blockbase-scale-benchmark', generatedAt: new Date().toISOString(),
    profile: { runtime: process.version, platform: process.platform, architecture: process.arch, cpuCount: process.availableParallelism?.() ?? null, timing: 'hrtime.bigint; warmup excluded; warm in-process index lookup and public search calls' },
    dataset: { entries, indexPath: rebuild.indexPath, catalogRevision: rebuild.catalogRevision }, samples,
    queries: { exactId, typicalText: query },
    results: {
      exactIdLookupMs: { median: median(exact), max: Math.max(...exact), threshold: 50, pass: median(exact) < 50, method: 'warm SQLite component_id lookup' },
      typicalTextSearchMs: { median: median(search), max: Math.max(...search), threshold: 200, pass: median(search) < 200 },
    },
  };
  report.pass = report.results.exactIdLookupMs.pass && report.results.typicalTextSearchMs.pass;
  if (reportPath) await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.pass ? 0 : 1;
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
