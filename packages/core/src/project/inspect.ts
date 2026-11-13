import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { CONTRACT_VERSION, type ProjectEvidence, type ProjectProfile } from '@blockbase/contracts';
import { PROJECT_ERROR_CODES, ProjectInspectionError } from './errors.js';
import type { ProjectInspectionOptions } from './types.js';

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_COMPONENT_SAMPLES = 8;
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const CSS_EXTENSIONS = new Set(['.css', '.pcss', '.scss']);
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb'];
const CONFIG_FILES = [
  'tsconfig.json', 'tsconfig.app.json', 'jsconfig.json', 'components.json',
  'vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs',
  'next.config.ts', 'next.config.js', 'next.config.mjs',
  'tailwind.config.ts', 'tailwind.config.js', 'tailwind.config.cjs', 'tailwind.config.mjs',
];
const CSS_FILES = [
  'src/index.css', 'src/styles.css', 'src/globals.css', 'src/app.css',
  'src/styles/globals.css', 'app/globals.css', 'styles/globals.css', 'index.css', 'globals.css',
];
const COMPONENT_DIRECTORIES = ['src/components', 'components', 'app/components', 'src/ui', 'app/ui', 'src', 'app'];
const PACKAGE_MANAGER_COMMANDS = ['format', 'lint', 'typecheck', 'test', 'build'];

type JsonRecord = Record<string, unknown>;
type ReadResult = { path: string; text?: string; binary?: boolean };
type TokenDefinition = { path: string; line: number; value: string; mode: 'light' | 'dark' | 'unknown' };

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function relPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function packageValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function dependencies(packageJson: JsonRecord): { runtime: Record<string, string>; development: Record<string, string> } {
  const read = (key: string): Record<string, string> => {
    const value = packageJson[key];
    if (!isRecord(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string').sort(([a], [b]) => a.localeCompare(b)));
  };
  return { runtime: read('dependencies'), development: { ...read('devDependencies'), ...read('peerDependencies') } };
}

function dependencyVersion(all: { runtime: Record<string, string>; development: Record<string, string> }, name: string): string | undefined {
  return all.runtime[name] ?? all.development[name];
}

function addEvidence(evidence: ProjectEvidence[], path: string, source: ProjectEvidence['source'], fact: string, confidence: ProjectEvidence['confidence']): void {
  evidence.push({ path, source, fact, confidence });
}

function parseJson(path: string, text: string, code: 'package' | 'override'): JsonRecord {
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) throw new Error('JSON root must be an object');
    return value;
  } catch (error) {
    const errorCode = code === 'package' ? PROJECT_ERROR_CODES.invalidPackage : PROJECT_ERROR_CODES.invalidOverride;
    throw new ProjectInspectionError(errorCode, `The ${code === 'package' ? 'package.json' : '.blockbase/project.json'} file is not valid JSON.`, { path, cause: error instanceof Error ? error.message : String(error) });
  }
}

function overrideRecord(root: JsonRecord, key: string): JsonRecord | undefined {
  const value = root[key];
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new ProjectInspectionError(PROJECT_ERROR_CODES.invalidOverride, `Override '${key}' must be an object.`);
  return value;
}

function overrideStrings(root: JsonRecord, key: string): Record<string, string> | undefined {
  const value = overrideRecord(root, key);
  if (!value) return undefined;
  const invalid = Object.entries(value).find(([, item]) => typeof item !== 'string');
  if (invalid) throw new ProjectInspectionError(PROJECT_ERROR_CODES.invalidOverride, `Override '${key}' values must be strings.`, { key: invalid[0] });
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) as Record<string, string>;
}

function overrideStringArray(root: JsonRecord, key: string): string[] | undefined {
  const value = root[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new ProjectInspectionError(PROJECT_ERROR_CODES.invalidOverride, `Override '${key}' must be an array of non-empty strings.`);
  }
  return [...new Set(value)].sort();
}

function overrideFrameworkValue(root: JsonRecord | undefined): { name: string; version?: string } | undefined {
  if (!root) return undefined;
  const name = root.name;
  if (typeof name !== 'string' || name.length === 0) throw new ProjectInspectionError(PROJECT_ERROR_CODES.invalidOverride, "Override 'framework.name' must be a non-empty string.");
  if (root.version !== undefined && (typeof root.version !== 'string' || root.version.length === 0)) throw new ProjectInspectionError(PROJECT_ERROR_CODES.invalidOverride, "Override 'framework.version' must be a non-empty string.");
  return { name, ...(root.version === undefined ? {} : { version: root.version as string }) };
}

function overrideConventionsValue(root: JsonRecord | undefined): JsonRecord {
  if (!root) return {};
  for (const key of ['componentDirectory', 'filenameCase', 'importAlias']) {
    if (root[key] !== undefined && (typeof root[key] !== 'string' || root[key].length === 0)) throw new ProjectInspectionError(PROJECT_ERROR_CODES.invalidOverride, `Override 'conventions.${key}' must be a non-empty string.`);
  }
  if (root.filenameCase !== undefined && !['kebab', 'pascal', 'camel', 'mixed'].includes(root.filenameCase as string)) throw new ProjectInspectionError(PROJECT_ERROR_CODES.invalidOverride, "Override 'conventions.filenameCase' is not supported.");
  return root;
}

function readMode(selector: string): TokenDefinition['mode'] {
  if (/dark|prefers-color-scheme\s*:\s*dark/i.test(selector)) return 'dark';
  if (/:root|light|prefers-color-scheme\s*:\s*light/i.test(selector)) return 'light';
  return 'unknown';
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

function tokenDefinitions(path: string, text: string): Map<string, TokenDefinition[]> {
  const definitions = new Map<string, TokenDefinition[]>();
  const blocks = /([^{}]+)\{([^{}]*)\}/g;
  let block: RegExpExecArray | null;
  while ((block = blocks.exec(text)) !== null) {
    const context = text.slice(0, block.index);
    const lastMedia = context.lastIndexOf('@media');
    const lastClose = context.lastIndexOf('}');
    const mode = lastMedia > lastClose && /prefers-color-scheme\s*:\s*dark/i.test(context.slice(lastMedia)) ? 'dark' : readMode(block[1]);
    const declarations = /(--[A-Za-z0-9_-]+)\s*:\s*([^;]+)\s*;?/g;
    let declaration: RegExpExecArray | null;
    while ((declaration = declarations.exec(block[2])) !== null) {
      const definition: TokenDefinition = { path, line: lineAt(text, block.index + declaration.index), value: declaration[2].trim(), mode };
      const existing = definitions.get(declaration[1]) ?? [];
      existing.push(definition);
      definitions.set(declaration[1], existing);
    }
  }
  return definitions;
}

function parseTsconfig(text: string): JsonRecord {
  try {
    // JSONC is common in tsconfig files; comments and trailing commas are safe to remove here.
    return parseJson('tsconfig.json', text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1'), 'package');
  } catch {
    return {};
  }
}

function aliasFromConfig(config: JsonRecord | undefined): { alias?: string; target?: string } {
  const compiler = config && isRecord(config.compilerOptions) ? config.compilerOptions : undefined;
  const paths = compiler && isRecord(compiler.paths) ? compiler.paths : undefined;
  if (!paths) return {};
  const match = Object.entries(paths).filter(([, value]) => Array.isArray(value) && typeof value[0] === 'string').sort(([a], [b]) => a.localeCompare(b))[0];
  if (!match) return {};
  const alias = match[0].replace(/\*$/, '');
  const target = (match[1] as string[])[0].replace(/^\.\//, '').replace(/\*$/, '');
  return { alias, target };
}

function normalizeAliasTarget(value: string, root: string, alias?: { alias?: string; target?: string }): string {
  const mapped = alias?.alias && alias.target && value.startsWith(alias.alias) ? `${alias.target}${value.slice(alias.alias.length)}` : value;
  const cleaned = mapped.replace(/^@\//, '').replace(/^~\//, '').replace(/^\.\//, '').replace(/\/$/, '');
  return cleaned || relPath(root, root);
}

function filenameCase(names: string[]): ProjectProfile['conventions']['filenameCase'] {
  const meaningful = names.filter((name) => name !== 'index');
  if (meaningful.length === 0) return 'mixed';
  const cases = new Set(meaningful.map((name) => name.includes('-') ? 'kebab' : /^[A-Z]/.test(name) ? 'pascal' : 'camel'));
  return cases.size === 1 ? [...cases][0] as ProjectProfile['conventions']['filenameCase'] : 'mixed';
}

function commandPrefix(packageJson: JsonRecord): string {
  const packageManager = packageValue(packageJson.packageManager);
  if (packageManager?.startsWith('npm@')) return 'npm run';
  if (packageManager?.startsWith('yarn@') || packageManager === 'yarn') return 'yarn';
  if (packageManager?.startsWith('bun@') || packageManager === 'bun') return 'bun';
  return 'pnpm';
}

function frameworkFor(all: { runtime: Record<string, string>; development: Record<string, string> }): { name: string; version?: string } {
  const unsupported = ['vue', 'svelte', '@angular/core', 'solid-js'].find((name) => dependencyVersion(all, name));
  if (unsupported) throw new ProjectInspectionError(PROJECT_ERROR_CODES.unsupportedFramework, `The destination framework '${unsupported}' is not supported.`, { framework: unsupported });
  const candidates = ['next', '@remix-run/react', 'vite', 'react-scripts'];
  const found = candidates.find((name) => dependencyVersion(all, name));
  if (found) return { name: found === '@remix-run/react' ? 'remix' : found === 'react-scripts' ? 'create-react-app' : found, version: dependencyVersion(all, found) };
  if (!dependencyVersion(all, 'react')) throw new ProjectInspectionError(PROJECT_ERROR_CODES.unsupportedFramework, 'The destination does not declare a supported React framework.', { framework: 'unknown' });
  return { name: 'react', version: dependencyVersion(all, 'react') };
}

async function readAllowlisted(root: string, relativePath: string, maxBytes: number): Promise<ReadResult | undefined> {
  const path = join(root, relativePath);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return undefined;
    if (info.size > maxBytes) return { path: relativePath };
    if (relative(resolve(root), resolve(path)).startsWith(`..${sep}`)) return undefined;
    if (relativePath.endsWith('.lockb')) return { path: relativePath, binary: true };
    return { path: relativePath, text: await readFile(path, 'utf8') };
  } catch {
    return undefined;
  }
}

async function sampleComponents(root: string, directory: string, limit: number): Promise<string[]> {
  const result: string[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: join(root, directory), depth: 0 }];
  while (queue.length > 0 && result.length < limit) {
    const current = queue.shift()!;
    let entries;
    try { entries = (await readdir(current.path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)); } catch { continue; }
    for (const entry of entries) {
      if (result.length >= limit || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const path = join(current.path, entry.name);
      if (entry.isDirectory() && current.depth < 2) queue.push({ path, depth: current.depth + 1 });
      else if (entry.isFile() && (SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase()) || entry.name.endsWith('.module.css'))) result.push(relPath(root, path));
    }
  }
  return result.sort();
}

export async function inspectProject(projectPath: string, options: ProjectInspectionOptions = {}): Promise<ProjectProfile> {
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxSamples = options.maxComponentSamples ?? DEFAULT_MAX_COMPONENT_SAMPLES;
  const root = resolve(projectPath);
  let projectRoot: string;
  try { projectRoot = await realpath(root); } catch { throw new ProjectInspectionError(PROJECT_ERROR_CODES.projectNotFound, 'The destination project does not exist.', { path: root }); }

  const evidence: ProjectEvidence[] = [];
  const packageRead = await readAllowlisted(projectRoot, 'package.json', maxBytes);
  if (!packageRead?.text) throw new ProjectInspectionError(PROJECT_ERROR_CODES.projectNotFound, 'The destination does not contain package.json.', { path: join(projectRoot, 'package.json') });
  const packageJson = parseJson('package.json', packageRead.text, 'package');
  const allDependencies = dependencies(packageJson);
  addEvidence(evidence, 'package.json', 'package.json', 'Dependency inventory and package metadata were read.', 'high');
  const framework = frameworkFor(allDependencies);
  addEvidence(evidence, 'package.json', 'package.json', `Framework detected: ${framework.name}${framework.version ? ` ${framework.version}` : ''}.`, 'high');

  const readFiles = new Map<string, ReadResult>();
  for (const path of [...LOCKFILES, ...CONFIG_FILES, ...CSS_FILES]) {
    const item = await readAllowlisted(projectRoot, path, maxBytes);
    if (item) readFiles.set(path, item);
  }
  for (const [path, item] of readFiles) {
    addEvidence(evidence, path, path.includes('lock') ? 'lockfile' : path.endsWith('.css') ? 'config' : 'config', item.text === undefined ? `Allowlisted file is present but exceeds the ${maxBytes}-byte read bound.` : 'Allowlisted project evidence was read.', 'high');
  }

  const tsconfigEntry = [...readFiles.entries()].find(([path]) => path === 'tsconfig.json' || path === 'tsconfig.app.json' || path === 'jsconfig.json');
  const tsconfig = tsconfigEntry?.[1].text ? parseTsconfig(tsconfigEntry[1].text) : undefined;
  const tsAlias = aliasFromConfig(tsconfig);
  if (tsAlias.alias) addEvidence(evidence, tsconfigEntry![0], 'config', `Import alias ${tsAlias.alias} resolves to ${tsAlias.target}.`, 'high');

  const componentConfig = readFiles.get('components.json')?.text;
  let componentsConfig: JsonRecord | undefined;
  if (componentConfig) {
    try { componentsConfig = parseJson('components.json', componentConfig, 'package'); } catch { componentsConfig = undefined; }
  }
  const configAliases = componentsConfig && isRecord(componentsConfig.aliases) ? componentsConfig.aliases : undefined;
  const configuredComponents = configAliases && typeof configAliases.components === 'string' ? configAliases.components : undefined;
  const configuredDirectory = configuredComponents ? normalizeAliasTarget(configuredComponents, projectRoot, tsAlias) : undefined;
  const inferredDirectory = tsAlias.target ? normalizeAliasTarget(tsAlias.target, projectRoot) : undefined;
  const componentDirectory = configuredDirectory ?? inferredDirectory ?? (await (async () => {
    for (const candidate of COMPONENT_DIRECTORIES) {
      try { if ((await lstat(join(projectRoot, candidate))).isDirectory()) return candidate; } catch { /* candidate is optional */ }
    }
    return 'src/components';
  })());
  const samples = await sampleComponents(projectRoot, componentDirectory, maxSamples);
  const sampleNames: string[] = [];
  const sampleTexts = new Map<string, string>();
  for (const path of samples) {
    const item = await readAllowlisted(projectRoot, path, Math.min(maxBytes, 64 * 1024));
    if (!item?.text) continue;
    sampleTexts.set(path, item.text);
    sampleNames.push(basename(path, extname(path)));
    addEvidence(evidence, path, 'source', 'Deterministic bounded component convention sample.', 'medium');
  }
  addEvidence(evidence, componentConfig ? 'components.json' : tsconfigEntry?.[0] ?? 'package.json', componentConfig || tsconfigEntry ? 'config' : 'package.json', `Component directory selected: ${componentDirectory}.`, componentConfig || tsconfigEntry ? 'high' : 'medium');

  const cssTokens = new Map<string, TokenDefinition[]>();
  const tokenFiles: string[] = [];
  for (const [path, item] of readFiles) {
    if (!CSS_EXTENSIONS.has(extname(path).toLowerCase()) || !item.text) continue;
    const definitions = tokenDefinitions(path, item.text);
    if (definitions.size === 0) continue;
    tokenFiles.push(path);
    for (const [name, entries] of definitions) cssTokens.set(name, [...(cssTokens.get(name) ?? []), ...entries]);
  }
  for (const [path, text] of sampleTexts) {
    if (!path.endsWith('.module.css')) continue;
    const definitions = tokenDefinitions(path, text);
    for (const [name, entries] of definitions) cssTokens.set(name, [...(cssTokens.get(name) ?? []), ...entries]);
  }
  tokenFiles.sort();
  const values: Record<string, string> = {};
  const aliases: Record<string, string> = {};
  const conflicts: string[] = [];
  for (const name of [...cssTokens.keys()].sort()) {
    const definitions = cssTokens.get(name)!;
    const byMode = new Map<string, TokenDefinition[]>();
    for (const definition of definitions) byMode.set(definition.mode, [...(byMode.get(definition.mode) ?? []), definition]);
    for (const [mode, modeDefinitions] of byMode) {
      const distinctValues = [...new Set(modeDefinitions.map((definition) => definition.value))];
      if (distinctValues.length > 1) {
        const locations = modeDefinitions.map((definition) => `${definition.path}:${definition.line} (${definition.value})`).join(', ');
        conflicts.push(`Token ${name} has conflicting ${mode} definitions at ${locations}; select one or add .blockbase/project.json.tokens.values.${name}.`);
      }
    }
    const chosen = definitions.find((definition) => definition.mode === 'light') ?? definitions[0];
    if (/^var\(--[A-Za-z0-9_-]+\)/.test(chosen.value)) aliases[name] = chosen.value;
    else values[name] = chosen.value;
    for (const definition of definitions) addEvidence(evidence, definition.path, 'config', `Token ${name} (${definition.mode}) = ${definition.value} at line ${definition.line}.`, 'high');
  }

  const tailwindConfig = [...readFiles.keys()].find((path) => path.startsWith('tailwind.config.'));
  const hasTailwindDependency = Boolean(dependencyVersion(allDependencies, 'tailwindcss') || dependencyVersion(allDependencies, '@tailwindcss/vite') || dependencyVersion(allDependencies, '@tailwindcss/postcss'));
  const hasTailwindImport = [...readFiles.values()].some((item) => item.text?.includes('@import "tailwindcss"') || item.text?.includes("@import 'tailwindcss'"));
  const systems = [...new Set([
    ...(hasTailwindDependency || tailwindConfig || hasTailwindImport ? ['tailwind'] : []),
    ...(tokenFiles.length > 0 || [...readFiles.keys()].some((path) => CSS_EXTENSIONS.has(extname(path).toLowerCase())) ? ['css'] : []),
    ...(samples.some((path) => path.endsWith('.module.css')) ? ['css-modules'] : []),
  ])].sort();
  if (tailwindConfig) addEvidence(evidence, tailwindConfig, 'config', 'Tailwind configuration is present.', 'high');
  if (hasTailwindDependency) addEvidence(evidence, 'package.json', 'package.json', 'Tailwind support is declared by package dependencies.', 'high');

  const helperCandidates = new Set<string>();
  for (const text of sampleTexts.values()) {
    for (const helper of ['clsx', 'classnames', 'tailwind-merge']) if (new RegExp(`from ['"]${helper}['"]|require\\(['"]${helper}['"]\\)`).test(text)) helperCandidates.add(helper);
    if (/\b(?:function|const)\s+cn\b/.test(text)) helperCandidates.add('cn');
  }
  addEvidence(evidence, samples[0] ?? 'package.json', samples.length > 0 ? 'source' : 'package.json', helperCandidates.size > 0 ? `Class helper detected: ${[...helperCandidates].sort().join(', ')}.` : 'No supported class helper was detected in bounded component samples.', helperCandidates.size > 0 ? 'medium' : 'low');

  const packageType = packageValue(packageJson.type);
  const moduleSetting = tsconfig && isRecord(tsconfig.compilerOptions) ? packageValue(tsconfig.compilerOptions.module) : undefined;
  const moduleFormat: ProjectProfile['language']['moduleFormat'] = packageType === 'module' && (!moduleSetting || !/commonjs/i.test(moduleSetting)) ? 'esm' : packageType === 'commonjs' || /commonjs/i.test(moduleSetting ?? '') ? 'commonjs' : packageType && moduleSetting ? 'mixed' : 'esm';
  const language: ProjectProfile['language'] = { name: dependencyVersion(allDependencies, 'typescript') || samples.some((path) => /\.(ts|tsx)$/.test(path)) ? 'typescript' : 'javascript', moduleFormat };
  const commands = PACKAGE_MANAGER_COMMANDS.filter((name) => isRecord(packageJson.scripts) && typeof packageJson.scripts[name] === 'string').map((name) => `${commandPrefix(packageJson)} ${name}`);
  for (const command of commands) addEvidence(evidence, 'package.json', 'package.json', `Validation command available: ${command}.`, 'high');

  const overrideRead = await readAllowlisted(projectRoot, '.blockbase/project.json', maxBytes);
  let override: JsonRecord | undefined;
  if (overrideRead?.text) {
    override = parseJson('.blockbase/project.json', overrideRead.text, 'override');
    addEvidence(evidence, '.blockbase/project.json', 'override', 'Explicit project inspection overrides were applied.', 'high');
  }
  const overrideFramework = override && overrideRecord(override, 'framework');
  const overrideStyling = override && overrideRecord(override, 'styling');
  const overrideTokens = override && overrideRecord(override, 'tokens');
  const overrideConventions = overrideConventionsValue(override && overrideRecord(override, 'conventions'));
  const overriddenValues = overrideTokens ? overrideStrings(overrideTokens, 'values') : undefined;
  const overriddenAliases = overrideTokens ? overrideStrings(overrideTokens, 'aliases') : undefined;
  const overriddenSystems = overrideStyling ? overrideStringArray(overrideStyling, 'systems') : undefined;
  const overriddenTokenFiles = overrideStyling ? overrideStringArray(overrideStyling, 'tokenFiles') : undefined;
  const overrideCommands = override ? overrideStringArray(override, 'validationCommands') : undefined;
  const finalValues = { ...values, ...overriddenValues };
  const finalAliases = { ...aliases, ...overriddenAliases };
  if (overriddenValues) for (const key of Object.keys(overriddenValues)) { delete finalAliases[key]; }
  const finalConflicts = conflicts.filter((conflict) => !overriddenValues || !Object.keys(overriddenValues).some((key) => conflict.startsWith(`Token ${key} `)));
  const conventionsOverride = overrideConventions ?? {};
  const finalFramework = overrideFrameworkValue(overrideFramework) ?? framework;
  if (['vue', 'svelte', 'angular', 'solid'].includes(finalFramework.name)) throw new ProjectInspectionError(PROJECT_ERROR_CODES.unsupportedFramework, `The destination framework '${finalFramework.name}' is not supported.`, { framework: finalFramework.name });
  const finalAlias = typeof conventionsOverride.importAlias === 'string' ? conventionsOverride.importAlias : tsAlias.alias;
  const finalDirectory = typeof conventionsOverride.componentDirectory === 'string' ? conventionsOverride.componentDirectory : componentDirectory;
  const finalCase = typeof conventionsOverride.filenameCase === 'string' && ['kebab', 'pascal', 'camel', 'mixed'].includes(conventionsOverride.filenameCase) ? conventionsOverride.filenameCase as ProjectProfile['conventions']['filenameCase'] : filenameCase(sampleNames);
  if (typeof conventionsOverride.componentDirectory === 'string') addEvidence(evidence, '.blockbase/project.json', 'override', `Component directory overridden to ${conventionsOverride.componentDirectory}.`, 'high');
  if (finalAlias) addEvidence(evidence, tsconfigEntry?.[0] ?? '.blockbase/project.json', tsconfigEntry ? 'config' : 'override', `Import alias selected: ${finalAlias}.`, finalAlias === tsAlias.alias ? 'high' : 'medium');
  evidence.sort((left, right) => left.path.localeCompare(right.path) || left.source.localeCompare(right.source) || left.fact.localeCompare(right.fact));
  return {
    schemaVersion: CONTRACT_VERSION,
    projectPath: projectRoot,
    framework: finalFramework,
    language,
    styling: { systems: overriddenSystems ?? systems, tokenFiles: overriddenTokenFiles ?? tokenFiles },
    tokens: { values: finalValues, aliases: finalAliases },
    dependencies: allDependencies,
    conventions: { componentDirectory: finalDirectory, filenameCase: finalCase, ...(finalAlias ? { importAlias: finalAlias } : {}) },
    validationCommands: overrideCommands ?? commands,
    evidence,
    conflicts: finalConflicts,
  };
}
