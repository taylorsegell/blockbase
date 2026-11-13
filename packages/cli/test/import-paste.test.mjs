import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseCliErrorEnvelope, parseCliSuccessEnvelope } from '@blockbase/contracts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = resolve(packageRoot, 'dist/index.js');
const fixtures = resolve(packageRoot, '../core/test/fixtures/twentyfirst');

async function sandbox() {
  const root = await mkdtemp('/tmp/blockbase-cli-paste-');
  const home = join(root, 'home');
  await mkdir(home);
  return { root, home, catalog: join(root, 'catalog') };
}

// HOME and BLOCKBASE_HOME always point into the test sandbox, never at a real catalog.
function invoke(box, args, input) {
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd: packageRoot,
    env: { ...process.env, HOME: box.home, BLOCKBASE_HOME: join(box.root, 'blockbase-home') },
    encoding: 'utf8',
    input: input ?? '',
  });
  return { ...result, json: args.includes('--json') && result.stdout.trim() ? JSON.parse(result.stdout) : null };
}

const fixture = (name) => readFile(join(fixtures, name), 'utf8');

test('import --from 21st stores the block, installs the demo, and keeps the raw paste', async () => {
  const box = await sandbox();
  const paste = await fixture('current-format.txt');
  const result = invoke(box, ['import', '-', '--from', '21st', '--catalog', box.catalog, '--source-url', 'https://example.invalid/skyline', '--json'], paste);
  assert.equal(result.status, 0, result.stderr);
  const envelope = parseCliSuccessEnvelope(result.json);
  const data = envelope.data;
  assert.equal(data.paste.format, 'filename-fences');
  assert.deepEqual(data.paste.files.map((file) => [file.path, file.role]), [['skyline-card.tsx', 'component'], ['demo.tsx', 'demo']]);
  assert.equal(data.paste.entryPoint, 'skyline-card.tsx');
  assert.equal(data.demo.installed, true);
  assert.deepEqual(data.demo.rewrites, [{ from: '@/components/ui/skyline-card', to: '@block' }]);
  assert.match(await readFile(data.demo.path, 'utf8'), /from "@block"/);
  assert.equal(await readFile(data.paste.rawPastePath, 'utf8'), paste);
  assert.equal(data.envelope.files.some((file) => file.path === 'demo.tsx'), false);
  assert.deepEqual(data.envelope.files.map((file) => file.path), ['skyline-card.tsx']);
  assert.equal(data.manifest.provenance.license, 'unknown');
  assert.equal(data.envelope.provenance.locator, 'https://example.invalid/skyline');
  assert.ok(data.manifest.dependencies.some((dependency) => dependency.name === 'gsap' && dependency.range === '3.12.5'));
});

test('import --from 21st accepts the --name=value forms', async () => {
  const box = await sandbox();
  const result = invoke(box, ['import', '-', '--from=21st', '--catalog', box.catalog, '--license=MIT', '--author=Example Author', '--tag=hero', '--json'], await fixture('current-format.txt'));
  assert.equal(result.status, 0, result.stderr);
  const { manifest } = parseCliSuccessEnvelope(result.json).data;
  assert.equal(manifest.provenance.license, 'MIT');
  assert.equal(manifest.provenance.author, 'Example Author');
  assert.ok(manifest.tags.includes('hero'));
});

test('unreadable paste exits with invalid input, reports reasons, and imports nothing', async () => {
  const box = await sandbox();
  const result = invoke(box, ['import', '-', '--from', '21st', '--catalog', box.catalog, '--json'], await fixture('unreadable-prose.txt'));
  assert.equal(result.status, 4);
  const envelope = parseCliErrorEnvelope(result.json);
  assert.equal(envelope.error.code, 'IMPORT_PASTE_UNREADABLE');
  assert.ok(Array.isArray(envelope.error.details.reasons) && envelope.error.details.reasons.length > 0);
  assert.equal(existsSync(join(box.catalog, 'components')), false);
});

test('bare code needs --name and imports with it', async () => {
  const box = await sandbox();
  const paste = await fixture('bare-unfenced.txt');
  const missing = invoke(box, ['import', '-', '--from', '21st', '--catalog', box.catalog, '--json'], paste);
  assert.equal(missing.status, 4);
  assert.equal(parseCliErrorEnvelope(missing.json).error.code, 'IMPORT_PASTE_NAME_REQUIRED');
  const named = invoke(box, ['import', '-', '--from', '21st', '--name', 'Soft Tag', '--catalog', box.catalog, '--json'], paste);
  assert.equal(named.status, 0, named.stderr);
  assert.equal(parseCliSuccessEnvelope(named.json).data.manifest.slug, 'soft-tag');
});

test('provenance options apply to a plain file import', async () => {
  const box = await sandbox();
  const file = join(box.root, 'Card.tsx');
  await writeFile(file, 'export function Card() { return null; }\n');
  const result = invoke(box, ['import', file, '--catalog', box.catalog, '--source-type', 'url', '--source-url', 'https://example.invalid/card', '--license', 'MIT', '--author', 'Example Author', '--tag', 'one', '--tag', 'two', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const data = parseCliSuccessEnvelope(result.json).data;
  assert.equal(data.envelope.provenance.sourceType, 'url');
  assert.equal(data.envelope.provenance.locator, 'https://example.invalid/card');
  assert.equal(data.manifest.provenance.license, 'MIT');
  assert.equal(data.manifest.provenance.author, 'Example Author');
  assert.equal(data.manifest.provenance.attributionStatus, 'known');
  assert.ok(data.manifest.tags.includes('one') && data.manifest.tags.includes('two'));
  assert.equal('demo' in data, false);
  assert.equal('paste' in data, false);
});

test('import without new options keeps the existing result keys', async () => {
  const box = await sandbox();
  const file = join(box.root, 'Card.tsx');
  await writeFile(file, 'export function Card() { return null; }\n');
  const result = invoke(box, ['import', file, '--catalog', box.catalog, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(Object.keys(parseCliSuccessEnvelope(result.json).data).sort(), ['componentPath', 'envelope', 'integrity', 'manifest', 'packagePath', 'revisionId', 'revisionPath']);
});

test('--demo installs a directory file as the demo without changing the revision identity', async () => {
  const withDemo = await sandbox();
  const folder = join(withDemo.root, 'scratch');
  await mkdir(folder);
  await writeFile(join(folder, 'skyline-card.tsx'), 'export default function SkylineCard() { return null; }\n');
  await writeFile(join(folder, 'demo.tsx'), 'import SkylineCard from "./skyline-card";\nexport default function Demo() { return <SkylineCard />; }\n');
  const result = invoke(withDemo, ['import', folder, '--entry-point', 'skyline-card.tsx', '--demo', 'demo.tsx', '--catalog', withDemo.catalog, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const data = parseCliSuccessEnvelope(result.json).data;
  assert.equal(data.demo.installed, true);
  assert.deepEqual(data.demo.rewrites, [{ from: './skyline-card', to: '@block' }]);
  assert.deepEqual(data.envelope.files.map((file) => file.path), ['skyline-card.tsx']);

  const plain = await sandbox();
  const plainFolder = join(plain.root, 'scratch');
  await mkdir(plainFolder);
  await writeFile(join(plainFolder, 'skyline-card.tsx'), 'export default function SkylineCard() { return null; }\n');
  const baseline = invoke(plain, ['import', plainFolder, '--entry-point', 'skyline-card.tsx', '--catalog', plain.catalog, '--json']);
  assert.equal(baseline.status, 0, baseline.stderr);
  assert.equal(parseCliSuccessEnvelope(baseline.json).data.revisionId, data.revisionId);
});

test('--demo on a file source is an invalid path', async () => {
  const box = await sandbox();
  const file = join(box.root, 'Card.tsx');
  await writeFile(file, 'export function Card() { return null; }\n');
  const result = invoke(box, ['import', file, '--demo', 'demo.tsx', '--catalog', box.catalog, '--json']);
  assert.equal(result.status, 4);
  assert.equal(parseCliErrorEnvelope(result.json).error.code, 'IMPORT_INVALID_PATH');
});

test('wrong option combinations are usage errors', async () => {
  const box = await sandbox();
  const file = join(box.root, 'Card.tsx');
  await writeFile(file, 'export function Card() { return null; }\n');
  const cases = [
    ['import', file, '--from', '21st'],
    ['import', '-', '--from', 'shadcn'],
    ['inbox', 'import', 'some-id', '--from', '21st'],
    ['search', 'card', '--from', '21st'],
    ['import', '-', '--from', '21st', '--demo', 'demo.tsx'],
    ['inbox', 'add', '-', '--demo', 'demo.tsx'],
    ['import', file, '--source-type', 'website'],
    ['search', 'card', '--license', 'MIT'],
    ['inbox', 'add', '-', '--author', 'Someone'],
    ['search', 'card', '--tag', 'hero'],
    ['tag', 'add', 'card', '--tag', 'one', '--tag', 'two'],
    ['tag', 'remove', 'card'],
  ];
  for (const args of cases) {
    const result = invoke(box, [...args, '--catalog', box.catalog, '--json']);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    const envelope = parseCliErrorEnvelope(result.json);
    assert.equal(envelope.error.code, 'INVALID_ARGUMENTS');
    assert.doesNotMatch(envelope.error.message, /f[l]ag/i);
  }
});

test('catalog commands and history undo accept a folder holding demo.tsx and source-paste.txt', async () => {
  const box = await sandbox();
  await mkdir(box.catalog, { recursive: true });
  const imported = invoke(box, ['import', '-', '--from', '21st', '--catalog', box.catalog, '--json'], await fixture('current-format.txt'));
  assert.equal(imported.status, 0, imported.stderr);
  const { componentPath } = parseCliSuccessEnvelope(imported.json).data;
  assert.ok(existsSync(join(componentPath, 'demo.tsx')));
  assert.ok(existsSync(join(componentPath, 'source-paste.txt')));
  for (const command of [['catalog', 'validate'], ['doctor'], ['catalog', 'rebuild']]) {
    const result = invoke(box, [...command, '--catalog', box.catalog, '--json']);
    assert.equal(result.status, 0, `${command.join(' ')}: ${result.stdout}${result.stderr}`);
  }
  const undo = invoke(box, ['history', 'undo', '--catalog', box.catalog, '--json']);
  assert.equal(undo.status, 0, `${undo.stdout}${undo.stderr}`);
  assert.equal(existsSync(join(componentPath, 'demo.tsx')), false);
  assert.equal(existsSync(join(componentPath, 'source-paste.txt')), false);
});

test('inbox add --from 21st parks the paste and add, list and show report from 21st', async () => {
  const box = await sandbox();
  const paste = await fixture('current-format.txt');
  const added = invoke(box, ['inbox', 'add', '-', '--from', '21st', '--catalog', box.catalog, '--json'], paste);
  assert.equal(added.status, 0, added.stderr);
  const item = parseCliSuccessEnvelope(added.json).data;
  assert.equal(item.from, '21st');
  assert.equal(item.entryPoint, null);
  assert.equal(await readFile(join(item.payloadPath, 'paste.txt'), 'utf8'), paste);
  const listed = invoke(box, ['inbox', 'list', '--catalog', box.catalog, '--json']);
  assert.equal(parseCliSuccessEnvelope(listed.json).data.items[0].from, '21st');
  const shown = invoke(box, ['inbox', 'show', item.id, '--catalog', box.catalog, '--json']);
  assert.equal(parseCliSuccessEnvelope(shown.json).data.from, '21st');
});

test('inbox add without --from keeps the same output with no from key', async () => {
  const box = await sandbox();
  const added = invoke(box, ['inbox', 'add', '-', '--entry-point', 'Card.tsx', '--catalog', box.catalog, '--json'], 'export function Card() { return null; }\n');
  assert.equal(added.status, 0, added.stderr);
  const item = parseCliSuccessEnvelope(added.json).data;
  assert.deepEqual(Object.keys(item), ['addedAt', 'entryPoint', 'id', 'kind', 'label', 'originalPath', 'payloadPath', 'schemaVersion']);
  for (const args of [['inbox', 'list'], ['inbox', 'show', item.id]]) {
    const result = invoke(box, [...args, '--catalog', box.catalog, '--json']);
    assert.equal(result.stdout.includes('"from"'), false, args.join(' '));
  }
});

test('inbox add --from 21st refuses an unreadable paste and parks nothing', async () => {
  const box = await sandbox();
  const result = invoke(box, ['inbox', 'add', '-', '--from', '21st', '--catalog', box.catalog, '--json'], await fixture('unreadable-prose.txt'));
  assert.notEqual(result.status, 0);
  assert.equal(parseCliErrorEnvelope(result.json).error.code, 'IMPORT_PASTE_UNREADABLE');
  const listed = invoke(box, ['inbox', 'list', '--catalog', box.catalog, '--json']);
  assert.deepEqual(parseCliSuccessEnvelope(listed.json).data.items, []);
});

test('inbox import of a 21st paste returns paste and demo summaries and applies provenance', async () => {
  const box = await sandbox();
  const paste = await fixture('current-format.txt');
  const item = parseCliSuccessEnvelope(invoke(box, ['inbox', 'add', '-', '--from', '21st', '--catalog', box.catalog, '--json'], paste).json).data;
  const result = invoke(box, ['inbox', 'import', item.id, '--catalog', box.catalog, '--license', 'MIT', '--tag', 'hero', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const data = parseCliSuccessEnvelope(result.json).data;
  assert.equal(data.discarded, true);
  assert.equal(data.manifest.provenance.license, 'MIT');
  assert.ok(data.manifest.tags.includes('hero'));
  assert.equal(data.paste.format, 'filename-fences');
  assert.deepEqual(data.paste.files.map((file) => [file.path, file.role]), [['skyline-card.tsx', 'component'], ['demo.tsx', 'demo']]);
  assert.deepEqual(data.paste.suspicions, []);
  assert.equal(await readFile(data.paste.rawPastePath, 'utf8'), paste);
  assert.equal(data.demo.installed, true);
  assert.deepEqual(data.demo.rewrites, [{ from: '@/components/ui/skyline-card', to: '@block' }]);
  const live = invoke(box, ['import', '-', '--from', '21st', '--catalog', join(box.root, 'live'), '--json'], paste);
  assert.equal(data.revisionId, parseCliSuccessEnvelope(live.json).data.revisionId);
});

test('inbox import of a plain item keeps its result keys', async () => {
  const box = await sandbox();
  const item = parseCliSuccessEnvelope(invoke(box, ['inbox', 'add', '-', '--entry-point', 'Card.tsx', '--catalog', box.catalog, '--json'], 'export function Card() { return null; }\n').json).data;
  const result = invoke(box, ['inbox', 'import', item.id, '--slug', 'card', '--catalog', box.catalog, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(Object.keys(parseCliSuccessEnvelope(result.json).data), ['discarded', 'inboxId', 'manifest', 'packagePath', 'revisionId']);
});
