import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseCliErrorEnvelope, parseCliSuccessEnvelope, parseProjectProfile } from '@blockbase/contracts';
import { applyLegacyMigration, rebuildIndex } from '@blockbase/core';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = resolve(packageRoot, 'dist/index.js');
const fixtures = resolve(packageRoot, '../../tests/fixtures/legacy-catalog');
const destinationFixtures = resolve(packageRoot, '../../tests/fixtures/destinations');

// `resolveCatalog`'s platform-default candidate always resolves under `$HOME`, independent of
// `BLOCKBASE_HOME`/`--catalog`. Overriding only `BLOCKBASE_HOME` isn't enough to isolate a test
// from whatever the real developer machine actually has at `~/.blocks` (which is real and
// populated on any machine that has run a real local migration) — `HOME` must be pinned to a
// definitely-empty directory too, or "no catalog is configured" tests can spuriously see the
// operator's real catalog.
function invoke(args, options = {}) {
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd: options.cwd ?? packageRoot,
    env: {
      ...process.env,
      HOME: options.home ?? join(packageRoot, 'missing-home'),
      BLOCKBASE_HOME: options.blockbaseHome ?? join(packageRoot, 'missing-home'),
    },
    encoding: 'utf8',
  });
  return { ...result, json: args.includes('--json') && result.stdout.trim() ? JSON.parse(result.stdout) : null };
}

test('package bin resolves to the blockbase executable', async () => {
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.bin.blockbase, 'dist/index.js');
  const linkRoot = await mkdtemp('/tmp/blockbase-cli-bin-');
  const link = join(linkRoot, 'blockbase');
  await symlink(executable, link);
  const output = execFileSync(process.execPath, [link, 'catalog', 'locate', '--catalog', join(fixtures, 'valid'), '--json'], { encoding: 'utf8' });
  assert.equal(output.includes('catalog.yaml'), true);
});

test('catalog locate emits one schema-valid JSON success envelope with stdout purity', () => {
  const result = invoke(['catalog', 'locate', '--catalog', join(fixtures, 'valid'), '--json']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.endsWith('\n'), true);
  assert.equal(result.stdout.trim().split('\n').filter(Boolean).length > 1, true, 'pretty JSON is one document, not one line per event');
  assert.equal(result.stderr, '');
  const envelope = parseCliSuccessEnvelope(result.json);
  assert.equal(envelope.operation, 'catalog.locate');
  assert.equal(envelope.data.path, join(fixtures, 'valid', 'catalog.yaml'));
});

test('catalog validate and doctor delegate to core and preserve a valid fixture', () => {
  for (const command of [['catalog', 'validate'], ['doctor']]) {
    const result = invoke([...command, '--catalog', join(fixtures, 'valid'), '--json']);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    const envelope = parseCliSuccessEnvelope(result.json);
    assert.equal(envelope.operation, command[0] === 'doctor' ? 'doctor' : 'catalog.validate');
    assert.equal(envelope.data.entryCount, 1);
    assert.equal(envelope.data.diagnostics.length, 0);
  }
});

test('doctor, catalog validate, and catalog locate all recognize a real migrated (index.sqlite) catalog', async () => {
  const root = await mkdtemp('/tmp/blockbase-cli-migrated-');
  const migrated = join(root, 'migrated-catalog');
  await applyLegacyMigration({ sourceRoot: join(fixtures, 'valid'), targetRoot: migrated });
  await rebuildIndex({ catalogRoot: migrated });

  const locate = invoke(['catalog', 'locate', '--catalog', migrated, '--json']);
  assert.equal(locate.status, 0);
  const locateEnvelope = parseCliSuccessEnvelope(locate.json);
  assert.equal(locateEnvelope.data.path, join(migrated, 'index.sqlite'));
  assert.equal(locateEnvelope.data.found, true);

  for (const command of [['catalog', 'validate'], ['doctor']]) {
    const result = invoke([...command, '--catalog', migrated, '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const envelope = parseCliSuccessEnvelope(result.json);
    assert.equal(envelope.data.format, 'migrated');
    assert.equal(envelope.data.status, 'healthy');
    assert.equal(envelope.data.classification, 'healthy');
    assert.equal(typeof envelope.data.catalogRevision, 'string');
  }
});

test('doctor and catalog validate report an unhealthy migrated catalog without pretending it is a legacy one', async () => {
  const root = await mkdtemp('/tmp/blockbase-cli-migrated-corrupt-');
  const migrated = join(root, 'migrated-catalog');
  await applyLegacyMigration({ sourceRoot: join(fixtures, 'valid'), targetRoot: migrated });
  await rebuildIndex({ catalogRoot: migrated });
  await writeFile(join(migrated, 'index.sqlite'), 'not a real sqlite file');

  for (const command of [['catalog', 'validate'], ['doctor']]) {
    const result = invoke([...command, '--catalog', migrated, '--json']);
    assert.equal(result.status, 7);
    const envelope = parseCliErrorEnvelope(result.json);
    assert.equal(envelope.error.code, 'CATALOG_VALIDATION_FAILED');
    assert.equal(envelope.error.details.format, 'migrated');
    assert.equal(envelope.error.details.status, 'unhealthy');
  }
  await rm(root, { recursive: true, force: true });
});

test('warning diagnostics stay structured in stdout and human-readable on stderr', async () => {
  const root = await mkdtemp('/tmp/blockbase-cli-warning-');
  const component = join(root, 'empty-states', 'dino-404');
  await mkdir(component, { recursive: true });
  await writeFile(join(root, 'catalog.yaml'), `blocks:\n  - name: empty-states\n    bucket: brick\n    slug: dino-404\n    path: empty-states/dino-404\n    exported: Dino\n    tags: []\n  - name: empty-states\n    bucket: brick\n    slug: snowboarder-404\n    path: empty-states/dino-404\n    exported: Dino\n    tags: []\n`);
  await writeFile(join(root, 'taxonomy.csv'), 'Name,Slug\nEmpty States,empty-states\n');
  await writeFile(join(component, 'meta.yaml'), 'name: empty-states\nbucket: brick\nslug: dino-404\nexported: Dino\ntags: []\n');
  await writeFile(join(component, 'BLOCK.md'), '# Dino\n');
  await writeFile(join(component, 'Dino.tsx'), 'export function Dino() { return null; }\n');
  await writeFile(join(component, 'index.ts'), "export { Dino } from './Dino';\n");
  const result = invoke(['catalog', 'validate', '--catalog', root, '--json']);
  assert.equal(result.status, 0);
  const envelope = parseCliSuccessEnvelope(result.json);
  assert.equal(envelope.warnings.some((item) => item.code === 'catalog.shared_path_exception'), true);
  assert.equal(result.stderr.includes('catalog.shared_path_exception'), true);
  assert.equal(result.stdout.includes('Warning ['), false);
});

test('missing catalog returns one structured error, all checked locations, and no created files', async () => {
  const root = await mkdtemp('/tmp/blockbase-cli-missing-');
  const result = invoke(['catalog', 'locate', '--catalog', join(root, 'explicit'), '--json'], { blockbaseHome: join(root, 'home') });
  assert.equal(result.status, 3);
  assert.equal(result.stderr.includes('CATALOG_NOT_FOUND'), true);
  const envelope = parseCliErrorEnvelope(result.json);
  assert.equal(envelope.error.code, 'CATALOG_NOT_FOUND');
  assert.equal(envelope.error.details.checkedLocations.length, 3);
  assert.equal(envelope.recoveryActions.length, 2);
  assert.equal(result.stdout.includes('Error ['), false);
  const entries = await readdir(root);
  assert.deepEqual(entries, []);
});

test('invalid arguments return a schema-valid usage envelope and stderr diagnostic', () => {
  const result = invoke(['catalog', 'locate', '--unknown', '--json']);
  assert.equal(result.status, 2);
  const envelope = parseCliErrorEnvelope(result.json);
  assert.equal(envelope.operation, 'catalog.locate');
  assert.equal(envelope.error.code, 'INVALID_ARGUMENTS');
  assert.equal(result.stderr.includes('INVALID_ARGUMENTS'), true);
});

test('legacy validation maps core diagnostics to a stable validation exit', () => {
  const result = invoke(['catalog', 'validate', '--catalog', join(fixtures, 'invalid'), '--json']);
  assert.equal(result.status, 7);
  const envelope = parseCliErrorEnvelope(result.json);
  assert.equal(envelope.operation, 'catalog.validate');
  assert.equal(envelope.error.code, 'CATALOG_VALIDATION_FAILED');
  assert.equal(envelope.error.details.diagnostics.some((item) => item.code === 'catalog.path_traversal'), true);
  assert.equal(result.stdout.includes('Error ['), false);
  assert.equal(result.stderr.includes('CATALOG_VALIDATION_FAILED'), true);
});

test('human mode writes usable result to stdout and diagnostics to stderr', () => {
  const result = invoke(['catalog', 'locate', '--catalog', join(fixtures, 'valid')]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.includes('Catalog:'), true);
  assert.equal(result.stderr, '');
});

test('project inspect emits a schema-valid bounded profile for each React fixture', () => {
  const a = invoke(['project', 'inspect', '--cwd', join(destinationFixtures, 'fixture-a'), '--json']);
  assert.equal(a.status, 0);
  assert.equal(a.stderr, '');
  const profileA = parseProjectProfile(parseCliSuccessEnvelope(a.json).data);
  assert.equal(profileA.framework.name, 'vite');
  assert.equal(profileA.styling.systems.includes('tailwind'), true);
  const b = invoke(['project', 'inspect', `--cwd=${join(destinationFixtures, 'fixture-b')}`, '--json']);
  assert.equal(b.status, 0);
  const profileB = parseProjectProfile(parseCliSuccessEnvelope(b.json).data);
  assert.equal(profileB.framework.name, 'next');
  assert.equal(profileB.styling.systems.includes('tailwind'), false);
  assert.notEqual(profileA.conventions.importAlias, profileB.conventions.importAlias);
});

test('project inspect returns conflict and unsupported exit codes without destination writes', async () => {
  const root = await mkdtemp('/tmp/blockbase-cli-project-');
  await mkdir(join(root, 'src', 'components'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { react: '18.0.0', vite: '5.0.0' } }));
  await writeFile(join(root, 'src', 'index.css'), ':root { --surface: white; }\n');
  await writeFile(join(root, 'src', 'globals.css'), ':root { --surface: black; }\n');
  const before = await readdir(root);
  const conflict = invoke(['project', 'inspect', '--cwd', root, '--json']);
  assert.equal(conflict.status, 5);
  assert.equal(parseCliErrorEnvelope(conflict.json).error.code, 'PROJECT_CONFLICT');
  assert.deepEqual(await readdir(root), before);
  const unsupported = join(root, 'unsupported');
  await mkdir(unsupported);
  await writeFile(join(unsupported, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }));
  const result = invoke(['project', 'inspect', '--cwd', unsupported, '--json']);
  assert.equal(result.status, 6);
  assert.equal(parseCliErrorEnvelope(result.json).error.code, 'PROJECT_UNSUPPORTED_FRAMEWORK');
});

test('import command commits a source package and keeps stdout machine-readable', async () => {
  const root = await mkdtemp('/tmp/blockbase-cli-import-');
  const source = join(root, 'source');
  const catalog = join(root, 'catalog');
  await mkdir(source);
  await writeFile(join(source, 'index.tsx'), 'export function Card() { return <div />; }\n');
  const result = invoke(['import', source, '--catalog', catalog, '--json']);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const envelope = parseCliSuccessEnvelope(result.json);
  assert.equal(envelope.operation, 'import');
  assert.match(envelope.data.revisionId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(await readFile(join(envelope.data.revisionPath, 'original/index.tsx'), 'utf8'), 'export function Card() { return <div />; }\n');
});

test('import command accepts stdin and reports stable path failures', async () => {
  const root = await mkdtemp('/tmp/blockbase-cli-stdin-');
  const result = spawnSync(process.execPath, [executable, 'import', '-', '--catalog', join(root, 'catalog'), '--entry-point', 'Card.tsx', '--json'], {
    input: 'export function Card() { return null; }\n',
    cwd: packageRoot,
    env: { ...process.env },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  const envelope = parseCliSuccessEnvelope(JSON.parse(result.stdout));
  assert.equal(envelope.data.envelope.sourceType, 'stdin');
  const missing = invoke(['import', join(root, 'missing.tsx'), '--catalog', join(root, 'catalog'), '--json']);
  assert.equal(missing.status, 3);
  assert.equal(parseCliErrorEnvelope(missing.json).error.code, 'IMPORT_SOURCE_NOT_FOUND');
});

test('--help prints the command overview and a per-command manual on stdout', () => {
  const overview = spawnSync(process.execPath, [executable, '--help'], { encoding: 'utf8' });
  assert.equal(overview.status, 0);
  assert.match(overview.stdout, /^Usage: blockbase <command> \[options\]$/m);
  assert.match(overview.stdout, /^  history undo +Rolls the whole catalog back/m);
  assert.match(overview.stdout, /^Exit codes: 0 ok, 2 usage/m);

  const manual = spawnSync(process.execPath, [executable, 'history', 'undo', '--help'], { encoding: 'utf8' });
  assert.equal(manual.status, 0);
  assert.match(manual.stdout, /^Usage: blockbase history undo \[--steps <number> \| --to <commit>\]/);
  assert.match(manual.stdout, /^  blockbase history undo --steps 3 --json$/m);
  assert.doesNotMatch(manual.stdout, /confirm with the user/i);
  assert.equal(spawnSync(process.execPath, [executable, 'help', 'tag', 'add'], { encoding: 'utf8' }).stdout, spawnSync(process.execPath, [executable, 'tag', 'add', '-h'], { encoding: 'utf8' }).stdout);

  const unknown = spawnSync(process.execPath, [executable, 'help', 'nope'], { encoding: 'utf8' });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown command 'nope'/);
});
