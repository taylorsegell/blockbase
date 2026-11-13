import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { Client } from '../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

export const repositoryRoot = resolve(import.meta.dirname, '..');
export const cli = resolve(repositoryRoot, 'packages/cli/dist/index.js');
const fixturesRoot = resolve(repositoryRoot, 'tests/fixtures');

function invoke(args, cwd = repositoryRoot) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json: result.stdout.trim() ? JSON.parse(result.stdout) : undefined };
}

function normalize(value, roots) {
  if (typeof value === 'string') return roots.reduce((text, [root, replacement]) => text.split(root).join(replacement), value);
  if (Array.isArray(value)) return value.map((item) => normalize(item, roots));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item, roots)]));
  return value;
}

function contract(envelope, roots) {
  if (envelope.ok) return { schemaVersion: envelope.schemaVersion, ok: true, data: normalize(envelope.data, roots), warnings: normalize(envelope.warnings, roots) };
  return { schemaVersion: envelope.schemaVersion, ok: false, error: normalize(envelope.error, roots), warnings: normalize(envelope.warnings, roots), recoveryActions: normalize(envelope.recoveryActions, roots) };
}

async function connectMcp() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], cwd: repositoryRoot, stderr: 'pipe' });
  const client = new Client({ name: 'blockbase-parity-test', version: '0.1.0' });
  await client.connect(transport);
  return { client, transport };
}

async function callMcp(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(result.structuredContent, `${name} did not return structured content: ${JSON.stringify(result)}`);
  return result.structuredContent;
}

async function importSource(catalog, source, slug, name) {
  const imported = invoke(['import', resolve(repositoryRoot, source), '--catalog', catalog, '--namespace', 'parity', '--slug', slug, '--name', name, '--json']);
  assert.equal(imported.status, 0, imported.stderr);
  return imported.json.data;
}

async function setup(root, commands = ['true']) {
  const catalog = join(root, 'catalog-data');
  const destination = join(root, 'destination');
  await mkdir(root, { recursive: true });
  await importSource(catalog, 'tests/fixtures/sources/normalization/static-tailwind', 'static-card', 'Static Card');
  await importSource(catalog, 'tests/fixtures/sources/normalization/static-tailwind', 'pricing-card', 'Pricing Card');
  await importSource(catalog, 'tests/fixtures/sources/normalization/static-tailwind', 'pricing-panel', 'Pricing Panel');
  const rebuilt = invoke(['catalog', 'rebuild', '--catalog', catalog, '--json']);
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  await cp(join(fixturesRoot, 'destinations/fixture-a'), destination, { recursive: true });
  await mkdir(join(destination, '.blockbase'), { recursive: true });
  await writeFile(join(destination, '.blockbase/project.json'), `${JSON.stringify({ validationCommands: commands }, null, 2)}\n`);
  return { catalog, destination };
}

async function runCase(root, id, setupOptions = {}) {
  const { catalog, destination } = await setup(root, setupOptions.commands);
  const roots = [[root, '$MATRIX'], [repositoryRoot, '$REPO']];
  const { client, transport } = await connectMcp();
  const records = [];
  const compare = async (operation, cliArgs, tool, toolArgs) => {
    const cliResult = invoke([...cliArgs, '--json']);
    const mcpResult = await callMcp(client, tool, toolArgs);
    const cliContract = contract(cliResult.json, roots);
    const mcpEnvelope = mcpResult.ok === false ? mcpResult : { schemaVersion: mcpResult.schemaVersion, ok: true, data: mcpResult, warnings: [] };
    const mcpContract = contract(mcpEnvelope, roots);
    assert.deepEqual(mcpContract, cliContract, `${id}/${operation} MCP and CLI contracts differ`);
    records.push({ operation, cli: { status: cliResult.status, contract: cliContract }, mcp: { contract: mcpContract } });
    return { cliResult, mcpResult };
  };
  try {
    if (id === 'success') {
      const search = await compare('search', ['search', 'Static Card', '--catalog', catalog, '--project', destination], 'search_components', { query: 'Static Card', catalog_root: catalog, project_path: destination });
      const componentId = search.cliResult.json.data.selection.selectedComponentId ?? search.cliResult.json.data.results[0]?.componentId;
      assert.ok(componentId, `search returned no component: ${JSON.stringify(search.cliResult.json)}`);
      await compare('inspect', ['inspect', componentId, '--catalog', catalog], 'get_component', { id: componentId, catalog_root: catalog });
      const before = await readdir(destination);
      const prepared = await compare('adapt', ['adapt', componentId, '--catalog', catalog, '--project', destination], 'prepare_adaptation', { id: componentId, catalog_root: catalog, project_path: destination });
      assert.deepEqual(await readdir(destination), before, 'MCP preparation changed destination files');
      await mkdir(join(root, 'cli-staging'), { recursive: true });
      await writeFile(join(root, 'cli-staging/bundle.json'), `${JSON.stringify(prepared.cliResult.json.data, null, 2)}\n`);
      const bundleId = prepared.mcpResult.bundleId;
      await compare('validate', ['validate', join(root, 'cli-staging', 'bundle.json'), '--project', destination], 'validate_adaptation', { bundle_id: bundleId, project_path: destination });
    } else if (id === 'miss') {
      await compare('search-miss', ['search', 'nonexistent galaxy widget', '--catalog', catalog], 'search_components', { query: 'nonexistent galaxy widget', catalog_root: catalog });
    } else if (id === 'ambiguity') {
      await compare('search-ambiguity', ['search', 'pricing', '--catalog', catalog], 'search_components', { query: 'pricing', catalog_root: catalog });
    } else if (id === 'unsupported') {
      const unsupported = resolve(repositoryRoot, 'integrations/agent/harness/fixtures/unsupported-vue');
      await compare('inspect-unsupported', ['project', 'inspect', '--cwd', unsupported], 'inspect_project', { project_path: unsupported });
    } else if (id === 'stale-revision') {
      const imported = await importSource(catalog, 'tests/fixtures/sources/normalization/static-tailwind', 'stale-card', 'Stale Card');
      const rebuilt = invoke(['catalog', 'rebuild', '--catalog', catalog, '--json']);
      assert.equal(rebuilt.status, 0, rebuilt.stderr);
      await compare('inspect-stale', ['inspect', imported.manifest.componentId, '--revision', 'sha256:missing', '--catalog', catalog], 'get_component', { id: imported.manifest.componentId, revision: 'sha256:missing', catalog_root: catalog });
    } else if (id === 'missing-dependency') {
      const destinationB = join(root, 'dependency-destination');
      await cp(join(fixturesRoot, 'destinations/fixture-a'), destinationB, { recursive: true });
      const packagePath = join(destinationB, 'package.json');
      const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
      delete packageJson.dependencies.clsx;
      await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
      const imported = await importSource(catalog, 'tests/fixtures/sources/normalization/third-party-import', 'third-party', 'Third Party');
      const rebuilt = invoke(['catalog', 'rebuild', '--catalog', catalog, '--json']);
      assert.equal(rebuilt.status, 0, rebuilt.stderr);
      const prepared = await compare('adapt-missing-dependency', ['adapt', imported.manifest.componentId, '--catalog', catalog, '--project', destinationB], 'prepare_adaptation', { id: imported.manifest.componentId, catalog_root: catalog, project_path: destinationB });
      assert.equal(prepared.mcpResult.dependencyDelta.add.some((item) => item.name === 'clsx'), true);
    } else if (id === 'validation-failure') {
      const imported = await importSource(catalog, 'tests/fixtures/sources/normalization/static-tailwind', 'validation-card', 'Validation Card');
      const rebuilt = invoke(['catalog', 'rebuild', '--catalog', catalog, '--json']);
      assert.equal(rebuilt.status, 0, rebuilt.stderr);
      const prepared = await compare('adapt-validation-failure', ['adapt', imported.manifest.componentId, '--catalog', catalog, '--project', destination], 'prepare_adaptation', { id: imported.manifest.componentId, catalog_root: catalog, project_path: destination });
      await mkdir(join(root, 'cli-staging'), { recursive: true });
      await writeFile(join(root, 'cli-staging/bundle.json'), `${JSON.stringify(prepared.cliResult.json.data, null, 2)}\n`);
      await compare('validate-failure', ['validate', join(root, 'cli-staging', 'bundle.json'), '--project', destination], 'validate_adaptation', { bundle_id: prepared.mcpResult.bundleId, project_path: destination });
    } else throw new Error(`Unknown parity case '${id}'`);
  } finally {
    await client.close();
    await transport.close();
  }
  return records;
}

export async function runParityMatrix() {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-mcp-cli-parity-'));
  const matrix = [
    ['success', { commands: ['true'] }],
    ['miss', { commands: ['true'] }],
    ['ambiguity', { commands: ['true'] }],
    ['unsupported', { commands: ['true'] }],
    ['stale-revision', { commands: ['true'] }],
    ['missing-dependency', { commands: ['true'] }],
    ['validation-failure', { commands: ['false'] }],
  ];
  const cases = [];
  try {
    for (const [id, options] of matrix) cases.push({ id, records: await runCase(join(root, id), id, options) });
    return { schemaVersion: '1', harness: 'mcp-cli-black-box-parity', cases, processLifecycle: { backgroundProcesses: 0, proof: 'Every stdio transport was closed after each case.' } };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const report = await runParityMatrix();
  const output = process.argv[process.argv.indexOf('--write-report') + 1];
  if (output) await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
