import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  ContractValidationError,
  REMOTE_PACKAGE_MAX_DECODED_BYTES,
  REMOTE_PACKAGE_MAX_ENTRIES,
  parseRemoteComponentPackage,
} from '../dist/index.js';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = resolve(testDirectory, '../fixtures/v1');

async function basePackage() {
  return JSON.parse(await readFile(resolve(fixtureDirectory, 'remote-component-package.json'), 'utf8'));
}

function sha256Of(bytesOrString) {
  return `sha256:${createHash('sha256').update(bytesOrString).digest('hex')}`;
}

async function rejects(mutate) {
  const value = await basePackage();
  mutate(value);
  assert.throws(() => parseRemoteComponentPackage(value), ContractValidationError);
}

test('round-trips a fixture with both source files and assets', async () => {
  const value = await basePackage();
  const parsed = parseRemoteComponentPackage(value);
  assert.equal(parsed.schemaVersion, '1');
  assert.equal(parsed.componentId, 'cmp_card_01');
  assert.equal(parsed.revisionId, 'sha256:card-revision');
  assert.equal(parsed.manifest.displayName, 'Card');
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.assets.length, 1);
  assert.equal(parsed.files[0].path, 'Card.tsx');
  assert.equal(parsed.assets[0].path, 'icons/star.svg');
  assert.equal(parsed.assets[0].mediaType, 'image/svg+xml');
});

test('returns only known fields, dropping any unrecognized input properties', async () => {
  const value = await basePackage();
  value.files[0].extraneous = 'should be dropped';
  value.serverPath = '/should/never/appear';
  const parsed = parseRemoteComponentPackage(value);
  assert.equal(parsed.serverPath, undefined);
  assert.equal(parsed.files[0].extraneous, undefined);
  assert.deepEqual(Object.keys(parsed).sort(), ['assets', 'componentId', 'files', 'manifest', 'revisionId', 'schemaVersion']);
  assert.deepEqual(Object.keys(parsed.files[0]).sort(), ['content', 'contentHash', 'path']);
  assert.deepEqual(Object.keys(parsed.assets[0]).sort(), ['contentBase64', 'contentHash', 'mediaType', 'path']);
});

test('rejects an absolute file path', () => rejects((value) => { value.files[0].path = '/etc/passwd'; }));
test('rejects an absolute asset path', () => rejects((value) => { value.assets[0].path = '/etc/passwd'; }));
test('rejects a Windows drive-letter absolute path', () => rejects((value) => { value.files[0].path = 'C:\\Windows\\System32\\evil.dll'; }));
test('rejects a leading-".." traversal path', () => rejects((value) => { value.files[0].path = '../../etc/passwd'; }));
test('rejects an embedded ".." traversal segment', () => rejects((value) => { value.files[0].path = 'src/../../secrets.env'; }));
test('rejects an empty path segment', () => rejects((value) => { value.files[0].path = 'src//index.ts'; }));
test('rejects a "." path segment', () => rejects((value) => { value.files[0].path = './index.ts'; }));
test('rejects a backslash in a path', () => rejects((value) => { value.files[0].path = 'src\\index.ts'; }));

test('rejects a duplicate path within files', () => rejects((value) => { value.files.push({ ...value.files[0] }); }));
test('rejects a duplicate path within assets', () => rejects((value) => { value.assets.push({ ...value.assets[0] }); }));
test('rejects a duplicate path across files and assets combined', () => rejects((value) => {
  value.assets.push({ path: value.files[0].path, contentBase64: value.assets[0].contentBase64, contentHash: value.assets[0].contentHash, mediaType: 'text/plain' });
}));

test('rejects invalid base64 (bad characters)', () => rejects((value) => { value.assets[0].contentBase64 = '!!!not-base64!!!'; }));
test('rejects invalid base64 (bad length)', () => rejects((value) => { value.assets[0].contentBase64 = 'abcde'; }));
test('rejects invalid base64 (misplaced padding)', () => rejects((value) => { value.assets[0].contentBase64 = 'ab=c'; }));

test('rejects a file whose declared hash does not match its content', () => rejects((value) => {
  value.files[0].content = 'export const tampered = true;\n';
}));
test('rejects an asset whose declared hash does not match its bytes', () => rejects((value) => {
  value.assets[0].contentBase64 = Buffer.from('different bytes entirely').toString('base64');
}));
test('rejects a content hash in the wrong format', () => rejects((value) => { value.files[0].contentHash = 'md5:deadbeef'; }));

test('rejects a package exceeding the maximum combined entry count', async () => {
  await rejects((value) => {
    const extra = [];
    for (let i = 0; i < REMOTE_PACKAGE_MAX_ENTRIES + 1; i += 1) {
      const content = `export const n = ${i};\n`;
      extra.push({ path: `generated/file-${i}.ts`, content, contentHash: sha256Of(content) });
    }
    value.files = extra;
  });
});

test('accepts a package exactly at the maximum combined entry count', async () => {
  const value = await basePackage();
  const files = [];
  for (let i = 0; i < REMOTE_PACKAGE_MAX_ENTRIES - 1; i += 1) {
    const content = `export const n = ${i};\n`;
    files.push({ path: `generated/file-${i}.ts`, content, contentHash: sha256Of(content) });
  }
  value.files = files;
  const parsed = parseRemoteComponentPackage(value);
  assert.equal(parsed.files.length + parsed.assets.length, REMOTE_PACKAGE_MAX_ENTRIES);
});

test('rejects a payload whose combined decoded size exceeds the documented limit', () => rejects((value) => {
  const content = 'x'.repeat(REMOTE_PACKAGE_MAX_DECODED_BYTES + 1);
  value.files[0].content = content;
  value.files[0].contentHash = sha256Of(content);
}));

test('hashes multi-byte UTF-8 content (emoji, CJK, accents) correctly', async () => {
  const value = await basePackage();
  const content = '// emoji test: \u{1F389} \u4E2D\u6587\u5B57\u7B26 caf\u00e9\nexport const label = "\u{1F389}";\n';
  value.files[0].content = content;
  value.files[0].contentHash = sha256Of(Buffer.from(content, 'utf8'));
  const parsed = parseRemoteComponentPackage(value);
  assert.equal(parsed.files[0].content, content);
});

test('rejects an incompatible schemaVersion', () => rejects((value) => { value.schemaVersion = '2'; }));
test('rejects non-string file content', () => rejects((value) => { value.files[0].content = 42; }));
test('rejects non-string asset contentBase64', () => rejects((value) => { value.assets[0].contentBase64 = 42; }));
test('rejects a package whose manifest is invalid', () => rejects((value) => { delete value.manifest.componentId; }));
