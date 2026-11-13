import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

const fixtureDir = resolve(import.meta.dirname, 'fixtures/twentyfirst');
// Built from parts so this guard never holds the literal strings the pre-commit scan looks for.
const site = ['21st', 'dev'].join('.');
const cdnHost = `cdn.${site}`;
const registryPath = `${site}/r/`;

test('every 21st.dev paste fixture is synthetic and holds no real 21st.dev links', async () => {
  const names = (await readdir(fixtureDir)).filter((name) => name.endsWith('.txt')).sort();
  assert.ok(names.length >= 16, `expected the full fixture set, found ${names.length}`);
  for (const name of names) {
    const text = await readFile(join(fixtureDir, name), 'utf8');
    const firstLine = text.split('\n').find((line) => line.trim() !== '');
    assert.ok(firstLine?.includes('SYNTHETIC FIXTURE'), `${name} must start with a SYNTHETIC FIXTURE line`);
    assert.ok(!text.includes(cdnHost), `${name} must not reference the 21st.dev asset host`);
    assert.ok(!text.includes(registryPath), `${name} must not reference a 21st.dev registry link`);
  }
});
