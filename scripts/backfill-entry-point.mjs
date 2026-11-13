#!/usr/bin/env node
// Backfill `entryPoint` into component.json manifests that predate the field.
// Usage: node scripts/backfill-entry-point.mjs --catalog <root> [--dry-run] [--json]
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import { chooseEntryPoint, RevisionStore, rebuildIndex } from '../packages/core/dist/index.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const catalogIndex = args.indexOf('--catalog');
const catalog = catalogIndex >= 0 ? args[catalogIndex + 1] : undefined;
if (!catalog) {
  console.error('Usage: backfill-entry-point.mjs --catalog <root> [--dry-run] [--json]');
  process.exit(2);
}
const root = resolve(catalog);
const dryRun = flag('--dry-run');
const json = flag('--json');

async function dirs(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
}

async function filesUnder(base) {
  const out = [];
  async function visit(dir) {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await visit(full);
      else if (e.isFile()) out.push(relative(base, full).split(sep).join('/'));
    }
  }
  await visit(base);
  return out;
}

let report = { entries: [] };
try { report = JSON.parse(await readFile(join(root, 'migration-report.json'), 'utf8')); } catch { /* no report */ }
const reportEntries = Array.isArray(report.entries) ? report.entries : [];
function fromReport(manifest) {
  const hit = reportEntries.find((e) => e && typeof e.entryPoint === 'string' && e.entryPoint
    && (e.componentId === manifest.componentId
      || (e.target?.componentId === manifest.componentId)
      || ((e.namespace ?? e.target?.namespace) === manifest.namespace && (e.slug ?? e.target?.slug) === manifest.slug)));
  return hit?.entryPoint;
}

const store = new RevisionStore({ catalogRoot: root });
const counts = { updated: 0, skipped: 0, fromReport: 0, fromHeuristic: 0 };
const failures = [];
const started = Date.now();
for (const namespace of await dirs(join(root, 'components'))) {
  for (const slug of await dirs(join(root, 'components', namespace))) {
    let manifest;
    try { manifest = await store.readManifest(namespace, slug); } catch { counts.skipped += 1; continue; }
    if (manifest.entryPoint) { counts.skipped += 1; continue; }
    const originals = join(root, 'components', namespace, slug, 'revisions', manifest.currentRevision.replace(/^sha256:/, ''), 'original');
    const files = await filesUnder(originals);
    let entryPoint = fromReport(manifest);
    let source = 'report';
    if (entryPoint && !files.includes(entryPoint)) entryPoint = undefined;
    if (!entryPoint) { entryPoint = chooseEntryPoint(files); source = 'heuristic'; }
    if (!entryPoint) { counts.skipped += 1; failures.push({ componentId: manifest.componentId, reason: 'no entry point resolvable' }); continue; }
    if (!dryRun) await store.updateManifest(namespace, slug, { ...manifest, entryPoint });
    counts.updated += 1;
    counts[source === 'report' ? 'fromReport' : 'fromHeuristic'] += 1;
  }
}
if (!dryRun && counts.updated > 0) await rebuildIndex({ catalogRoot: root });
const result = { ...counts, ...(dryRun ? { dryRun: true } : {}) };
if (json) console.log(JSON.stringify(failures.length ? { ...result, failures } : result));
else {
  console.log(`${dryRun ? '[dry-run] ' : ''}updated=${counts.updated} skipped=${counts.skipped} fromReport=${counts.fromReport} fromHeuristic=${counts.fromHeuristic} (${Date.now() - started}ms)`);
  for (const f of failures) console.log(`  skipped ${f.componentId}: ${f.reason}`);
}
