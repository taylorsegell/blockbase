import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import test from 'node:test';
import { stableNodePath } from '../dist/service/nodePath.js';

const expectedNode = stableNodePath(process.execPath);
const executable = resolve(import.meta.dirname, '../dist/index.js');
const darwin = process.platform === 'darwin';
const linux = process.platform === 'linux';
const supported = darwin || linux;
// File permissions do not stop root, so the unwritable-inventory tests cannot run as root.
const runningAsRoot = process.getuid?.() === 0;

async function harness() {
  const base = await mkdtemp(join(tmpdir(), 'blockbase-service-'));
  const home = join(base, 'home');
  const root = join(base, 'catalog');
  const log = join(base, 'runner.log');
  const runner = join(base, 'runner.sh');
  await mkdir(home, { recursive: true });
  // The mock tracks a loaded job in `loaded`: bootstrap sets it, bootout clears it, print reads it and
  // exits 113 (launchctl's "not found") when the job is not loaded.
  //   MOCK_PRINT_EXIT=N       print and is-active exit N
  //   MOCK_BOOTSTRAP_FAILS=N  the first N bootstrap calls fail
  //   MOCK_LINGER=N           after bootout the job stays visible to N `print` calls, and bootstrap
  //                           fails while it lingers (macOS refuses to bootstrap a job still tearing down)
  //   MOCK_FAIL_ENABLE / MOCK_FAIL_RESTART  make systemctl enable / restart fail
  //   MOCK_PRINT_HANG / MOCK_HANG  `print` / every call never answers (the caller's timeout must kill it)
  const loaded = join(base, 'loaded');
  const failed = join(base, 'bootstrap-failures');
  const lingering = join(base, 'lingering');
  await writeFile(runner, `#!/bin/sh
echo "$@" >> "${log}"
if [ -n "\${MOCK_HANG:-}" ]; then exec sleep 30; fi
case "$1" in
  bootout)
    if [ -n "\${MOCK_LINGER:-}" ] && [ -f "${loaded}" ]; then echo "\$MOCK_LINGER" > "${lingering}"; else rm -f "${loaded}"; fi
    exit "\${MOCK_BOOTOUT_EXIT:-0}";;
  print)
    if [ -n "\${MOCK_PRINT_HANG:-}" ]; then exec sleep 30; fi
    if [ -n "\${MOCK_PRINT_EXIT:-}" ]; then exit "\$MOCK_PRINT_EXIT"; fi
    if [ -f "${lingering}" ]; then
      n=$(cat "${lingering}")
      if [ "$n" -gt 0 ]; then echo $((n - 1)) > "${lingering}"; exit 0; fi
      rm -f "${lingering}" "${loaded}"; exit 113
    fi
    [ -f "${loaded}" ] && exit 0
    exit 113;;
  bootstrap)
    if [ -f "${lingering}" ]; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi
    n=$(cat "${failed}" 2>/dev/null || echo 0)
    if [ "$n" -lt "\${MOCK_BOOTSTRAP_FAILS:-0}" ]; then echo $((n + 1)) > "${failed}"; echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi
    touch "${loaded}"; exit 0;;
esac
[ "$2" = enable ] && [ -n "\${MOCK_FAIL_ENABLE:-}" ] && exit 1
[ "$2" = restart ] && [ -n "\${MOCK_FAIL_RESTART:-}" ] && exit 1
[ "$2" = is-active ] && exit "\${MOCK_PRINT_EXIT:-0}"
exit 0
`);
  await chmod(runner, 0o755);
  const env = { HOME: home, BLOCKBASE_SERVICE_RUNNER: runner, BLOCKBASE_HOME: root, BLOCKBASE_SERVICE_WAIT_MS: '1' };
  const invoke = (args, extra = {}) => {
    const result = spawnSync(process.execPath, [executable, ...args], { encoding: 'utf8', env: { ...process.env, ...env, ...extra } });
    let json = null;
    try {
      json = result.stdout.trim() ? JSON.parse(result.stdout) : null;
    } catch {
      // Plain (non --json) output is not JSON.
    }
    return { ...result, json };
  };
  const calls = async () => (existsSync(log) ? (await readFile(log, 'utf8')).split('\n').filter(Boolean) : []);
  const target = darwin ? join(home, 'Library/LaunchAgents/com.blockbase.ui.plist') : join(home, '.config/systemd/user/blockbase-ui.service');
  const inventoryPath = join(root, '.blockbase-service.json');
  // Simulates an older install: rewrites the definition and re-records its hash so it still counts as owned.
  const rewriteDefinition = async (transform) => {
    const rewritten = transform(await readFile(target, 'utf8'));
    await writeFile(target, rewritten);
    const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
    inventory.sha256 = createHash('sha256').update(rewritten).digest('hex');
    await writeFile(inventoryPath, JSON.stringify(inventory));
    return rewritten;
  };
  return { base, home, root, invoke, calls, target, loaded, inventoryPath, rewriteDefinition };
}

test('service install writes the owned definition and loads it bootout-then-bootstrap, waiting for teardown', { skip: !supported }, async () => {
  const h = await harness();
  const result = h.invoke(['ui', 'service', 'install', '--port', '48000', '--allowed-host', 'box.local', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.operation, 'ui.service.install');
  assert.equal(result.json.data.state, 'installed');
  const content = await readFile(h.target, 'utf8');
  assert.ok(content.includes(expectedNode));
  assert.ok(content.includes(resolve(import.meta.dirname, '../dist/index.js')));
  assert.ok(content.includes('48000'));
  assert.ok(content.includes(h.root));
  assert.ok(content.includes('box.local'));
  const inventory = JSON.parse(await readFile(join(h.root, '.blockbase-service.json'), 'utf8'));
  assert.equal(inventory.schemaVersion, '1');
  assert.equal(inventory.path, h.target);
  assert.equal(inventory.port, 48000);
  assert.match(inventory.sha256, /^[0-9a-f]{64}$/);
  const calls = await h.calls();
  if (darwin) {
    assert.match(content, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(content, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.ok(content.includes(join(h.home, 'Library/Logs/blockbase-ui.log')));
    assert.ok(content.includes(`${expectedNode.slice(0, expectedNode.lastIndexOf('/'))}:/usr/bin:/bin`));
    const uid = process.getuid();
    // bootout, then one print that finds the job gone, then bootstrap.
    assert.deepEqual(calls, [`bootout gui/${uid}/com.blockbase.ui`, `print gui/${uid}/com.blockbase.ui`, `bootstrap gui/${uid} ${h.target}`]);
  } else {
    assert.deepEqual(calls, ['--user daemon-reload', '--user enable --now blockbase-ui']);
  }
});

test('service install tolerates a bootout "not found" and is a no-op when content is identical', { skip: !supported }, async () => {
  const h = await harness();
  const args = ['ui', 'service', 'install', '--port', '48001', '--json'];
  const first = h.invoke(args, { MOCK_BOOTOUT_EXIT: '3' });
  assert.equal(first.status, 0, first.stderr);
  const before = await readFile(h.target, 'utf8');
  const second = h.invoke(args);
  assert.equal(second.status, 0);
  assert.equal(second.json.data.state, 'present');
  assert.equal(await readFile(h.target, 'utf8'), before);
  const refreshed = h.invoke(['ui', 'service', 'install', '--port', '48002', '--json']);
  assert.equal(refreshed.json.data.state, 'refreshed');
  assert.ok((await readFile(h.target, 'utf8')).includes('48002'));
});

test('service install refuses a definition it does not own', { skip: !supported }, async () => {
  const h = await harness();
  await mkdir(join(h.target, '..'), { recursive: true });
  await writeFile(h.target, 'user content\n');
  const result = h.invoke(['ui', 'service', 'install', '--json']);
  assert.equal(result.status, 5);
  assert.equal(result.json.error.code, 'SERVICE_CONFLICT');
  assert.equal(await readFile(h.target, 'utf8'), 'user content\n');
  assert.deepEqual(await h.calls(), []);
});

test('service install refuses an owned definition that was edited', { skip: !supported }, async () => {
  const h = await harness();
  assert.equal(h.invoke(['ui', 'service', 'install', '--json']).status, 0);
  await writeFile(h.target, 'edited by hand\n');
  const result = h.invoke(['ui', 'service', 'install', '--json']);
  assert.equal(result.status, 5);
  assert.equal(await readFile(h.target, 'utf8'), 'edited by hand\n');
});

test('service uninstall removes only the owned path and the inventory', { skip: !supported }, async () => {
  const h = await harness();
  const neighbor = join(h.target, '..', 'unrelated.txt');
  assert.equal(h.invoke(['ui', 'service', 'install', '--json']).status, 0);
  await writeFile(neighbor, 'keep\n');
  const result = h.invoke(['ui', 'service', 'uninstall', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.data.removed, true);
  assert.equal(existsSync(h.target), false);
  assert.equal(existsSync(join(h.root, '.blockbase-service.json')), false);
  assert.equal(await readFile(neighbor, 'utf8'), 'keep\n');
  const again = h.invoke(['ui', 'service', 'uninstall', '--json']);
  assert.equal(again.status, 0);
  assert.equal(again.json.data.removed, false);
});

test('service uninstall leaves an unowned definition alone', { skip: !supported }, async () => {
  const h = await harness();
  await mkdir(join(h.target, '..'), { recursive: true });
  await writeFile(h.target, 'user content\n');
  const result = h.invoke(['ui', 'service', 'uninstall', '--json']);
  assert.equal(result.status, 0);
  assert.equal(result.json.data.removed, false);
  assert.equal(await readFile(h.target, 'utf8'), 'user content\n');
});

test('service status reports load state and warns when the recorded node is gone', { skip: !supported }, async () => {
  const h = await harness();
  const absent = h.invoke(['ui', 'service', 'status', '--json']);
  assert.equal(absent.status, 0);
  assert.equal(absent.json.data.installed, false);
  assert.equal(absent.json.data.loaded, false);

  assert.equal(h.invoke(['ui', 'service', 'install', '--port', '48003', '--json']).status, 0);
  const healthy = h.invoke(['ui', 'service', 'status', '--json']);
  assert.equal(healthy.json.data.installed, true);
  assert.equal(healthy.json.data.loaded, true);
  assert.equal(healthy.json.data.port, 48003);
  assert.equal(healthy.json.data.nodePath, expectedNode);
  assert.equal(healthy.json.data.nodePathExists, true);
  assert.deepEqual(healthy.json.warnings, []);

  const unloaded = h.invoke(['ui', 'service', 'status', '--json'], { MOCK_PRINT_EXIT: '113' });
  assert.equal(unloaded.json.data.loaded, false);

  // Simulate an nvm upgrade: rewrite the definition to a vanished node and re-record its hash.
  await h.rewriteDefinition((text) => text.replaceAll(expectedNode, '/nonexistent/node/bin/node'));
  const moved = h.invoke(['ui', 'service', 'status', '--json']);
  assert.equal(moved.json.data.nodePath, '/nonexistent/node/bin/node');
  assert.equal(moved.json.data.nodePathExists, false);
  assert.ok(moved.json.warnings.some((warning) => warning.code === 'SERVICE_NODE_MISSING'));
});

test('service install is unsupported off macOS and Linux', { skip: supported }, async () => {
  const h = await harness();
  const result = h.invoke(['ui', 'service', 'install', '--json']);
  assert.equal(result.status, 6);
  assert.equal(result.json.error.code, 'SERVICE_UNSUPPORTED');
});

test('setup installs the service through the runner and reports an unhealthy start', { skip: !supported }, async () => {
  const h = await harness();
  const result = h.invoke(['setup', '--port', '48004', '--json'], { BLOCKBASE_SETUP_HEALTH_TIMEOUT_MS: '300' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.data.catalog, 'created');
  assert.equal(result.json.data.service, 'failed');
  assert.equal(result.json.data.issues[0].code, 'service-not-healthy');
  assert.ok(existsSync(h.target));
  assert.ok((await h.calls()).length >= 2);
});

test('a refresh without flags keeps the port and allowed hosts chosen at install', { skip: !supported }, async () => {
  const h = await harness();
  assert.equal(h.invoke(['ui', 'service', 'install', '--port', '48005', '--allowed-host', 'blocks.local', '--json']).status, 0);
  const installed = await readFile(h.target, 'utf8');
  // `agent update` runs setup with no service flags; it must not rewrite the definition.
  const setup = h.invoke(['setup', '--json'], { BLOCKBASE_SETUP_HEALTH_TIMEOUT_MS: '200' });
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(setup.json.data.url, 'http://127.0.0.1:48005/#home');
  assert.equal(await readFile(h.target, 'utf8'), installed);
  const again = h.invoke(['ui', 'service', 'install', '--json']);
  assert.equal(again.json.data.state, 'present');
  assert.equal(again.json.data.port, 48005);
  const inventory = JSON.parse(await readFile(join(h.root, '.blockbase-service.json'), 'utf8'));
  assert.deepEqual(inventory.allowedHosts, ['blocks.local']);
});

test('a bootstrap that fails twice is retried on a fresh install', { skip: !darwin }, async () => {
  const h = await harness();
  const result = h.invoke(['ui', 'service', 'install', '--json'], { MOCK_BOOTSTRAP_FAILS: '2' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.data.state, 'installed');
  assert.equal((await h.calls()).filter((call) => call.startsWith('bootstrap ')).length, 3);
});

test('a bootstrap that fails twice is retried on a refresh', { skip: !darwin }, async () => {
  const h = await harness();
  assert.equal(h.invoke(['ui', 'service', 'install', '--port', '48020', '--json']).status, 0);
  const before = (await h.calls()).length;
  const result = h.invoke(['ui', 'service', 'install', '--port', '48021', '--json'], { MOCK_BOOTSTRAP_FAILS: '2' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.data.state, 'refreshed');
  assert.equal((await h.calls()).slice(before).filter((call) => call.startsWith('bootstrap ')).length, 3);
  assert.ok((await readFile(h.target, 'utf8')).includes('48021'));
});

test('a refresh bootstraps only after print stops finding the lingering job', { skip: !darwin }, async () => {
  const h = await harness();
  assert.equal(h.invoke(['ui', 'service', 'install', '--port', '48022', '--json']).status, 0);
  const before = (await h.calls()).length;
  // The job stays visible to three `print` calls after bootout; a bootstrap that came earlier would fail.
  const result = h.invoke(['ui', 'service', 'install', '--port', '48023', '--json'], { MOCK_LINGER: '3' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.data.state, 'refreshed');
  const calls = (await h.calls()).slice(before);
  const uid = process.getuid();
  const print = `print gui/${uid}/com.blockbase.ui`;
  assert.deepEqual(calls, [`bootout gui/${uid}/com.blockbase.ui`, print, print, print, print, `bootstrap gui/${uid} ${h.target}`]);
});

test('teardown polling ends only on the not-found exit code', { skip: !darwin }, async () => {
  const h = await harness();
  // Exit 1 is not "not found", so every poll is spent before bootstrap goes ahead.
  const result = h.invoke(['ui', 'service', 'install', '--json'], { MOCK_PRINT_EXIT: '1' });
  assert.equal(result.status, 0, result.stderr);
  const calls = await h.calls();
  assert.ok(calls.filter((call) => call.startsWith('print ')).length >= 5, calls.join('\n'));
  assert.equal(calls.filter((call) => call.startsWith('bootstrap ')).length, 1);
});

test('an install recording an older Cellar node path refreshes cleanly', { skip: !supported }, async () => {
  const h = await harness();
  assert.equal(h.invoke(['ui', 'service', 'install', '--port', '48024', '--json']).status, 0);
  const cellar = '/opt/homebrew/Cellar/node/25.0.0/bin/node';
  const old = await h.rewriteDefinition((text) => text.replaceAll(expectedNode, cellar));
  assert.ok(old.includes(cellar));
  const result = h.invoke(['ui', 'service', 'install', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.data.state, 'refreshed');
  const content = await readFile(h.target, 'utf8');
  assert.ok(content.includes(expectedNode));
  assert.ok(!content.includes(cellar));
  assert.equal(h.invoke(['ui', 'service', 'status', '--json']).json.data.loaded, true);
});

// Darwin: every bootstrap fails, so the restore fails as well. Linux: enable and restart fail and the
// unit reports inactive.
const everythingFails = darwin ? { MOCK_BOOTSTRAP_FAILS: '99' } : { MOCK_FAIL_ENABLE: '1', MOCK_FAIL_RESTART: '1', MOCK_PRINT_EXIT: '3' };

test('a refresh that cannot reload anything restores the files but says the service is stopped', { skip: !supported }, async () => {
  const h = await harness();
  assert.equal(h.invoke(['ui', 'service', 'install', '--port', '48006', '--json']).status, 0);
  const definitionBefore = await readFile(h.target);
  const inventoryBefore = await readFile(h.inventoryPath);
  const result = h.invoke(['ui', 'service', 'install', '--port', '48007', '--json'], everythingFails);
  assert.notEqual(result.status, 0);
  assert.equal(result.json.error.code, 'SERVICE_COMMAND_FAILED');
  assert.equal(result.json.error.details.restored, true);
  assert.equal(result.json.error.details.running, false);
  assert.match(result.json.error.message, /service is stopped/);
  assert.ok(result.json.recoveryActions.some((action) => action.command?.startsWith('blockbase ui service install')), JSON.stringify(result.json.recoveryActions));
  assert.deepEqual(await readFile(h.target), definitionBefore);
  assert.deepEqual(await readFile(h.inventoryPath), inventoryBefore);
  if (darwin) assert.equal(h.invoke(['ui', 'service', 'status', '--json']).json.data.loaded, false);
});

test('a refresh whose new definition fails but whose restore succeeds keeps the service running', { skip: !supported }, async () => {
  const h = await harness();
  assert.equal(h.invoke(['ui', 'service', 'install', '--port', '48008', '--json']).status, 0);
  const definitionBefore = await readFile(h.target);
  const inventoryBefore = await readFile(h.inventoryPath);
  // Darwin: the four bootstrap attempts for the new definition fail, the restore's first bootstrap works.
  // Linux: the first enable fails; the restore only reloads and restarts.
  const result = h.invoke(['ui', 'service', 'install', '--port', '48009', '--json'], darwin ? { MOCK_BOOTSTRAP_FAILS: '4' } : { MOCK_FAIL_ENABLE: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(result.json.error.code, 'SERVICE_COMMAND_FAILED');
  assert.equal(result.json.error.details.restored, true);
  assert.equal(result.json.error.details.running, true);
  assert.doesNotMatch(result.json.error.message, /service is stopped/);
  assert.deepEqual(result.json.recoveryActions, []);
  assert.deepEqual(await readFile(h.target), definitionBefore);
  assert.deepEqual(await readFile(h.inventoryPath), inventoryBefore);
  assert.equal(h.invoke(['ui', 'service', 'status', '--json']).json.data.loaded, true);
  if (darwin) assert.ok(existsSync(h.loaded));
});

test('a failed inventory write on a refresh restores the previous files and a retry works', { skip: !supported || runningAsRoot }, async () => {
  const h = await harness();
  assert.equal(h.invoke(['ui', 'service', 'install', '--port', '48010', '--json']).status, 0);
  const definitionBefore = await readFile(h.target);
  const inventoryBefore = await readFile(h.inventoryPath);
  await chmod(h.inventoryPath, 0o444);
  const failed = h.invoke(['ui', 'service', 'install', '--port', '48011', '--json']);
  assert.notEqual(failed.status, 0);
  assert.equal(failed.json.error.code, 'SERVICE_WRITE_FAILED');
  assert.equal(failed.json.error.details.restored, true);
  assert.equal(failed.json.error.details.running, true);
  assert.deepEqual(await readFile(h.target), definitionBefore);
  assert.deepEqual(await readFile(h.inventoryPath), inventoryBefore);
  await chmod(h.inventoryPath, 0o644);
  const retry = h.invoke(['ui', 'service', 'install', '--port', '48011', '--json']);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(retry.json.data.state, 'refreshed');
  const uninstall = h.invoke(['ui', 'service', 'uninstall', '--json']);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.equal(uninstall.json.data.removed, true);
  assert.equal(existsSync(h.target), false);
});

test('a failed inventory write on a fresh install leaves no definition behind and a retry works', { skip: !supported || runningAsRoot }, async () => {
  const h = await harness();
  await mkdir(h.root, { recursive: true });
  await chmod(h.root, 0o555);
  try {
    const failed = h.invoke(['ui', 'service', 'install', '--port', '48012', '--json']);
    assert.notEqual(failed.status, 0);
    assert.equal(failed.json.error.code, 'SERVICE_WRITE_FAILED');
    assert.equal(existsSync(h.target), false);
    assert.equal(existsSync(h.inventoryPath), false);
  } finally {
    await chmod(h.root, 0o755);
  }
  const retry = h.invoke(['ui', 'service', 'install', '--port', '48012', '--json']);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(retry.json.data.state, 'installed');
  const uninstall = h.invoke(['ui', 'service', 'uninstall', '--json']);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.equal(uninstall.json.data.removed, true);
  assert.equal(existsSync(h.target), false);
});

test('setup reports a failed refresh with the repair command and the port that is still recorded', { skip: !supported }, async () => {
  const h = await harness();
  assert.equal(h.invoke(['ui', 'service', 'install', '--port', '48013', '--json']).status, 0);
  const result = h.invoke(['setup', '--port', '48014', '--json'], { ...everythingFails, BLOCKBASE_SETUP_HEALTH_TIMEOUT_MS: '200' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.data.service, 'failed');
  assert.equal(result.json.data.url, 'http://127.0.0.1:48013/#home');
  const issue = result.json.data.issues.find((entry) => entry.code === 'service-command-failed');
  assert.ok(issue, JSON.stringify(result.json.data.issues));
  assert.match(issue.message, /service is stopped/);
  assert.equal(issue.repair, 'blockbase ui service install --json');
  assert.ok((await readFile(h.target, 'utf8')).includes('48013'));
});

// A port nothing listens on, so setup's health probe can never reach a real local service.
async function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

// Installs the service on a free port, runs `agent install`, then makes the next refresh necessary.
async function stalledUpdate(h) {
  const project = join(h.base, 'project');
  await mkdir(project, { recursive: true });
  const port = await freePort();
  assert.equal(h.invoke(['ui', 'service', 'install', '--port', String(port), '--json']).status, 0);
  // CI is cleared because agent install skips setup under CI.
  const env = { CI: '', BLOCKBASE_SETUP_HEALTH_TIMEOUT_MS: '200' };
  const args = ['--provider', 'codex', '--scope', 'project', '--project', project];
  const installed = h.invoke(['agent', 'install', ...args, '--json'], env);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(installed.json.data.setup.ran, true);
  await h.rewriteDefinition((text) => text.replaceAll(expectedNode, '/opt/homebrew/Cellar/node/25.0.0/bin/node'));
  return { args, env };
}

test('agent update carries the service issue from a failed refresh', { skip: !supported }, async () => {
  const h = await harness();
  const { args, env } = await stalledUpdate(h);
  const updated = h.invoke(['agent', 'update', ...args, '--json'], { ...env, ...everythingFails });
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(updated.json.data.setup.service, 'failed');
  const issue = updated.json.data.issues.find((entry) => entry.code === 'service-command-failed');
  assert.ok(issue, JSON.stringify(updated.json.data));
  assert.equal(issue.repair, 'blockbase ui service install --json');
});

test('plain agent update says on stderr that the service is stopped', { skip: !supported }, async () => {
  const h = await harness();
  const { args, env } = await stalledUpdate(h);
  const updated = h.invoke(['agent', 'update', ...args], { ...env, ...everythingFails });
  assert.equal(updated.status, 0, updated.stderr);
  assert.match(updated.stdout, /^Agent update: ok/);
  assert.match(updated.stderr, /Issue \[service-command-failed\].*service is stopped.*Run: blockbase ui service install --json/);
  const installed = h.invoke(['agent', 'install', ...args], { ...env, ...everythingFails });
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stderr, /Issue \[service-command-failed\]/);
});

test('a job that keeps lingering through both budgets is reported as stopped, not running', { skip: !darwin }, async () => {
  const h = await harness();
  assert.equal(h.invoke(['ui', 'service', 'install', '--port', '48030', '--json']).status, 0);
  const definitionBefore = await readFile(h.target);
  const before = (await h.calls()).length;
  // `print` keeps finding the tearing-down job, in the new-definition phase and in the restore.
  const result = h.invoke(['ui', 'service', 'install', '--port', '48031', '--json'], { MOCK_LINGER: '1000' });
  assert.notEqual(result.status, 0);
  assert.equal(result.json.error.details.restored, true);
  assert.equal(result.json.error.details.running, false);
  assert.match(result.json.error.message, /service is stopped/);
  assert.ok(result.json.recoveryActions.some((action) => action.command?.startsWith('blockbase ui service install')), JSON.stringify(result.json.recoveryActions));
  assert.deepEqual(await readFile(h.target), definitionBefore);
  const bootstraps = (await h.calls()).slice(before).filter((call) => call.startsWith('bootstrap '));
  assert.equal(bootstraps.length, 6, 'four attempts for the new definition and two for the restore');
});

test('a teardown that takes twenty polls still ends in a single bootstrap', { skip: !darwin }, async () => {
  const h = await harness();
  assert.equal(h.invoke(['ui', 'service', 'install', '--port', '48032', '--json']).status, 0);
  const before = (await h.calls()).length;
  const result = h.invoke(['ui', 'service', 'install', '--port', '48033', '--json'], { MOCK_LINGER: '20' });
  assert.equal(result.status, 0, result.stderr);
  const calls = (await h.calls()).slice(before);
  assert.equal(calls.filter((call) => call.startsWith('print ')).length, 21);
  assert.equal(calls.filter((call) => call.startsWith('bootstrap ')).length, 1);
});

// Hung-runner tests shrink every time budget to a quarter, so the documented 10 seconds becomes 2.5.
const hungEnv = { BLOCKBASE_SERVICE_BUDGET_SCALE: '0.25' };

test('when print hangs, each phase still runs a bootstrap attempt', { skip: !darwin }, async () => {
  const h = await harness();
  assert.equal(h.invoke(['ui', 'service', 'install', '--port', '48034', '--json']).status, 0);
  const before = (await h.calls()).length;
  const result = h.invoke(['ui', 'service', 'install', '--port', '48035', '--json'], { ...hungEnv, MOCK_PRINT_HANG: '1', MOCK_BOOTSTRAP_FAILS: '99' });
  assert.notEqual(result.status, 0);
  assert.equal(result.json.error.details.running, false);
  // Calls split at each bootout: the new-definition phase, then the restore.
  const phases = [];
  for (const call of (await h.calls()).slice(before)) {
    if (call.startsWith('bootout ')) phases.push([]);
    else phases.at(-1)?.push(call.split(' ')[0]);
  }
  assert.equal(phases.length, 2, JSON.stringify(phases));
  for (const phase of phases) assert.ok(phase.includes('bootstrap'), JSON.stringify(phases));
});

test('a failed refresh against a runner that never answers finishes within the documented bound', { skip: !darwin }, async () => {
  const h = await harness();
  assert.equal(h.invoke(['ui', 'service', 'install', '--port', '48036', '--json']).status, 0);
  const start = Date.now();
  const result = h.invoke(['ui', 'service', 'install', '--port', '48037', '--json'], { ...hungEnv, MOCK_HANG: '1' });
  const elapsed = Date.now() - start;
  assert.notEqual(result.status, 0);
  assert.equal(result.json.error.details.running, false);
  // Deadlines add up to 10 s at full scale (2.5 s here); the rest is Node start-up and the file work.
  assert.ok(elapsed < 2500 + 2500, `took ${elapsed} ms`);
});
