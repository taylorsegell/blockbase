import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { EXIT_CODES, type RecoveryAction } from '@blockbase/contracts';
import { failure, success } from '../output.js';
import { resolveCatalogRoot } from '../catalogRoot.js';
import { CliFailure } from '../errors.js';
import { canonicalAgentRoot, cliEntry } from '../paths.js';
import { catalogMarker, runSetup, uiMarker, type SetupIssue, type SetupResult } from '../setup.js';
import { AGENT_PROVIDERS, AGENT_SCOPES, generatedManifest, generatedProviderRoot, isAgentProvider, isAgentScope, providerRoot, PROVIDERS, type AgentProvider, type AgentScope } from './providers.js';

export const AGENT_SKILL_NAMES = ['blockbase', 'blockbase-capture', 'blockbase-inbox', 'blockbase-find-and-fit', 'blockbase-organize', 'blockbase-audit'] as const;

type LinkState = 'ok' | 'missing' | 'stale' | 'conflict';

type LinkSpec = {
  name: string;
  path: string;
  target: string;
};

type LinkInspection = LinkSpec & {
  state: LinkState;
  actualTarget?: string;
};

export type AgentHomeOptions = {
  home?: string;
  env?: NodeJS.ProcessEnv;
};

export type ProviderLifecycleOptions = AgentHomeOptions & {
  provider?: string;
  scope?: string;
  project?: string;
  mcp?: boolean;
  noSetup?: boolean;
};

export type AgentLinkResult = {
  home: string;
  executable: string;
  links: Array<LinkInspection & { action: 'created' | 'reused' | 'repaired' | 'blocked' }>;
  repairActions: RecoveryAction[];
};

function canonicalRoot(): string {
  return canonicalAgentRoot();
}

function executableTarget(): string {
  return cliEntry();
}

export function resolveAgentHome(options: AgentHomeOptions = {}): string {
  const raw = options.home ?? options.env?.BLOCKBASE_AGENT_HOME ?? process.env.BLOCKBASE_AGENT_HOME;
  return resolve(raw ?? join(homedir(), '.agents'));
}

function linkSpecs(home: string): LinkSpec[] {
  const sourceRoot = canonicalRoot();
  return [
    { name: 'blockbase', path: join(home, 'skills', 'blockbase'), target: sourceRoot },
    { name: 'blockbase-capture', path: join(home, 'skills', 'blockbase-capture'), target: join(sourceRoot, 'skills', 'blockbase-capture') },
    { name: 'blockbase-inbox', path: join(home, 'skills', 'blockbase-inbox'), target: join(sourceRoot, 'skills', 'blockbase-inbox') },
    { name: 'blockbase-find-and-fit', path: join(home, 'skills', 'blockbase-find-and-fit'), target: join(sourceRoot, 'skills', 'blockbase-find-and-fit') },
    { name: 'blockbase-organize', path: join(home, 'skills', 'blockbase-organize'), target: join(sourceRoot, 'skills', 'blockbase-organize') },
    { name: 'blockbase-audit', path: join(home, 'skills', 'blockbase-audit'), target: join(sourceRoot, 'skills', 'blockbase-audit') },
    { name: 'blockbase', path: join(home, 'bin', 'blockbase'), target: executableTarget() },
  ];
}

function inspectLink(spec: LinkSpec): LinkInspection {
  let stat;
  try {
    stat = lstatSync(spec.path);
  } catch {
    return { ...spec, state: 'missing' };
  }
  try {
    if (!stat.isSymbolicLink()) return { ...spec, state: 'conflict' };
    const actualTarget = resolve(dirname(spec.path), readlinkSync(spec.path));
    return { ...spec, actualTarget, state: actualTarget === spec.target && existsSync(spec.target) ? 'ok' : 'stale' };
  } catch {
    return { ...spec, state: 'conflict' };
  }
}

function repairCommand(home: string): string {
  return `blockbase agent link --home ${home}`;
}

function boundedRepairActions(home: string, links: LinkInspection[]): RecoveryAction[] {
  const broken = links.filter((link) => link.state !== 'ok');
  if (broken.length === 0) return [];
  const actions: RecoveryAction[] = [
    { id: 'relink', label: 'Repair missing or stale Blockbase links', safe: true, command: repairCommand(home) },
  ];
  if (broken.some((link) => link.state === 'conflict')) {
    actions.push({ id: 'resolve-conflict', label: 'Move conflicting regular files out of the Blockbase link slots', safe: false });
  }
  return actions.slice(0, 3);
}

function ensureLink(spec: LinkSpec): AgentLinkResult['links'][number] {
  const before = inspectLink(spec);
  if (before.state === 'ok') return { ...before, action: 'reused' };
  if (before.state === 'conflict') return { ...before, action: 'blocked' };
  mkdirSync(dirname(spec.path), { recursive: true });
  if (before.state === 'stale') unlinkSync(spec.path);
  symlinkSync(spec.target, spec.path, spec.target === executableTarget() ? 'file' : 'dir');
  return { ...inspectLink(spec), action: before.state === 'stale' ? 'repaired' : 'created' };
}

function unlinkSpec(spec: LinkSpec): AgentLinkResult['links'][number] {
  const before = inspectLink(spec);
  if (before.state === 'missing') return { ...before, action: 'reused' };
  if (before.state === 'conflict') return { ...before, action: 'blocked' };
  unlinkSync(spec.path);
  return { ...before, state: 'missing', action: 'repaired' };
}

export function runAgentLink(options: AgentHomeOptions = {}) {
  const home = resolveAgentHome(options);
  const links = linkSpecs(home).map(ensureLink);
  const blocked = links.filter((link) => link.action === 'blocked');
  const repairActions = boundedRepairActions(home, links);
  if (blocked.length > 0) {
    return {
      exitCode: EXIT_CODES.conflict,
      envelope: failure('agent.link', 'AGENT_LINK_CONFLICT', 'One or more agent link slots contain regular files.', { home, links }, [], repairActions),
    };
  }
  return { exitCode: EXIT_CODES.ok, envelope: success('agent.link', { home, executable: executableTarget(), links, repairActions }) };
}

export function runAgentCheck(options: AgentHomeOptions = {}) {
  const home = resolveAgentHome(options);
  const links = linkSpecs(home).map(inspectLink);
  const repairActions = boundedRepairActions(home, links);
  const healthy = links.every((link) => link.state === 'ok');
  const data = { home, executable: executableTarget(), healthy, skills: AGENT_SKILL_NAMES, links, repairActions };
  if (!healthy) {
    return {
      exitCode: EXIT_CODES.validationFailed,
      envelope: failure('agent.check', 'AGENT_LINKS_UNHEALTHY', 'Blockbase agent links are missing, stale, or blocked.', data, [], repairActions),
    };
  }
  return { exitCode: EXIT_CODES.ok, envelope: success('agent.check', data) };
}

export function runAgentUnlink(options: AgentHomeOptions = {}) {
  const home = resolveAgentHome(options);
  const links = linkSpecs(home).map(unlinkSpec);
  const blocked = links.filter((link) => link.action === 'blocked');
  const repairActions = blocked.length > 0 ? boundedRepairActions(home, links) : [];
  if (blocked.length > 0) {
    return {
      exitCode: EXIT_CODES.conflict,
      envelope: failure('agent.unlink', 'AGENT_UNLINK_CONFLICT', 'One or more agent link slots contain regular files.', { home, links }, [], repairActions),
    };
  }
  return { exitCode: EXIT_CODES.ok, envelope: success('agent.unlink', { home, links, repairActions }) };
}

type ProviderMode = 'copy' | 'link';
type ProviderRecord = { path: string; kind: 'file' | 'symlink'; source?: string };
type InstallationInventory = {
  schemaVersion: '1';
  provider: AgentProvider;
  scope: AgentScope;
  mode: ProviderMode;
  version: string;
  sourceHash: string;
  records: ProviderRecord[];
  setup?: SetupRecord;
};
type SetupRecord = { ran: boolean; catalog?: string; service?: string; url?: string };

const INVENTORY_NAME = '.blockbase-install.json';

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function filesUnder(root: string, current = root): string[] {
  if (!existsSync(current)) return [];
  const entries = readdirSync(current, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(current, entry.name);
    return entry.isDirectory() ? filesUnder(root, path) : [relative(root, path)];
  });
}

function readInventory(root: string): InstallationInventory | undefined {
  const path = join(root, INVENTORY_NAME);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<InstallationInventory>;
    if (parsed.schemaVersion !== '1' || !isAgentProvider(parsed.provider) || !isAgentScope(parsed.scope) || (parsed.mode !== 'copy' && parsed.mode !== 'link') || typeof parsed.version !== 'string' || typeof parsed.sourceHash !== 'string' || !Array.isArray(parsed.records)) return undefined;
    return { schemaVersion: '1', provider: parsed.provider, scope: parsed.scope, mode: parsed.mode, version: parsed.version, sourceHash: parsed.sourceHash, records: parsed.records.filter((record): record is ProviderRecord => Boolean(record && typeof record.path === 'string' && (record.kind === 'file' || record.kind === 'symlink'))), ...(parsed.setup && typeof parsed.setup === 'object' && typeof (parsed.setup as SetupRecord).ran === 'boolean' ? { setup: parsed.setup as SetupRecord } : {}) };
  } catch {
    return undefined;
  }
}

function inventoryPath(root: string): string {
  return join(root, INVENTORY_NAME);
}

function providerOptions(options: ProviderLifecycleOptions, operation: 'agent.check' | 'agent.install' | 'agent.update' | 'agent.remove' | 'agent.link' = 'agent.check'): { provider: AgentProvider; scope: AgentScope; root: string } | { error: ReturnType<typeof failure> } {
  if (!isAgentProvider(options.provider)) {
    return { error: failure(operation, 'AGENT_PROVIDER_UNSUPPORTED', `Provider must be one of: ${AGENT_PROVIDERS.join(', ')}.`, { provider: options.provider ?? null, supportedProviders: AGENT_PROVIDERS }, [], [{ id: 'choose-provider', label: 'Choose a supported agent provider', safe: true }]) };
  }
  if (!isAgentScope(options.scope)) {
    return { error: failure(operation, 'AGENT_SCOPE_UNSUPPORTED', `Scope must be one of: ${AGENT_SCOPES.join(', ')}.`, { scope: options.scope ?? null, supportedScopes: AGENT_SCOPES }, [], [{ id: 'choose-scope', label: 'Choose project or global scope', safe: true }]) };
  }
  const spec = PROVIDERS[options.provider];
  if ((options.scope === 'project' && !spec.supportsProject) || (options.scope === 'global' && !spec.supportsGlobal)) {
    return { error: failure(operation, 'AGENT_SCOPE_UNSUPPORTED', `${options.provider} does not support ${options.scope} scope.`, { provider: options.provider, scope: options.scope, supportedScopes: [spec.supportsProject ? 'project' : null, spec.supportsGlobal ? 'global' : null].filter(Boolean) }) };
  }
  if (options.scope === 'project' && !options.project && !options.home) {
    return { error: failure(operation, 'AGENT_PROJECT_REQUIRED', 'Project scope requires --project.', {}, [], [{ id: 'choose-project', label: 'Pass the project path', safe: true, command: 'blockbase agent install --scope project --project <path>' }]) };
  }
  return { provider: options.provider, scope: options.scope, root: providerRoot(options.provider, options.scope, options) };
}

function providerInventory(root: string, provider: AgentProvider, scope: AgentScope, mode: ProviderMode, version: string, sourceHash: string, records: ProviderRecord[], setup?: SetupRecord): InstallationInventory {
  return { schemaVersion: '1', provider, scope, mode, version, sourceHash, records, ...(setup ? { setup } : {}) };
}

function targetExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function removeOwnedPath(path: string): 'removed' | 'blocked' | 'missing' {
  if (!targetExists(path)) return 'missing';
  const stat = lstatSync(path);
  if (stat.isDirectory() && !stat.isSymbolicLink()) return 'blocked';
  if (stat.isSymbolicLink()) unlinkSync(path);
  else rmSync(path, { force: true });
  return 'removed';
}

function providerRecords(provider: AgentProvider, mode: ProviderMode): ProviderRecord[] {
  const generated = generatedProviderRoot(provider);
  const spec = PROVIDERS[provider];
  // bin/ and hooks/ are Claude Code plugin-marketplace runtime files; installs write their own bin/blockbase link.
  const payload = filesUnder(generated).filter((path) => !/^(bin|hooks)[\\/]/.test(path)).map((path) => ({ path, kind: 'file' as const, source: join(generated, path) }));
  const skillRecords = spec.skillRoot === 'skills' ? payload.filter((record) => record.path.startsWith('skills/')) : payload;
  if (mode === 'copy') return [...payload, { path: 'bin/blockbase', kind: 'symlink', source: executableTarget() }];
  return [
    ...AGENT_SKILL_NAMES.map((name) => ({ path: join(spec.skillRoot, name), kind: 'symlink' as const, source: join(generated, spec.skillRoot, name) })),
    { path: 'bin/blockbase', kind: 'symlink' as const, source: executableTarget() },
  ].filter((record) => record.source && (record.path.startsWith(`${spec.skillRoot}/`) ? skillRecords.some((payloadRecord) => payloadRecord.path === `${spec.skillRoot}/${record.path.slice(spec.skillRoot.length + 1)}/SKILL.md`) : true));
}

function createProviderLink(root: string, records: ProviderRecord[], prior: InstallationInventory | undefined): { records: ProviderRecord[]; conflicts: string[]; changes: Array<{ path: string; action: string }> } {
  const conflicts: string[] = [];
  const changes: Array<{ path: string; action: string }> = [];
  const owned = new Set(prior?.records.map((record) => record.path) ?? []);
  for (const record of records) {
    const target = join(root, record.path);
    if (targetExists(target) && lstatSync(target).isDirectory() && !lstatSync(target).isSymbolicLink() && readdirSync(target).length === 0) {
      rmSync(target, { force: true, recursive: true });
    }
    if (targetExists(target) && !owned.has(record.path)) {
      const stat = lstatSync(target);
      const actual = stat.isSymbolicLink() ? resolve(dirname(target), readlinkSync(target)) : undefined;
      if (actual !== record.source) conflicts.push(record.path);
      else changes.push({ path: record.path, action: 'reused' });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    if (targetExists(target)) rmSync(target, { force: true, recursive: true });
    symlinkSync(record.source!, target, record.path === 'bin/blockbase' ? 'file' : 'dir');
    changes.push({ path: record.path, action: owned.has(record.path) ? 'repaired' : 'created' });
  }
  return { records, conflicts, changes };
}

function writeInventory(root: string, inventory: InstallationInventory): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(inventoryPath(root), `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
}

type McpState = {
  provider: AgentProvider;
  state: 'enabled' | 'disabled' | 'broken' | 'present-unmanaged';
  configPath: string;
  reason: string;
};

function mcpState(root: string, provider: AgentProvider): McpState {
  const configPath = join(root, PROVIDERS[provider].mcpConfig);
  if (!existsSync(configPath)) return { provider, state: 'disabled', configPath, reason: 'MCP is optional; this installation is CLI-only.' };
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return { provider, state: 'broken', configPath, reason: 'MCP configuration is not valid JSON.' };
  }
  const server = config && typeof config === 'object' && !Array.isArray(config)
    ? (config as { mcpServers?: unknown }).mcpServers
    : undefined;
  const blockbase = server && typeof server === 'object' && !Array.isArray(server)
    ? (server as { blockbase?: unknown }).blockbase
    : undefined;
  if (!blockbase) return { provider, state: 'present-unmanaged', configPath, reason: 'An MCP configuration exists but does not declare the Blockbase server.' };
  if (typeof blockbase !== 'object' || blockbase === null || Array.isArray(blockbase)) return { provider, state: 'broken', configPath, reason: 'The Blockbase MCP server entry is malformed.' };
  const command = (blockbase as { command?: unknown }).command;
  const args = (blockbase as { args?: unknown }).args;
  const valid = (command === executableTarget() || command === join(root, 'bin', 'blockbase')) && Array.isArray(args) && args[0] === 'mcp';
  return valid
    ? { provider, state: 'enabled', configPath, reason: 'The Blockbase MCP server is configured for this installation.' }
    : { provider, state: 'broken', configPath, reason: 'The Blockbase MCP server entry does not point to this installation.' };
}

function configureMcp(root: string, provider: AgentProvider): { state: McpState; created: boolean } | { conflict: string } {
  const state = mcpState(root, provider);
  if (state.state === 'enabled') return { state, created: false };
  if (state.state !== 'disabled') return { conflict: state.configPath };
  const configPath = state.configPath;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({ mcpServers: { blockbase: { command: executableTarget(), args: ['mcp'] } } }, null, 2)}\n`, 'utf8');
  return { state: mcpState(root, provider), created: true };
}

function lifecycleResult(operation: 'agent.install' | 'agent.update' | 'agent.remove' | 'agent.link', root: string, provider: AgentProvider, scope: AgentScope, data: Record<string, unknown>, exitCode: number = EXIT_CODES.ok) {
  return { exitCode, envelope: exitCode === EXIT_CODES.ok ? success(operation, { schemaVersion: '1', provider, scope, root, ...data }) : failure(operation, String(data.code ?? 'AGENT_LIFECYCLE_FAILED'), String(data.message ?? 'Agent lifecycle operation failed.'), { provider, scope, root, ...data.details as Record<string, unknown> ?? {} }, [], (data.repairActions as RecoveryAction[] | undefined) ?? []) };
}

function providerError(error: ReturnType<typeof failure>) {
  return { exitCode: error.error.code.endsWith('_UNSUPPORTED') ? EXIT_CODES.unsupported : EXIT_CODES.usage, envelope: error };
}

async function providerInstall(options: ProviderLifecycleOptions, operation: 'agent.install' | 'agent.update') {
  const resolved = providerOptions(options, operation);
  if ('error' in resolved) return providerError(resolved.error);
  const { provider, scope, root } = resolved;
  const manifest = generatedManifest(provider);
  const prior = readInventory(root);
  if (prior && (prior.provider !== provider || prior.scope !== scope)) return lifecycleResult(operation, root, provider, scope, { code: 'AGENT_OWNERSHIP_CONFLICT', message: 'The target is owned by a different Blockbase provider or scope.', details: { existing: prior } }, EXIT_CODES.conflict);
  const records = providerRecords(provider, 'copy');
  const owned = new Set(prior?.records.map((record) => record.path) ?? []);
  const conflicts = records.filter((record) => targetExists(join(root, record.path)) && !owned.has(record.path)).map((record) => record.path);
  if (conflicts.length > 0) return lifecycleResult(operation, root, provider, scope, { code: 'AGENT_INSTALL_CONFLICT', message: 'Installation would overwrite unrelated user files.', details: { conflicts } }, EXIT_CODES.conflict);
  if (options.mcp && mcpState(root, provider).state !== 'disabled' && mcpState(root, provider).state !== 'enabled') return lifecycleResult(operation, root, provider, scope, { code: 'AGENT_MCP_CONFLICT', message: 'MCP configuration exists but is not a valid Blockbase configuration.', details: { mcp: mcpState(root, provider) } }, EXIT_CODES.conflict);
  mkdirSync(root, { recursive: true });
  for (const record of records) {
    const target = join(root, record.path);
    mkdirSync(dirname(target), { recursive: true });
    if (record.kind === 'symlink') {
      if (targetExists(target)) rmSync(target, { force: true, recursive: true });
      symlinkSync(record.source!, target, 'file');
    } else cpSync(record.source!, target, { force: true });
  }
  if (options.mcp) configureMcp(root, provider);
  writeInventory(root, providerInventory(root, provider, scope, 'copy', manifest.version, manifest.sourceHash, records, prior?.setup));
  const setup = await runInstallSetup(options, root, provider, scope, manifest, records, prior);
  return lifecycleResult(operation, root, provider, scope, { version: manifest.version, sourceHash: manifest.sourceHash, mode: 'copy', records, inventoryPath: inventoryPath(root), mcp: mcpState(root, provider), setup: setup.record, ...(setup.error ? { setupError: setup.error } : {}), ...(setup.issues.length > 0 ? { issues: setup.issues } : {}), repairActions: [] });
}

/**
 * Runs `setup` after an install or update unless the caller opted out. Setup problems never fail
 * the install: they are reported in the result and left for `blockbase setup` to repair.
 */
async function runInstallSetup(options: ProviderLifecycleOptions, root: string, provider: AgentProvider, scope: AgentScope, manifest: { version: string; sourceHash: string }, records: ProviderRecord[], prior: InstallationInventory | undefined): Promise<{ record: SetupRecord; issues: SetupIssue[]; error?: { code: string; message: string } }> {
  const skipped = (error?: { code: string; message: string }) => {
    const record = prior?.setup ?? { ran: false };
    if (!prior?.setup) writeInventory(root, providerInventory(root, provider, scope, 'copy', manifest.version, manifest.sourceHash, records, record));
    return { record, issues: [], ...(error ? { error } : {}) };
  };
  if (options.noSetup || options.home || process.env.CI) return skipped();
  try {
    const result: SetupResult = await runSetup({ catalogRoot: resolveCatalogRoot(undefined) });
    const record: SetupRecord = { ran: true, catalog: result.catalog, service: result.service, url: result.url };
    writeInventory(root, providerInventory(root, provider, scope, 'copy', manifest.version, manifest.sourceHash, records, record));
    // Setup keeps going after a failed service refresh; its issues (with repair commands) are passed on.
    return { record, issues: result.issues };
  } catch (error) {
    if (error instanceof CliFailure) return skipped({ code: error.code, message: error.message });
    throw error;
  }
}

export function runAgentProviderLink(options: ProviderLifecycleOptions, operation: 'agent.link' | 'agent.update' = 'agent.link') {
  const resolved = providerOptions(options, operation);
  if ('error' in resolved) return providerError(resolved.error);
  const { provider, scope, root } = resolved;
  const manifest = generatedManifest(provider);
  const prior = readInventory(root);
  const linked = createProviderLink(root, providerRecords(provider, 'link'), prior);
  if (linked.conflicts.length > 0) return lifecycleResult(operation, root, provider, scope, { code: 'AGENT_LINK_CONFLICT', message: 'Local linking would overwrite unrelated user files.', details: { conflicts: linked.conflicts } }, EXIT_CODES.conflict);
  if (options.mcp && mcpState(root, provider).state !== 'disabled' && mcpState(root, provider).state !== 'enabled') return lifecycleResult(operation, root, provider, scope, { code: 'AGENT_MCP_CONFLICT', message: 'MCP configuration exists but is not a valid Blockbase configuration.', details: { mcp: mcpState(root, provider) } }, EXIT_CODES.conflict);
  if (options.mcp) configureMcp(root, provider);
  writeInventory(root, providerInventory(root, provider, scope, 'link', manifest.version, manifest.sourceHash, linked.records, prior?.setup));
  return lifecycleResult(operation, root, provider, scope, { version: manifest.version, sourceHash: manifest.sourceHash, mode: 'link', records: linked.records.map((record, index) => ({ ...record, action: linked.changes[index]?.action ?? 'reused' })), inventoryPath: inventoryPath(root), mcp: mcpState(root, provider), repairActions: [] });
}

export async function runAgentProviderInstall(options: ProviderLifecycleOptions) { return providerInstall(options, 'agent.install'); }
export async function runAgentProviderUpdate(options: ProviderLifecycleOptions) {
  const resolved = providerOptions(options, 'agent.update');
  if ('error' in resolved) return providerError(resolved.error);
  const prior = readInventory(resolved.root);
  if (prior?.mode === 'link') return runAgentProviderLink(options, 'agent.update');
  return providerInstall(options, 'agent.update');
}

export async function runAgentProviderCheck(options: ProviderLifecycleOptions) {
  const resolved = providerOptions(options, 'agent.check');
  if ('error' in resolved) return providerError(resolved.error);
  const { provider, scope, root } = resolved;
  const manifest = generatedManifest(provider);
  const inventory = readInventory(root);
  const issues: string[] = [];
  const mcp = mcpState(root, provider);
  const checks: Record<string, unknown> = { cli: 'missing', generatedPayload: 'missing', link: 'missing', version: 'missing', mcp };
  if (mcp.state === 'broken') issues.push('mcp-configuration-broken');
  if (!inventory) issues.push(targetExists(inventoryPath(root)) ? 'invalid-installation-inventory' : 'installation-missing');
  else {
    checks.version = inventory.version === manifest.version ? 'compatible' : 'incompatible';
    if (checks.version === 'incompatible') issues.push('incompatible-version');
    const expected = providerRecords(provider, inventory.mode);
    const payloadStale = inventory.sourceHash !== manifest.sourceHash || (inventory.mode === 'copy' && expected.some((record) => !targetExists(join(root, record.path)) || (record.kind === 'file' && hashFile(join(root, record.path)) !== hashFile(record.source!))));
    checks.generatedPayload = payloadStale ? 'stale' : 'current';
    if (payloadStale) issues.push('stale-generated-payload');
    const executable = join(root, 'bin/blockbase');
    const cliHealthy = targetExists(executable) && lstatSync(executable).isSymbolicLink() && resolve(dirname(executable), readlinkSync(executable)) === executableTarget() && existsSync(executableTarget());
    checks.cli = cliHealthy ? 'present' : 'missing';
    const linksHealthy = cliHealthy && expected.every((record) => {
      const target = join(root, record.path);
      return targetExists(target) && lstatSync(target).isSymbolicLink() && resolve(dirname(target), readlinkSync(target)) === record.source && existsSync(record.source!);
    });
    checks.link = inventory.mode === 'link' ? (linksHealthy ? 'ok' : 'broken') : 'not-applicable';
    if (!cliHealthy) issues.push('missing-cli');
    if (checks.link === 'broken') issues.push('broken-link');
  }
  const catalogRoot = resolveCatalogRoot(undefined);
  const catalogState = catalogMarker(catalogRoot);
  const uiState = await uiMarker(catalogRoot);
  checks.catalog = catalogState;
  checks.ui = uiState;
  // Catalog and page health only count when this installation actually ran setup.
  const setupUnhealthy = inventory?.setup?.ran === true && (catalogState !== 'present' || uiState !== 'running');
  if (setupUnhealthy) {
    if (catalogState === 'missing') issues.push('catalog-missing');
    if (catalogState === 'legacy') issues.push('catalog-legacy');
    if (uiState === 'absent') issues.push('ui-absent');
    if (uiState === 'installed') issues.push('ui-not-running');
  }
  const repairActions: RecoveryAction[] = inventory?.mode === 'link'
    ? [{ id: 'relink', label: 'Repair Blockbase links', safe: true, command: `blockbase agent link --provider ${provider} --scope ${scope}${options.project ? ` --project ${resolve(options.project)}` : ''}` }]
    : [{ id: 'update', label: 'Refresh the owned generated provider payload', safe: true, command: `blockbase agent update --provider ${provider} --scope ${scope}${options.project ? ` --project ${resolve(options.project)}` : ''}` }];
  if (setupUnhealthy) repairActions.unshift({ id: 'setup', label: 'Create the catalog and start the catalog page', safe: false, command: 'blockbase setup --json' });
  if (mcp.state === 'broken') repairActions.push({ id: 'repair-mcp', label: 'Repair the Blockbase MCP configuration after reviewing the existing file', safe: false });
  const data = { schemaVersion: '1', provider, scope, root, healthy: issues.length === 0, inventory, checks, issues, repairActions: issues.length > 0 ? repairActions.slice(0, 3) : [] };
  if (issues.length > 0) return { exitCode: EXIT_CODES.validationFailed, envelope: failure('agent.check', 'AGENT_INSTALLATION_UNHEALTHY', 'Blockbase agent installation requires attention.', data, [], data.repairActions) };
  return { exitCode: EXIT_CODES.ok, envelope: success('agent.check', data) };
}

export function runAgentProviderRemove(options: ProviderLifecycleOptions) {
  const resolved = providerOptions(options, 'agent.remove');
  if ('error' in resolved) return providerError(resolved.error);
  const { provider, scope, root } = resolved;
  const inventory = readInventory(root);
  if (!inventory) return lifecycleResult('agent.remove', root, provider, scope, { removed: [], preserved: [], repairActions: [] });
  const preserved: string[] = [];
  const removed: string[] = [];
  for (const record of inventory.records) {
    const result = removeOwnedPath(join(root, record.path));
    if (result === 'blocked') preserved.push(record.path);
    else if (result === 'removed') removed.push(record.path);
  }
  if (preserved.length > 0) return lifecycleResult('agent.remove', root, provider, scope, { code: 'AGENT_REMOVE_CONFLICT', message: 'Removal preserved unexpected directories in owned slots.', details: { preserved, removed } }, EXIT_CODES.conflict);
  rmSync(inventoryPath(root), { force: true });
  return lifecycleResult('agent.remove', root, provider, scope, { removed, preserved, inventoryPath: inventoryPath(root), ...(inventory.setup?.ran ? { hint: 'blockbase ui service uninstall --json' } : {}), repairActions: [] });
}
