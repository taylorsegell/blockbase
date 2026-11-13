import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const integrationRoot = resolve(import.meta.dirname);
const pluginRoot = join(integrationRoot, 'generated/claude-code');
const hook = join(pluginRoot, 'hooks/session-start.sh');
const bin = join(pluginRoot, 'bin/blockbase');
const version = JSON.parse(readFileSync(join(integrationRoot, 'plugin.json'), 'utf8')).version;
const SYSTEM_PATH = '/usr/bin:/bin';
// Only node itself: the real node directory may also hold a globally linked `blockbase`.
const NODE_DIR = mkdtempSync(join(tmpdir(), 'bb-node-'));
symlinkSync(process.execPath, join(NODE_DIR, 'node'));

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'bb-runtime-'));
  const dirs = { dir, home: join(dir, 'home'), data: join(dir, 'data'), stubs: join(dir, 'stubs'), env: join(dir, 'envfile') };
  mkdirSync(dirs.home);
  mkdirSync(dirs.stubs);
  writeFileSync(dirs.env, '');
  return dirs;
}

function stub(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

// Fake npm records each call and creates the entry file the hook expects.
function fakeNpm(s) {
  stub(s.stubs, 'npm', `echo "$@" >> "${s.dir}/npm.log"
prefix=""; while [ $# -gt 0 ]; do [ "$1" = --prefix ] && prefix=$2; shift; done
mkdir -p "$prefix/node_modules/@blockbase/cli/dist" && echo "" > "$prefix/node_modules/@blockbase/cli/dist/index.js"`);
}

function runHook(s, extra = {}) {
  return spawnSync('sh', [hook], {
    encoding: 'utf8',
    env: { PATH: `${s.stubs}:${SYSTEM_PATH}:${NODE_DIR}`, HOME: s.home, CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PLUGIN_DATA: s.data, CLAUDE_ENV_FILE: s.env, ...extra },
  });
}

const npmCalls = (s) => (existsSync(join(s.dir, 'npm.log')) ? readFileSync(join(s.dir, 'npm.log'), 'utf8').trim().split('\n').filter(Boolean) : []);

test('generator emits bin and hooks for claude-code only, with the version substituted', () => {
  for (const file of ['bin/blockbase', 'hooks/session-start.sh', 'hooks/hooks.json']) assert.ok(existsSync(join(pluginRoot, file)), file);
  for (const provider of ['codex', 'cursor']) for (const dir of ['bin', 'hooks']) assert.equal(existsSync(join(integrationRoot, 'generated', provider, dir)), false);
  assert.equal(statSync(bin).mode & 0o777, 0o755);
  assert.match(readFileSync(hook, 'utf8'), new RegExp(`VERSION="${version}"`));
  assert.match(readFileSync(bin, 'utf8'), new RegExp(`VERSION="${version}"`));
  assert.doesNotMatch(readFileSync(hook, 'utf8') + readFileSync(bin, 'utf8'), /__PLUGIN_VERSION__/);
  const hooks = JSON.parse(readFileSync(join(pluginRoot, 'hooks/hooks.json'), 'utf8'));
  assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /session-start\.sh/);
});

test('root marketplace points at the generated claude-code plugin', () => {
  const marketplace = JSON.parse(readFileSync(join(integrationRoot, '../../.claude-plugin/marketplace.json'), 'utf8'));
  assert.equal(marketplace.plugins[0].source, './integrations/agent/generated/claude-code');
  assert.equal(existsSync(join(integrationRoot, '.claude-plugin/marketplace.json')), false);
});

test('shell scripts pass sh -n', () => {
  for (const file of [hook, bin]) assert.equal(spawnSync('sh', ['-n', file]).status, 0, file);
});

test('hook installs once, stamps, writes the env file, and hints at setup', () => {
  const s = sandbox();
  fakeNpm(s);
  const first = runHook(s);
  assert.equal(first.status, 0);
  assert.equal(npmCalls(s).length, 1);
  assert.match(npmCalls(s)[0], new RegExp(`@blockbase/cli@${version.replaceAll('.', '\\.')}`));
  const entry = join(s.data, 'cli/node_modules/@blockbase/cli/dist/index.js');
  assert.ok(existsSync(entry));
  assert.ok(readFileSync(s.env, 'utf8').includes(`export BLOCKBASE_CLI_ENTRY='${entry}'`));
  assert.match(first.stdout, /catalog is not set up yet/);
  assert.match(first.stdout, /blockbase setup --json/);
  const second = runHook(s);
  assert.equal(second.status, 0);
  assert.equal(npmCalls(s).length, 1, 'stamp prevents reinstall');
  // A changed spec reinstalls, with a space-separated list passed as separate arguments.
  runHook(s, { BLOCKBASE_CLI_SPEC: '/tmp/a.tgz /tmp/b.tgz' });
  assert.equal(npmCalls(s).length, 2);
  assert.match(npmCalls(s)[1], /\/tmp\/a\.tgz \/tmp\/b\.tgz$/);
});

test('hook prints nothing when the catalog exists and the page is healthy', () => {
  const s = sandbox();
  fakeNpm(s);
  mkdirSync(join(s.home, '.blocks'));
  writeFileSync(join(s.home, '.blocks/index.sqlite'), '');
  stub(s.stubs, 'curl', `echo '{"ok":true,"catalogRoot":"/x"}'`);
  const result = runHook(s);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  stub(s.stubs, 'curl', 'exit 7');
  const down = runHook(s);
  assert.equal(down.status, 0);
  assert.match(down.stdout, /catalog page is not running/);
});

test('hook uses a global blockbase and skips plugin-owned ones', () => {
  const s = sandbox();
  fakeNpm(s);
  stub(s.stubs, 'blockbase', 'exit 0');
  const result = runHook(s);
  assert.equal(result.status, 0);
  assert.equal(npmCalls(s).length, 0);
  const own = sandbox();
  fakeNpm(own);
  const result2 = runHook(own, { PATH: `${pluginRoot}/bin:${own.stubs}:${SYSTEM_PATH}:${NODE_DIR}` });
  assert.equal(result2.status, 0);
  assert.equal(npmCalls(own).length, 1, 'plugin bin is not treated as an external install');
});

test('hook exits 0 with a manual fallback when npm fails or is missing', () => {
  const s = sandbox();
  stub(s.stubs, 'npm', 'exit 1');
  const failed = runHook(s);
  assert.equal(failed.status, 0);
  assert.match(failed.stdout, new RegExp(`npm install -g @blockbase/cli@${version.replaceAll('.', '\\.')}`));
  const bare = sandbox();
  const missing = runHook(bare, { PATH: SYSTEM_PATH });
  assert.equal(missing.status, 0);
  assert.match(missing.stdout, /npm install -g @blockbase\/cli/);
});

test('bin/blockbase resolution order', () => {
  const s = sandbox();
  const marker = (name) => `echo "${name}:$*"`;
  const entry = join(s.dir, 'entry.js');
  writeFileSync(entry, 'console.log("env-entry:" + process.argv.slice(2).join(" "));');
  const dataEntry = join(s.data, 'cli/node_modules/@blockbase/cli/dist/index.js');
  mkdirSync(join(s.data, 'cli/node_modules/@blockbase/cli/dist'), { recursive: true });
  writeFileSync(dataEntry, 'console.log("data-entry:" + process.argv.slice(2).join(" "));');
  const nodeDir = NODE_DIR;
  stub(s.stubs, 'npx', marker('npx'));
  const run = (env) => spawnSync('sh', [bin, 'ui', 'status'], { encoding: 'utf8', env: { HOME: s.home, PATH: `${join(pluginRoot, 'bin')}:${s.stubs}:${SYSTEM_PATH}:${nodeDir}`, ...env } });
  // 3: data dir
  assert.equal(run({ CLAUDE_PLUGIN_DATA: s.data }).stdout.trim(), 'data-entry:ui status');
  // 2: env entry beats the data dir
  assert.equal(run({ CLAUDE_PLUGIN_DATA: s.data, BLOCKBASE_CLI_ENTRY: entry }).stdout.trim(), 'env-entry:ui status');
  // 1: external blockbase beats everything
  stub(s.stubs, 'blockbase', marker('external'));
  assert.equal(run({ CLAUDE_PLUGIN_DATA: s.data, BLOCKBASE_CLI_ENTRY: entry }).stdout.trim(), 'external:ui status');
  // 4: npx last
  const bare = sandbox();
  stub(bare.stubs, 'npx', marker('npx'));
  const last = spawnSync('sh', [bin, 'ui', 'status'], { encoding: 'utf8', env: { HOME: bare.home, PATH: `${join(pluginRoot, 'bin')}:${bare.stubs}:${SYSTEM_PATH}:${nodeDir}` } });
  assert.equal(last.stdout.trim(), `npx:--yes @blockbase/cli@${version} ui status`);
});

test('versions agree: plugin.json, cli package, marketplace, all five packages', () => {
  const repo = join(integrationRoot, '../..');
  const read = (path) => JSON.parse(readFileSync(join(repo, path), 'utf8'));
  const marketplace = read('.claude-plugin/marketplace.json');
  assert.equal(marketplace.metadata.version, version);
  for (const pkg of ['packages/contracts', 'packages/core', 'packages/mcp', 'packages/cli', 'apps/preview']) assert.equal(read(`${pkg}/package.json`).version, version, pkg);
});

test('hook env file line survives a data path with spaces and quotes', () => {
  const s = sandbox();
  fakeNpm(s);
  const data = join(s.dir, "plugin data/it's $HOME");
  const result = runHook(s, { CLAUDE_PLUGIN_DATA: data });
  assert.equal(result.status, 0);
  const echoed = spawnSync('sh', ['-c', `. "${s.env}" && printf %s "$BLOCKBASE_CLI_ENTRY"`], { encoding: 'utf8' });
  assert.equal(echoed.stdout, join(data, 'cli/node_modules/@blockbase/cli/dist/index.js'));
});

test('two hooks starting together run npm once', async () => {
  const s = sandbox();
  // Slow fake npm so the second hook arrives while the first holds the lock.
  stub(s.stubs, 'npm', `echo "$@" >> "${s.dir}/npm.log"; sleep 2
prefix=""; while [ $# -gt 0 ]; do [ "$1" = --prefix ] && prefix=$2; shift; done
mkdir -p "$prefix/node_modules/@blockbase/cli/dist" && echo "" > "$prefix/node_modules/@blockbase/cli/dist/index.js"`);
  const env = { PATH: `${s.stubs}:${SYSTEM_PATH}:${NODE_DIR}`, HOME: s.home, CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PLUGIN_DATA: s.data, CLAUDE_ENV_FILE: s.env };
  const start = () => new Promise((done) => {
    const child = spawn('sh', [hook], { env });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('exit', (code) => done({ code, out }));
  });
  const [a, b] = await Promise.all([start(), start()]);
  assert.equal(a.code, 0);
  assert.equal(b.code, 0);
  assert.equal(npmCalls(s).length, 1);
  assert.doesNotMatch(a.out + b.out, /could not install/);
  assert.equal(existsSync(join(s.data, 'cli/.install-lock')), false);
});

test('hook reclaims a lock left by a dead installer', () => {
  const s = sandbox();
  fakeNpm(s);
  mkdirSync(join(s.data, 'cli/.install-lock'), { recursive: true });
  writeFileSync(join(s.data, 'cli/.install-lock/pid'), '999999\n');
  const result = runHook(s);
  assert.equal(result.status, 0);
  assert.equal(npmCalls(s).length, 1);
});

test('bin/blockbase does not loop when another blockbase on PATH links back to it', () => {
  const s = sandbox();
  const linkDir = join(s.dir, 'linkbin');
  mkdirSync(linkDir);
  spawnSync('ln', ['-s', bin, join(linkDir, 'blockbase')]);
  stub(s.stubs, 'npx', 'echo "npx:$*"');
  const nodeDir = NODE_DIR;
  const result = spawnSync(join(linkDir, 'blockbase'), ['doctor'], { encoding: 'utf8', timeout: 10000, env: { HOME: s.home, PATH: `${linkDir}:${join(pluginRoot, 'bin')}:${s.stubs}:${SYSTEM_PATH}:${nodeDir}` } });
  assert.equal(result.error, undefined);
  assert.equal(result.stdout.trim(), `npx:--yes @blockbase/cli@${version} doctor`);
});
