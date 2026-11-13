import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, lstat, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const packageRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(packageRoot, '../..');
const executable = resolve(packageRoot, 'dist/index.js');
const integrationRoot = resolve(repositoryRoot, 'integrations/agent');

function invoke(args, env) {
  const result = spawnSync(process.execPath, [executable, ...args], { encoding: 'utf8', ...(env ? { env } : {}) });
  return { ...result, json: result.stdout.trim() ? JSON.parse(result.stdout) : null };
}

test('agent command metadata exactly mirrors the CLI operation registry', async () => {
  const metadata = JSON.parse(await readFile(join(integrationRoot, 'command-metadata.json'), 'utf8'));
  const { OPERATION_REGISTRY } = await import('../dist/registry.js');
  assert.deepEqual(
    Object.entries(metadata).map(([command, entry]) => {
      const { operation, description, json } = entry;
      return { command, operation, description, json };
    }),
    OPERATION_REGISTRY.map(({ operation, command, description, json }) => ({ command, operation, description, json })),
  );
});

test('agent links are repairable, idempotent, and isolated to the requested home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'blockbase-agent-home-'));
  const checkBefore = invoke(['agent', 'check', '--home', home, '--json']);
  assert.equal(checkBefore.status, 7);
  assert.equal(checkBefore.json.ok, false);
  assert.ok(checkBefore.json.recoveryActions.length <= 3);

  const firstLink = invoke(['agent', 'link', '--home', home, '--json']);
  assert.equal(firstLink.status, 0);
  assert.equal(firstLink.json.data.links.length, 7);
  assert.ok(firstLink.json.data.links.every((link) => ['created', 'reused'].includes(link.action)));

  const secondLink = invoke(['agent', 'link', '--home', home, '--json']);
  assert.equal(secondLink.status, 0);
  assert.ok(secondLink.json.data.links.every((link) => link.action === 'reused'));

  const staleSkill = join(home, 'skills', 'blockbase-capture');
  await unlink(staleSkill);
  const staleTarget = await mkdtemp(join(tmpdir(), 'blockbase-stale-target-'));
  await symlink(staleTarget, staleSkill, 'junction');
  const checkStale = invoke(['agent', 'check', '--home', home, '--json']);
  assert.equal(checkStale.status, 7);
  assert.equal(checkStale.json.error.code, 'AGENT_LINKS_UNHEALTHY');
  assert.ok(checkStale.json.error.details.repairActions.length <= 3);

  const repair = invoke(['agent', 'link', '--home', home, '--json']);
  assert.equal(repair.status, 0);
  assert.equal(repair.json.data.links.find((link) => link.name === 'blockbase-capture' && link.path.endsWith('/blockbase-capture')).action, 'repaired');
  assert.equal(invoke(['agent', 'check', '--home', home, '--json']).status, 0);

  const unlinkResult = invoke(['agent', 'unlink', '--home', home, '--json']);
  assert.equal(unlinkResult.status, 0);
  assert.equal(invoke(['agent', 'unlink', '--home', home, '--json']).status, 0);
  assert.equal(invoke(['agent', 'check', '--home', home, '--json']).status, 7);
  assert.equal((await lstat(join(home, 'skills'))).isDirectory(), true);
});

test('canonical plugin sources do not contain machine-specific absolute paths', async () => {
  const files = [
    'SKILL.md',
    'agents/openai.yaml',
    'providers/codex.yaml',
    'providers/claude-code.yaml',
    'providers/cursor.yaml',
    'skills/blockbase-capture/SKILL.md',
    'skills/blockbase-inbox/SKILL.md',
    'skills/blockbase-find-and-fit/SKILL.md',
    'skills/blockbase-organize/SKILL.md',
    'skills/blockbase-audit/SKILL.md',
    'plugin.json',
  ];
  for (const relative of files) {
    const source = await readFile(join(integrationRoot, relative), 'utf8');
    assert.doesNotMatch(source, /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)/);
  }
});

test('provider lifecycle is isolated, idempotent, repairable, and no-clobber across all targets', async () => {
  for (const provider of ['claude-code', 'codex', 'cursor']) {
    const home = await mkdtemp(join(tmpdir(), `blockbase-${provider}-global-`));
    const args = ['--provider', provider, '--scope', 'global', '--home', home, '--json'];
    const installed = invoke(['agent', 'install', ...args]);
    assert.equal(installed.status, 0, `${provider} install failed`);
    assert.equal(installed.json.data.schemaVersion, '1');
    assert.equal(invoke(['agent', 'install', ...args]).status, 0);
    assert.equal(invoke(['agent', 'check', ...args]).status, 0);

    const customSkill = join(home, 'skills', 'user-owned', 'SKILL.md');
    await mkdir(join(home, 'skills', 'user-owned'), { recursive: true });
    await writeFile(customSkill, 'user content\n');
    const generatedPayload = join(home, 'command-metadata.json');
    await writeFile(generatedPayload, 'stale\n');
    const stale = invoke(['agent', 'check', ...args]);
    assert.equal(stale.status, 7);
    assert.ok(stale.json.error.details.issues.includes('stale-generated-payload'));
    assert.ok(stale.json.error.details.repairActions.length <= 3);
    const repaired = invoke(['agent', 'update', ...args]);
    assert.equal(repaired.status, 0);
    assert.equal(repaired.json.operation, 'agent.update');
    assert.equal((await readFile(customSkill, 'utf8')), 'user content\n');
    assert.equal(invoke(['agent', 'check', ...args]).status, 0);
    assert.equal(invoke(['agent', 'remove', ...args]).status, 0);
    assert.equal((await readFile(customSkill, 'utf8')), 'user content\n');
    assert.equal(invoke(['agent', 'remove', ...args]).status, 0);
  }
});

test('project scope and local links are supported for every provider', async () => {
  for (const provider of ['claude-code', 'codex', 'cursor']) {
    const project = await mkdtemp(join(tmpdir(), `blockbase-${provider}-project-`));
    const args = ['--provider', provider, '--scope', 'project', '--project', project, '--json'];
    const installed = invoke(['agent', 'install', ...args, '--no-setup']);
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    assert.equal(invoke(['agent', 'check', ...args]).status, 0);
    assert.equal(invoke(['agent', 'remove', ...args]).status, 0);
    assert.equal(invoke(['agent', 'link', ...args]).status, 0);
    const linked = invoke(['agent', 'check', ...args]);
    assert.equal(linked.status, 0);
    const providerDirectory = provider === 'claude-code' ? '.claude' : `.${provider}`;
    const broken = join(project, providerDirectory, 'skills', 'blockbase-capture');
    await unlink(broken);
    const unhealthy = invoke(['agent', 'check', ...args]);
    assert.equal(unhealthy.status, 7);
    assert.ok(unhealthy.json.error.details.issues.includes('broken-link'));
    assert.equal(invoke(['agent', 'update', ...args, '--no-setup']).status, 0);
    assert.equal(invoke(['agent', 'remove', ...args]).status, 0);
  }
});

test('provider install refuses an unowned payload file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'blockbase-provider-conflict-'));
  const path = join(home, 'skills', 'blockbase', 'SKILL.md');
  await mkdir(join(home, 'skills', 'blockbase'), { recursive: true });
  await writeFile(path, 'keep me\n');
  const result = invoke(['agent', 'install', '--provider', 'codex', '--scope', 'global', '--home', home, '--json']);
  assert.equal(result.status, 5);
  assert.equal(result.json.error.code, 'AGENT_INSTALL_CONFLICT');
  assert.equal(await readFile(path, 'utf8'), 'keep me\n');
});

// Keep these tests independent of whatever already listens on the default port 47821 (a real
// catalog page on a developer machine would otherwise read as "running"): a service inventory in the
// temp catalog pins setup, check, and status to a port nothing listens on.
async function pinUnusedPort(catalog) {
  const { createServer } = await import('node:net');
  const port = await new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address();
      probe.close(() => done(free));
    });
  });
  await mkdir(catalog, { recursive: true });
  await writeFile(join(catalog, '.blockbase-service.json'), `${JSON.stringify({ schemaVersion: '1', platform: process.platform === 'linux' ? 'linux' : 'darwin', path: join(catalog, 'no-such-service'), sha256: '0'.repeat(64), label: 'com.blockbase.ui', port, installedAt: new Date(0).toISOString() })}\n`);
  return port;
}

function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  if (!('CI' in extra)) delete env.CI;
  return env;
}

async function mockRunner(base) {
  const log = join(base, 'runner.log');
  const runner = join(base, 'runner.sh');
  await writeFile(runner, `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`);
  await chmod(runner, 0o755);
  return { log, runner };
}

test('project scope without --project still fails as a usage error', () => {
  const result = invoke(['agent', 'install', '--provider', 'codex', '--scope', 'project', '--json']);
  assert.equal(result.status, 2);
  assert.equal(result.json.error.code, 'AGENT_PROJECT_REQUIRED');
});

test('--home and --no-setup skip setup and leave the catalog alone', async () => {
  const base = await mkdtemp(join(tmpdir(), 'blockbase-skip-setup-'));
  const catalog = join(base, 'blocks');
  const env = cleanEnv({ HOME: base, BLOCKBASE_HOME: catalog });
  const withHome = invoke(['agent', 'install', '--provider', 'codex', '--scope', 'global', '--home', join(base, 'agent'), '--json'], env);
  assert.equal(withHome.status, 0, withHome.stderr);
  assert.equal(withHome.json.data.setup.ran, false);
  const project = join(base, 'project');
  await mkdir(project);
  const optOut = invoke(['agent', 'install', '--provider', 'codex', '--scope', 'project', '--project', project, '--no-setup', '--json'], env);
  assert.equal(optOut.status, 0, optOut.stderr);
  assert.equal(optOut.json.data.setup.ran, false);
  assert.equal(existsSync(catalog), false);
  assert.equal(invoke(['agent', 'remove', '--provider', 'codex', '--scope', 'project', '--project', project, '--json'], env).json.data.hint, undefined);
});

test('--no-setup is rejected outside agent install and update', () => {
  assert.equal(invoke(['agent', 'check', '--no-setup', '--provider', 'codex', '--scope', 'global', '--json']).status, 2);
});

test('CI skips setup even without flags', async () => {
  const base = await mkdtemp(join(tmpdir(), 'blockbase-ci-setup-'));
  const catalog = join(base, 'blocks');
  const project = join(base, 'project');
  await mkdir(project);
  const env = cleanEnv({ HOME: base, BLOCKBASE_HOME: catalog, CI: '1' });
  const result = invoke(['agent', 'install', '--provider', 'cursor', '--scope', 'project', '--project', project, '--json'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.data.setup.ran, false);
  assert.equal(existsSync(catalog), false);
  const inventory = JSON.parse(await readFile(join(project, '.cursor', '.blockbase-install.json'), 'utf8'));
  assert.equal(inventory.setup.ran, false);
});

test('agent check reports catalog and ui state without failing an installation that never ran setup', async () => {
  const base = await mkdtemp(join(tmpdir(), 'blockbase-check-state-'));
  const agentHome = join(base, 'agent');
  await pinUnusedPort(join(base, 'blocks'));
  const env = cleanEnv({ HOME: base, BLOCKBASE_HOME: join(base, 'blocks') });
  const args = ['--provider', 'claude-code', '--scope', 'global', '--home', agentHome, '--json'];
  assert.equal(invoke(['agent', 'install', ...args], env).status, 0);
  const checked = invoke(['agent', 'check', ...args], env);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(checked.json.data.checks.catalog, 'missing');
  assert.equal(checked.json.data.checks.ui, 'absent');
  assert.deepEqual(checked.json.data.issues, []);
});

test('install runs setup by default, records it, and check then repairs through setup first', async () => {
  const base = await mkdtemp(join(tmpdir(), 'blockbase-run-setup-'));
  const catalog = join(base, 'blocks');
  const project = join(base, 'project');
  await mkdir(project);
  const { log, runner } = await mockRunner(base);
  const port = await pinUnusedPort(catalog);
  const env = cleanEnv({ HOME: base, BLOCKBASE_HOME: catalog, BLOCKBASE_SERVICE_RUNNER: runner, BLOCKBASE_SETUP_HEALTH_TIMEOUT_MS: '300' });
  const args = ['--provider', 'claude-code', '--scope', 'project', '--project', project, '--json'];
  const installed = invoke(['agent', 'install', ...args], env);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(installed.json.data.setup.ran, true);
  assert.equal(installed.json.data.setup.catalog, 'created');
  assert.equal(installed.json.data.setup.url, `http://127.0.0.1:${port}/#home`);
  assert.ok(existsSync(join(catalog, 'index.sqlite')));
  assert.ok(existsSync(log), 'the service manager mock was called');
  const inventory = JSON.parse(await readFile(join(project, '.claude', '.blockbase-install.json'), 'utf8'));
  assert.equal(inventory.setup.ran, true);
  assert.equal(inventory.setup.catalog, 'created');

  // The mock never starts a server, so the page is installed but not answering.
  const unhealthy = invoke(['agent', 'check', ...args], env);
  assert.equal(unhealthy.status, 7);
  assert.equal(unhealthy.json.error.details.checks.catalog, 'present');
  assert.notEqual(unhealthy.json.error.details.checks.ui, 'running');
  assert.ok(unhealthy.json.error.details.issues.some((issue) => issue.startsWith('ui-')));
  assert.equal(unhealthy.json.recoveryActions[0].command, 'blockbase setup --json');
  assert.ok(unhealthy.json.recoveryActions.length <= 3);

  const removed = invoke(['agent', 'remove', ...args], env);
  assert.equal(removed.status, 0);
  assert.equal(removed.json.data.hint, 'blockbase ui service uninstall --json');
  assert.ok(existsSync(catalog), 'remove never deletes the catalog');
});
