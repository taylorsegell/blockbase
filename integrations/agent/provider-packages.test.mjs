import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const integrationRoot = resolve(import.meta.dirname);
const generator = join(integrationRoot, 'generate.mjs');
const generatedRoot = join(integrationRoot, 'generated');
const providers = ['claude-code', 'codex', 'cursor'];
const focusedSkills = ['blockbase-capture', 'blockbase-inbox', 'blockbase-find-and-fit', 'blockbase-organize', 'blockbase-audit'];

function runGenerator(...args) {
  const result = spawnSync(process.execPath, [generator, ...args], { cwd: integrationRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function read(relative) {
  return readFile(join(integrationRoot, relative), 'utf8');
}

test('provider generation is deterministic and drift-free', async () => {
  const firstHash = runGenerator('--hash');
  const secondHash = runGenerator('--hash');
  assert.match(firstHash, /^[a-f0-9]{64}$/);
  assert.equal(secondHash, firstHash);
  assert.match(runGenerator('--check'), /^provider packages are drift-free \(\d+ files\)$/);
});

function forHostWithoutPluginRoot(skill) {
  return skill
    .replace(/Command contracts live at `\$\{CLAUDE_PLUGIN_ROOT\}\/references\/commands\/`\. When that variable is unset[^\n]*/, 'Command contracts live at `../../references/commands/` relative to this skill directory.')
    .replaceAll('${CLAUDE_PLUGIN_ROOT}/references/commands/', '../../references/commands/');
}

test('provider packages are generated copies of canonical sources', async () => {
  const canonicalSkills = await Promise.all([
    read('SKILL.md'),
    ...focusedSkills.map((skill) => read(`skills/${skill}/SKILL.md`)),
  ]);
  const canonicalMetadata = await read('command-metadata.json');
  const metadata = JSON.parse(canonicalMetadata);
  assert.ok(Object.keys(metadata).length >= 10);
  for (const entry of Object.values(metadata)) {
    assert.equal(entry.json, true);
    assert.ok(entry.operation);
    assert.ok(entry.description);
    assert.ok(entry.argumentHint);
  }

  for (const provider of providers) {
    const manifest = JSON.parse(await read(`generated/${provider}/manifest.json`));
    assert.equal(manifest.provider, provider);
    assert.equal(manifest.generatedFrom, 'integrations/agent');
    assert.match(manifest.sourceHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(manifest.skills, ['blockbase', ...focusedSkills]);
    assert.equal(await read(`generated/${provider}/command-metadata.json`), canonicalMetadata);
    assert.deepEqual(await Promise.all([
      read(`generated/${provider}/skills/blockbase/SKILL.md`),
      ...focusedSkills.map((skill) => read(`generated/${provider}/skills/${skill}/SKILL.md`)),
    ]), provider === 'claude-code' ? canonicalSkills : canonicalSkills.map(forHostWithoutPluginRoot));
  }
});

test('focused workflows load operation references and contain orchestration only', async () => {
  const capture = await read('skills/blockbase-capture/SKILL.md');
  const findAndFit = await read('skills/blockbase-find-and-fit/SKILL.md');
  for (const reference of ['import', 'catalog-validate']) assert.match(capture, new RegExp(`references/commands/${reference}\\.md`));
  for (const reference of ['project-inspect', 'search', 'adapt', 'add', 'validate']) assert.match(findAndFit, new RegExp(`references/commands/${reference}\\.md`));
  assert.doesNotMatch(capture, /JSON\.parse|writeFile|readFile|token mapping|className/);
  assert.doesNotMatch(findAndFit, /JSON\.parse|writeFile|readFile|token mapping|className/);
  const allGenerated = (await Promise.all(providers.flatMap((provider) => [
    read(`generated/${provider}/skills/blockbase/SKILL.md`),
    ...focusedSkills.map((skill) => read(`generated/${provider}/skills/${skill}/SKILL.md`)),
  ]))).join('\n');
  assert.doesNotMatch(allGenerated, /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)/);
});

test('capture skill and router teach 21st.dev paste import', async () => {
  const capture = await read('skills/blockbase-capture/SKILL.md');
  const router = await read('SKILL.md');
  const pastePhrases = ['--from 21st', '--demo', 'ask for a component name', 'Never repair or guess the code.', 'demo.rewrites'];
  for (const phrase of pastePhrases) assert.ok(capture.includes(phrase), `capture skill names ${phrase}`);
  assert.doesNotMatch(capture, /JSON\.parse|writeFile|readFile|token mapping|className/);
  assert.match(router, /21st\.dev/);
  for (const provider of providers) {
    const generatedCapture = await read(`generated/${provider}/skills/blockbase-capture/SKILL.md`);
    for (const phrase of pastePhrases) assert.ok(generatedCapture.includes(phrase), `${provider} capture skill names ${phrase}`);
    assert.match(await read(`generated/${provider}/skills/blockbase/SKILL.md`), /21st\.dev/);
  }
});
