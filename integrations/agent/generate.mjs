#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const integrationRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = resolve(integrationRoot, '../..');
const generatedRoot = join(integrationRoot, 'generated');
const registrySourcePath = join(repositoryRoot, 'packages/cli/src/registry.ts');
const parserSourcePath = join(repositoryRoot, 'packages/cli/src/index.ts');

// Runtime files emitted only into the claude-code package. Value is the file mode on disk.
const claudeRuntimeFiles = { 'bin/blockbase': 0o755, 'hooks/session-start.sh': 0o755, 'hooks/hooks.json': 0o644 };
const providers = ['claude-code', 'codex', 'cursor'];
const focusedSkills = ['blockbase-capture', 'blockbase-inbox', 'blockbase-find-and-fit', 'blockbase-organize', 'blockbase-audit'];

const argumentHints = {
  'catalog.migrate': '--catalog <legacy-root> --target <catalog-root> (--dry-run|--apply|--resume <report>) [--baseline <path>] [--out <report>] [--json]',
  import: '[--catalog <path>] [--manifest <path>] [--entry-point <path>] [--namespace <name>] [--slug <slug>] [--name <display-name>] [--from 21st] [--demo <file>] [--source-type <type>] [--source-url <url>] [--license <license>] [--author <name>] [--tag <tag>]... [--json]',
  'catalog.locate': '[--catalog <path>] [--json]',
  'catalog.list': '[--catalog <path>] [--json]',
  'catalog.rebuild': '[--catalog <path>] [--json]',
  search: '[--catalog <path>] [--project <path>] [--profile <path>] [--framework <name>] [--language <name>] [--runtime <name>] [--style <name>] [--limit <number>] [--confidence-margin <number>] [--json]',
  inspect: '[--catalog <path>] [--revision <revision>] [--json]',
  'catalog.validate': '[--catalog <path>] [--json]',
  doctor: '[--catalog <path>] [--json]',
  'project.inspect': '[--json]',
  adapt: '[--catalog <path>] --project <path> [--revision <revision>] [--out <path>] [--json]',
  add: '[--catalog <path>] --project <path> (--dry-run|--apply) [--revision <revision>] [--manifest <path>] [--out <path>] [--json]',
  validate: '[--project <path>] [--json]',
  'agent.link': '[--home <path>] [--json]',
  'agent.check': '[--home <path>] [--json]',
  'agent.unlink': '[--home <path>] [--json]',
  'agent.install': '--provider <claude-code|codex|cursor> --scope <project|global> [--project <path>] [--home <path>] [--mcp] [--no-setup] [--json]',
  'agent.update': '--provider <claude-code|codex|cursor> --scope <project|global> [--project <path>] [--home <path>] [--mcp] [--no-setup] [--json]',
  'agent.remove': '--provider <claude-code|codex|cursor> --scope <project|global> [--project <path>] [--home <path>] [--json]',
  'inbox.add': '(--path <path> | -) [--from 21st] [--name <label>] [--entry-point <file>] [--catalog <path>] [--json]',
  'inbox.list': '[--catalog <path>] [--json]',
  'inbox.show': '[--catalog <path>] [--json]',
  'inbox.import': '[--catalog <path>] [--namespace <name>] [--slug <slug>] [--name <display-name>] [--entry-point <file>] [--source-type <type>] [--source-url <url>] [--license <license>] [--author <name>] [--tag <tag>]... [--json]',
  'inbox.discard': '[--catalog <path>] [--json]',
  'tag.add': '--tag <tag> [--catalog <path>] [--json]',
  'tag.remove': '--tag <tag> [--catalog <path>] [--json]',
  'tag.list': '[--catalog <path>] [--json]',
  'collection.create': '--id <id> --title <title> [--catalog <path>] [--json]',
  'collection.add': '--id <id> --slug <slug> [--catalog <path>] [--json]',
  'collection.remove': '--id <id> --slug <slug> [--catalog <path>] [--json]',
  'collection.reorder': '--id <id> --slug <slug> --index <number> [--catalog <path>] [--json]',
  'collection.delete': '--id <id> [--catalog <path>] [--json]',
  'collection.list': '[--catalog <path>] [--json]',
  'family.set': '--family <slug> [--name <name>] [--create] [--catalog <path>] [--json]',
  'family.list': '[--catalog <path>] [--json]',
  'history.list': '[--limit <number>] [--catalog <path>] [--json]',
  'history.undo': '[--steps <number> | --to <commit>] [--catalog <path>] [--json]',
  'history.restore': '--to <commit> [--catalog <path>] [--json]',
  setup: '[--catalog <path>] [--port <number>] [--allowed-host <name>] [--no-service] [--json]',
  ui: '[--catalog <path>] [--port <number>] [--allowed-host <name>] [--open] [--json]',
  'ui.status': '[--port <number>] [--json]',
  'ui.service.install': '[--catalog <path>] [--port <number>] [--allowed-host <name>] [--json]',
  'ui.service.uninstall': '[--catalog <path>] [--json]',
  'ui.service.status': '[--catalog <path>] [--port <number>] [--json]',
};

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseRegistry(source) {
  const entries = [];
  const pattern = /\{\s*operation:\s*'([^']+)',\s*command:\s*'([^']+)',\s*description:\s*'([^']+)',\s*json:\s*(true|false),\s*\}/g;
  for (const match of source.matchAll(pattern)) {
    const [, operation, command, description, json] = match;
    const argumentHint = argumentHints[operation];
    if (!argumentHint) throw new Error(`Missing argument hint for CLI operation '${operation}'.`);
    entries.push({ operation, command, description, argumentHint, json: json === 'true' });
  }
  if (entries.length === 0) throw new Error(`No CLI operations found in '${registrySourcePath}'.`);
  if (new Set(entries.map((entry) => entry.operation)).size !== entries.length) throw new Error('CLI operation registry contains duplicate operations.');
  return entries;
}

function assertParserOptions(source, metadata) {
  const supported = new Set([...source.matchAll(/--([a-z-]+)/g)].map((match) => `--${match[1]}`));
  for (const entry of Object.values(metadata)) {
    for (const option of entry.argumentHint.match(/--[a-z-]+/g) ?? []) {
      if (!supported.has(option)) throw new Error(`Argument hint '${option}' is not accepted by the live CLI parser.`);
    }
  }
}

function parseProvider(source, path) {
  const provider = source.match(/^provider:\s*([^\n]+)$/m)?.[1]?.trim();
  const skillRoot = source.match(/^skillRoot:\s*([^\n]+)$/m)?.[1]?.trim();
  const executable = source.match(/^executable:\s*([^\n]+)$/m)?.[1]?.trim();
  const skills = [...source.matchAll(/^  - ([^\n]+)$/gm)].map((match) => match[1].trim());
  if (!provider || !skillRoot || !executable || skills.length === 0) throw new Error(`Provider descriptor '${path}' is incomplete.`);
  if (!providers.includes(provider)) throw new Error(`Unsupported provider '${provider}'.`);
  return { provider, skillRoot, executable, skills };
}

async function canonicalInputs() {
  const paths = [
    'SKILL.md',
    'plugin.json',
    'PLUGIN.md',
    'agents/openai.yaml',
    'packages/cli/src/registry.ts',
    'packages/cli/src/index.ts',
    ...focusedSkills.map((skill) => `skills/${skill}/SKILL.md`),
  ];
  const referenceNames = (await readdir(join(integrationRoot, 'references/commands'))).filter((name) => name.endsWith('.md')).sort();
  paths.push(...referenceNames.map((name) => `references/commands/${name}`));
  paths.push(...providers.map((provider) => `providers/${provider}.yaml`));
  paths.push(...Object.keys(claudeRuntimeFiles).map((name) => `runtime/${name}`));
  const records = [];
  for (const path of paths.sort()) {
    const absolute = path.startsWith('packages/') ? join(repositoryRoot, path) : join(integrationRoot, path);
    records.push({ path, sha256: sha256(await readFile(absolute)) });
  }
  return records;
}

async function readSources() {
  const [registrySource, parserSource] = await Promise.all([readFile(registrySourcePath, 'utf8'), readFile(parserSourcePath, 'utf8')]);
  const metadata = Object.fromEntries(parseRegistry(registrySource).map(({ command, operation, description, argumentHint, json }) => [command, { operation, description, argumentHint, json }]));
  assertParserOptions(parserSource, metadata);
  const descriptors = {};
  for (const provider of providers) {
    const path = join(integrationRoot, `providers/${provider}.yaml`);
    descriptors[provider] = parseProvider(await readFile(path, 'utf8'), path);
  }
  const inputs = await canonicalInputs();
  const sourceHash = sha256(stableJson(inputs));
  return { metadata, descriptors, inputs, sourceHash, parserSource };
}

const claudeRootSentence = 'Command contracts live at `${CLAUDE_PLUGIN_ROOT}/references/commands/`. When that variable is unset, use `../../references/commands/` from this skill directory.';
const relativeRootSentence = 'Command contracts live at `../../references/commands/` relative to this skill directory.';

// Canonical skills use the Claude Code plugin root variable. Hosts that never set it get the relative form.
function renderSkill(source, provider) {
  if (provider === 'claude-code') return source;
  if (!source.includes(claudeRootSentence)) throw new Error('Skill is missing the command contracts sentence.');
  return source.replace(claudeRootSentence, relativeRootSentence).replaceAll('${CLAUDE_PLUGIN_ROOT}/references/commands/', '../../references/commands/');
}

/**
 * plugin.json is the version source for the runtime files (hook install spec, npx fallback). It must
 * match the CLI package the hook installs and the root marketplace entry, or users get a mismatched CLI.
 */
async function pluginVersionChecked() {
  const plugin = JSON.parse(await readFile(join(integrationRoot, 'plugin.json'), 'utf8')).version;
  const cli = JSON.parse(await readFile(join(repositoryRoot, 'packages/cli/package.json'), 'utf8')).version;
  const marketplace = JSON.parse(await readFile(join(repositoryRoot, '.claude-plugin/marketplace.json'), 'utf8'));
  const listed = [marketplace.metadata?.version, ...marketplace.plugins.map((entry) => entry.version)].filter((value) => value !== undefined);
  const mismatched = [cli, ...listed].filter((value) => value !== plugin);
  if (mismatched.length > 0) throw new Error(`Version mismatch: integrations/agent/plugin.json is ${plugin}, but packages/cli/package.json is ${cli} and .claude-plugin/marketplace.json lists ${listed.join(', ') || 'none'}.`);
  return plugin;
}

async function expectedFiles() {
  const { metadata, descriptors, inputs, sourceHash } = await readSources();
  const files = new Map();
  files.set('command-metadata.json', stableJson(metadata));
  for (const descriptor of Object.values(descriptors)) {
    const output = join('generated', descriptor.provider);
    const manifest = {
      name: 'blockbase',
      version: '0.3.2',
      provider: descriptor.provider,
      skillRoot: descriptor.skillRoot,
      executable: descriptor.executable,
      skills: descriptor.skills,
      generatedFrom: 'integrations/agent',
      sourceHash,
      sourceFiles: inputs.map((input) => input.path),
    };
    files.set(`${output}/manifest.json`, stableJson(manifest));
    files.set(`${output}/command-metadata.json`, stableJson(metadata));
    if (descriptor.provider === 'claude-code') {
      files.set(`${output}/.claude-plugin/plugin.json`, await readFile(join(integrationRoot, 'plugin.json'), 'utf8'));
      files.set(`${output}/README.md`, await readFile(join(integrationRoot, 'PLUGIN.md'), 'utf8'));
      const pluginVersion = await pluginVersionChecked();
      for (const name of Object.keys(claudeRuntimeFiles)) {
        files.set(`${output}/${name}`, (await readFile(join(integrationRoot, `runtime/${name}`), 'utf8')).replaceAll('__PLUGIN_VERSION__', pluginVersion));
      }
    }
    files.set(`${output}/${descriptor.skillRoot}/blockbase/SKILL.md`, renderSkill(await readFile(join(integrationRoot, 'SKILL.md'), 'utf8'), descriptor.provider));
    for (const skill of descriptor.skills.filter((name) => focusedSkills.includes(name))) {
      files.set(`${output}/${descriptor.skillRoot}/${skill}/SKILL.md`, renderSkill(await readFile(join(integrationRoot, `skills/${skill}/SKILL.md`), 'utf8'), descriptor.provider));
    }
    const referenceNames = (await readdir(join(integrationRoot, 'references/commands'))).filter((name) => name.endsWith('.md')).sort();
    for (const name of referenceNames) files.set(`${output}/references/commands/${name}`, await readFile(join(integrationRoot, `references/commands/${name}`), 'utf8'));
  }
  return files;
}

function expectedMode(relativePath) {
  const match = relativePath.match(/^generated\/claude-code\/(.+)$/);
  return match ? claudeRuntimeFiles[match[1]] : undefined;
}

async function actualFiles() {
  const files = new Map();
  async function visit(path) {
    const info = await stat(path);
    if (info.isDirectory()) {
      for (const name of await readdir(path)) await visit(join(path, name));
      return;
    }
    files.set(relative(integrationRoot, path), await readFile(path));
  }
  await visit(generatedRoot).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  return files;
}

async function generate(check) {
  const expected = await expectedFiles();
  const actual = await actualFiles();
  const stale = [...actual.keys()].filter((path) => !expected.has(path.replace(/^generated\//, 'generated/')) && path !== 'generated');
  const drift = [];
  for (const [relativePath, content] of expected) {
    const absolute = join(integrationRoot, relativePath);
    const previous = relativePath === 'command-metadata.json' ? await readFile(absolute).catch(() => null) : actual.get(relativePath);
    if (!previous || !Buffer.from(previous).equals(Buffer.from(content))) drift.push(relativePath);
    else if (expectedMode(relativePath) !== undefined && ((await stat(absolute)).mode & 0o777) !== expectedMode(relativePath)) drift.push(relativePath);
  }
  if (stale.length > 0) drift.push(...stale);
  if (check) {
    if (drift.length > 0) throw new Error(`Generated provider drift detected: ${drift.sort().join(', ')}`);
    process.stdout.write(`provider packages are drift-free (${expected.size} files)\n`);
    return;
  }
  await rm(generatedRoot, { recursive: true, force: true });
  for (const [relativePath, content] of expected) {
    const absolute = join(integrationRoot, relativePath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
    if (expectedMode(relativePath) !== undefined) await chmod(absolute, expectedMode(relativePath));
  }
  process.stdout.write(`generated provider packages (${expected.size} files)\n`);
}

const check = process.argv.includes('--check');
if (process.argv.includes('--hash')) {
  process.stdout.write(`${(await readSources()).sourceHash}\n`);
} else {
  await generate(check);
}
