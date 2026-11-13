#!/usr/bin/env node
// Proves the published tarballs work for a stranger: pack every publishable package, install them
// together into a throwaway npm prefix (no clone, no registry for @blockbase/*), then drive the
// installed `blockbase` binary against a temp HOME and catalog. Never touches ~/.blocks or port 47821.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const work = mkdtempSync(join(tmpdir(), 'blockbase-pack-smoke-'));
const dirs = { tarballs: join(work, 'tarballs'), prefix: join(work, 'prefix'), home: join(work, 'home'), catalog: join(work, 'catalog'), project: join(work, 'proj'), fixture: join(work, 'fixture'), cache: join(work, 'cache') };
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });

let server;
const results = [];
function step(name, detail = '') {
  results.push({ name, detail });
  console.log(`ok   ${name}${detail ? ` - ${detail}` : ''}`);
}
function fail(message) {
  throw new Error(message);
}
function assert(condition, message) {
  if (!condition) fail(message);
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => (port === 47821 ? freePort().then(resolvePort, reject) : resolvePort(port)));
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Isolated environment: nothing here may resolve to the real home or the default catalog.
const env = {
  ...process.env,
  HOME: dirs.home,
  USERPROFILE: dirs.home,
  BLOCKBASE_HOME: dirs.catalog,
  BLOCKBASE_AGENT_HOME: join(work, 'agents'),
  XDG_CACHE_HOME: dirs.cache,
  XDG_CONFIG_HOME: join(work, 'config'),
  PATH: `${join(dirs.prefix, 'bin')}:${process.env.PATH}`,
  CI: '1',
};
delete env.BLOCKBASE_PREVIEW_ENTRY;
delete env.BLOCKBASE_SERVICE_RUNNER;
const bin = join(dirs.prefix, 'bin', 'blockbase');
const blockbase = (args) => run(bin, args, { env, cwd: work });
const json = (args) => {
  const out = blockbase(args);
  const parsed = JSON.parse(out);
  assert(parsed.ok === true, `${args.join(' ')} returned ok=${parsed.ok}: ${out}`);
  return parsed;
};

async function main() {
  // (a) pack
  run('pnpm', ['-r', '--filter', './packages/*', '--filter', './apps/preview', 'pack', '--pack-destination', dirs.tarballs], { cwd: repo });
  const tarballs = readdirSync(dirs.tarballs).filter((name) => name.endsWith('.tgz')).sort();
  assert(tarballs.length === 5, `expected 5 tarballs, got ${tarballs.join(', ')}`);
  const sizes = tarballs.map((name) => `${name} ${(statSync(join(dirs.tarballs, name)).size / 1024).toFixed(0)} KiB`);
  for (const line of sizes) console.log(`     ${line}`);
  step('pack', `${tarballs.length} tarballs`);

  // (b) install together, offline for the workspace packages
  run('npm', ['install', '-g', '--prefix', dirs.prefix, '--no-audit', '--no-fund', ...tarballs.map((name) => join(dirs.tarballs, name))], { cwd: work, env: { ...env, npm_config_loglevel: 'error' } });
  assert(existsSync(bin), 'blockbase binary missing after install');
  const globalModules = join(dirs.prefix, 'lib', 'node_modules');
  const installed = JSON.parse(readFileSync(join(globalModules, '@blockbase', 'cli', 'package.json'), 'utf8'));
  assert(installed.version === '0.3.2', `unexpected cli version ${installed.version}`);
  assert(existsSync(join(globalModules, '@blockbase', 'cli', 'payload', 'generated', 'cursor', 'manifest.json')), 'agent payload missing from the cli tarball');
  assert(existsSync(join(globalModules, '@blockbase', 'preview', 'index.html')), 'preview index.html missing from tarball');
  step('npm install -g', `@blockbase/cli@${installed.version}`);

  // (c) setup
  const setup = json(['setup', '--no-service', '--json']);
  assert(setup.data.catalog === 'created', `setup catalog: ${setup.data.catalog}`);
  assert(setup.data.catalogRoot === dirs.catalog, `setup used ${setup.data.catalogRoot}`);
  step('blockbase setup --no-service', 'catalog created');

  // agent install
  const agent = json(['agent', 'install', '--provider', 'cursor', '--scope', 'project', '--project', dirs.project, '--no-setup', '--json']);
  const skill = join(dirs.project, '.cursor', 'skills', 'blockbase', 'SKILL.md');
  assert(existsSync(skill), `skill file missing: ${skill}`);
  assert(existsSync(join(dirs.project, '.cursor', 'bin', 'blockbase')), 'bin/blockbase link missing');
  assert(agent.data.provider === 'cursor', 'agent install provider mismatch');
  step('blockbase agent install', 'cursor skill files present');

  // agent link resolves its canonical tree from the payload
  const linked = json(['agent', 'link', '--home', join(work, 'agents'), '--json']);
  assert(linked.data.links.every((link) => link.state === 'ok'), 'agent link reported unhealthy links');
  step('blockbase agent link', `${linked.data.links.length} links ok`);

  // import fixture
  writeFileSync(join(dirs.fixture, 'Hello.tsx'), `import { Sparkles } from 'lucide-react';\nexport default function Hello() {\n  return <div className="p-4 text-sm font-semibold"><Sparkles className="size-4" /> Hello Blockbase</div>;\n}\n`);
  const imported = json(['import', dirs.fixture, '--json']);
  assert(typeof imported.data.componentPath === 'string', 'import returned no componentPath');
  step('blockbase import', imported.data.manifest?.componentId ?? 'imported');

  // ui
  const port = await freePort();
  server = spawn(bin, ['ui', '--port', String(port)], { env, cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', (chunk) => (serverLog += chunk));
  server.stderr.on('data', (chunk) => (serverLog += chunk));
  const base = `http://127.0.0.1:${port}`;
  let health;
  for (let i = 0; i < 120 && !health; i += 1) {
    if (server.exitCode !== null) fail(`blockbase ui exited ${server.exitCode}\n${serverLog}`);
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok && (response.headers.get('content-type') ?? '').includes('application/json')) health = await response.json();
    } catch {
      /* not up yet */
    }
    if (!health) await sleep(250);
  }
  assert(health, `ui never answered /api/health\n${serverLog}`);
  assert(health.count === 1, `health count ${health.count}`);
  assert(health.catalogRoot === dirs.catalog, `health catalogRoot ${health.catalogRoot}`);
  step('blockbase ui /api/health', `count ${health.count} on port ${port}`);

  const page = await fetch(`${base}/`);
  const html = await page.text();
  assert(page.status === 200 && (page.headers.get('content-type') ?? '').includes('text/html') && html.includes('<div id="root">'), 'GET / is not the app HTML');
  step('GET /', 'HTML shell');

  const catalog = await (await fetch(`${base}/api/catalog`)).json();
  assert(catalog.entries.length === 1 && catalog.entries[0].entryPoint === 'Hello.tsx', 'catalog entry missing');
  const virtual = await fetch(`${base}/@id/__x00__virtual:blockbase-catalog`);
  const virtualCode = await virtual.text();
  assert(virtual.status === 200, `virtual catalog module ${virtual.status}`);
  const loader = /import\("(\/@fs\/[^"]+)"\)/.exec(virtualCode);
  assert(loader, `no loader path in virtual module:\n${virtualCode}`);
  const component = await fetch(`${base}${loader[1]}`);
  const componentCode = await component.text();
  assert(component.status === 200, `component module ${component.status}: ${componentCode.slice(0, 300)}`);
  assert((component.headers.get('content-type') ?? '').includes('javascript'), `component content-type ${component.headers.get('content-type')}`);
  assert(/jsx|createElement/.test(componentCode) && !componentCode.includes(': JSX'), 'component was not transformed to JavaScript');
  step('transformed component module', `${componentCode.length} bytes JavaScript`);

  // the transformed component's dependency (lucide-react) must be servable too
  const dep = /from "(\/[^"]*lucide-react[^"]*)"/.exec(componentCode);
  assert(dep, 'component does not import lucide-react through Vite');
  const depResponse = await fetch(`${base}${dep[1]}`);
  assert(depResponse.status === 200, `lucide-react dependency ${depResponse.status}`);
  step('lucide-react dependency', dep[1]);

  const css = await fetch(`${base}/src/index.css?direct`);
  const cssText = await css.text();
  assert(css.status === 200 && (css.headers.get('content-type') ?? '').includes('text/css'), `css ${css.status} ${css.headers.get('content-type')}`);
  assert(cssText.includes('.tracking-\\[0\\.18em\\]'), 'shell-only class tracking-[0.18em] was not generated (preview src @source missing)');
  assert(cssText.includes('.font-semibold'), 'catalog component class font-semibold was not generated');
  step('CSS', `${cssText.length} bytes; shell and catalog classes generated`);

  assert(existsSync(join(dirs.cache, 'blockbase', 'vite')), 'Vite cache not written to the user cache dir');
  assert(!existsSync(join(globalModules, '@blockbase', 'preview', 'node_modules', '.vite')), 'Vite cache written inside the installed package');
  step('vite cache location', join(dirs.cache, 'blockbase', 'vite'));
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  console.error(`FAIL ${error instanceof Error ? error.message : error}`);
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((r) => {
      const timer = setTimeout(() => (server.kill('SIGKILL'), r()), 5000);
      server.once('exit', () => (clearTimeout(timer), r()));
    });
  }
  if (exitCode === 0 || !process.env.PACK_SMOKE_KEEP) rmSync(work, { recursive: true, force: true });
  else console.error(`kept ${work}`);
}
console.log(exitCode === 0 ? `pack smoke passed (${results.length} checks)` : 'pack smoke FAILED');
process.exit(exitCode);
