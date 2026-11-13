#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXIT_CODES,
  type CliWarning,
  type ExitCode,
  type OperationName,
  parseProjectProfile,
  type RecoveryAction,
  SOURCE_TYPES,
  type SourceType,
} from '@blockbase/contracts';
import {
  catalogHistoryHealth,
  diagnoseIndex,
  IndexError,
  importSource,
  importSourceWithExtras,
  importPaste,
  type ImportExtras,
  ImportError,
  inspectComponent,
  rebuildIndex,
  readLegacyCatalog,
  resolveCatalog,
  inspectProject,
  ProjectInspectionError,
  searchComponents,
  prepareComponentAdaptation,
  createApplyPlan,
  applyAdaptation,
  readAdaptationBundle,
  validateAdaptation,
  AdaptationError,
  ValidationError,
  type CatalogDiagnostic,
  type CatalogResolution,
  type CatalogResolutionOptions,
  type LegacyCatalogInventory,
  planLegacyMigration,
  applyLegacyMigration,
  resumeLegacyMigration,
  deriveThemeFromProject,
  ThemeError,
  ThemeValidationError,
  ThemeRegistry,
  inspectProject as inspectThemeProject,
  parseThemeManifest,
  readThemeManifest,
  validateTheme,
  writeStarterTheme,
  type MigrationOptions,
  createRemoteCatalogClient,
  createRemoteCatalogSource,
  REMOTE_CATALOG_ERROR_CODES,
  RemoteCatalogError,
  type CatalogSource,
  type RemoteCatalogClient,
  type RemoteCatalogErrorCode,
  type RemoteSearchFilters,
} from '@blockbase/core';
import { runAgentCheck, runAgentLink, runAgentProviderCheck, runAgentProviderInstall, runAgentProviderLink, runAgentProviderRemove, runAgentProviderUpdate, runAgentUnlink } from './agent/lifecycle.js';
import { isHelpRequest, renderHelp } from './help.js';
import { executeLibrary } from './library.js';
import { listCatalog } from './catalogList.js';
import { resolveCatalogRoot } from './catalogRoot.js';
import { CliFailure } from './errors.js';
import { runSetup } from './setup.js';
import { installService, serviceStatus, uninstallService, DEFAULT_UI_PORT } from './service/index.js';
import { configuredPort, runUi, runUiStatus } from './ui.js';
import { OPERATION_REGISTRY } from './registry.js';
import { failure, success, themeFailure, themeSuccess, writeDiagnostic, writeJson } from './output.js';

type ParsedArgs = {
  operation: CliOperation;
  catalog?: string;
  home?: string;
  provider?: string;
  scope?: string;
  source?: string;
  manifest?: string;
  entryPoint?: string;
  namespace?: string;
  slug?: string;
  displayName?: string;
  cwd?: string;
  revision?: string;
  project?: string;
  profile?: string;
  framework?: string;
  language?: string;
  runtime?: string;
  stylingModes?: string[];
  limit?: number;
  confidenceMargin?: number;
  out?: string;
  dryRun: boolean;
  apply: boolean;
  json: boolean;
  target?: string;
  baseline?: string;
  resume?: string;
  mcp: boolean;
  path?: string;
  tags: string[];
  from?: '21st';
  demo?: string;
  sourceType?: SourceType;
  sourceUrl?: string;
  license?: string;
  author?: string;
  id?: string;
  title?: string;
  family?: string;
  create: boolean;
  index?: number;
  steps?: number;
  to?: string;
  port?: number;
  allowedHosts: string[];
  open: boolean;
  noService: boolean;
  noSetup: boolean;
};

type CliOperation = OperationName | 'theme.init' | 'theme.validate' | 'theme.add' | 'theme.derive';

class UsageError extends Error {
  readonly operation: CliOperation;

  constructor(operation: CliOperation, message: string) {
    super(message);
    this.name = 'UsageError';
    this.operation = operation;
  }
}

/**
 * Operations that can be served from a remote catalog (`BLOCKBASE_REMOTE_URL`) instead of a local
 * disk catalog. `add`'s destination writes always stay local (task 5.3's proven invariant) — only
 * *catalog resolution* moves; nothing here changes where a project is read from or written to.
 */
const REMOTE_CAPABLE_OPERATIONS = new Set<CliOperation>(['search', 'inspect', 'adapt', 'add']);

/**
 * Operations that mutate or diagnose the local catalog on disk. The saga's locked decision is
 * that this surface is permanently catalog-host-local — these never run remotely, and must fail
 * loudly (rather than silently ignoring a configured `BLOCKBASE_REMOTE_URL`) when remote
 * configuration is present, so a misconfigured shell never runs a maintenance command against the
 * wrong catalog without the operator noticing.
 */
const LOCAL_ONLY_CATALOG_OPERATIONS = new Set<CliOperation>([
  'doctor',
  'catalog.locate',
  'catalog.list',
  'catalog.validate',
  'catalog.migrate',
  'catalog.rebuild',
  'import',
  'theme.add',
]);

type RemoteConfig = { url: string; token: string };

/**
 * Reads `BLOCKBASE_REMOTE_URL`/`BLOCKBASE_MCP_TOKEN` and validates them against `operation`,
 * throwing a bounded `UsageError` (surfaced exactly like any other CLI argument problem) rather
 * than ever silently picking a mode or proceeding without a required credential. Returns
 * `undefined` for local mode (no `BLOCKBASE_REMOTE_URL` configured, or an operation the remote
 * surface never touches, e.g. `project.inspect`/`validate`/`agent.*`/`ui`). This is the single
 * place that reads either environment variable — nothing downstream re-reads them.
 */
function resolveRemoteConfig(operation: CliOperation, catalog: string | undefined): RemoteConfig | undefined {
  const url = process.env.BLOCKBASE_REMOTE_URL;
  if (!url) return undefined;
  if (LOCAL_ONLY_CATALOG_OPERATIONS.has(operation) || operation.startsWith('inbox.') || operation.startsWith('tag.') || operation.startsWith('collection.') || operation.startsWith('family.') || operation.startsWith('history.')) {
    throw new UsageError(operation, `'${operation}' is a local catalog-host operation and cannot run with BLOCKBASE_REMOTE_URL set; unset BLOCKBASE_REMOTE_URL or run this command on the catalog host.`);
  }
  if (!REMOTE_CAPABLE_OPERATIONS.has(operation)) return undefined;
  if (catalog !== undefined) {
    throw new UsageError(operation, '--catalog and BLOCKBASE_REMOTE_URL are mutually exclusive; unset one.');
  }
  const token = process.env.BLOCKBASE_MCP_TOKEN;
  if (!token) {
    throw new UsageError(operation, 'BLOCKBASE_MCP_TOKEN is required (and must be non-empty) when BLOCKBASE_REMOTE_URL is set.');
  }
  return { url, token };
}

type CatalogAccess =
  | { mode: 'local' }
  | { mode: 'remote'; client: RemoteCatalogClient; source: CatalogSource };

const REMOTE_CATALOG_EXIT_CODES: Record<RemoteCatalogErrorCode, ExitCode> = {
  [REMOTE_CATALOG_ERROR_CODES.unauthorized]: EXIT_CODES.invalidInput,
  [REMOTE_CATALOG_ERROR_CODES.unavailable]: EXIT_CODES.internal,
  [REMOTE_CATALOG_ERROR_CODES.protocolInvalid]: EXIT_CODES.internal,
  [REMOTE_CATALOG_ERROR_CODES.notFound]: EXIT_CODES.notFound,
  [REMOTE_CATALOG_ERROR_CODES.integrityInvalid]: EXIT_CODES.validationFailed,
  [REMOTE_CATALOG_ERROR_CODES.remoteError]: EXIT_CODES.internal,
};

/** A small, fixed, always-safe recovery action set per remote failure category. Never includes the token. */
function remoteCatalogRecoveryActions(error: RemoteCatalogError): RecoveryAction[] {
  switch (error.code) {
    case REMOTE_CATALOG_ERROR_CODES.unauthorized:
      return [{ id: 'check-remote-token', label: 'Verify BLOCKBASE_MCP_TOKEN is a currently valid credential for BLOCKBASE_REMOTE_URL', safe: true }];
    case REMOTE_CATALOG_ERROR_CODES.unavailable:
      return [{ id: 'retry-remote', label: 'Verify BLOCKBASE_REMOTE_URL is reachable, then retry', safe: true }];
    case REMOTE_CATALOG_ERROR_CODES.notFound:
      return [{ id: 'search-remote-catalog', label: 'Search the remote catalog for the correct component id', safe: true, command: 'blockbase search "<query>" --json' }];
    case REMOTE_CATALOG_ERROR_CODES.integrityInvalid:
      return [{ id: 'retry-remote-integrity', label: 'Retry the request; if this persists, contact the catalog operator', safe: true }];
    case REMOTE_CATALOG_ERROR_CODES.protocolInvalid:
      return [{ id: 'check-remote-version', label: 'Verify the remote catalog server version is compatible with this CLI', safe: true }];
    default:
      return [];
  }
}

/** Maps a `RemoteCatalogError` to this CLI's stable JSON error envelope, following the existing `failure(...)` convention. */
function remoteCatalogFailure(operation: OperationName, error: RemoteCatalogError): { exitCode: ExitCode; envelope: ReturnType<typeof failure> } {
  const code = `REMOTE_${error.code.toUpperCase().replaceAll('-', '_')}`;
  return {
    exitCode: REMOTE_CATALOG_EXIT_CODES[error.code] ?? EXIT_CODES.internal,
    envelope: failure(operation, code, error.message, error.details, [], remoteCatalogRecoveryActions(error)),
  };
}

/**
 * Derives the wire filters sent to a remote `search` — never a project path (see `RemoteSearchOptions.projectPath`
 * on `RemoteCatalogClient`, deliberately unused here). Any `--project`/`--profile` compatibility input is
 * resolved locally first (`compatibilityInput`, pure disk reads on the laptop) and only its bounded
 * framework/language/stylingModes facts cross the wire, matching task 5.3's own "never send a project path
 * remotely" invariant at this layer too.
 */
async function remoteSearchFilters(parsed: ParsedArgs): Promise<RemoteSearchFilters> {
  const compatibility = await compatibilityInput(parsed);
  const project = compatibility?.project;
  const framework = compatibility?.framework ?? project?.framework.name;
  const language = compatibility?.language ?? project?.language.name;
  const stylingModes = compatibility?.stylingModes ?? project?.styling.systems;
  return {
    ...(framework ? { framework } : {}),
    ...(language ? { language } : {}),
    ...(compatibility?.runtime ? { runtime: compatibility.runtime } : {}),
    ...(stylingModes && stylingModes.length > 0 ? { stylingModes } : {}),
    ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
    ...(parsed.confidenceMargin !== undefined ? { confidenceMargin: parsed.confidenceMargin } : {}),
  };
}

const MISSING_CATALOG_ACTIONS: RecoveryAction[] = [
  {
    id: 'choose-catalog',
    label: 'Pass --catalog with an explicit path',
    safe: true,
    command: 'blockbase catalog locate --catalog <path> --json',
  },
  {
    id: 'set-catalog-home',
    label: 'Set BLOCKBASE_HOME to the catalog directory',
    safe: true,
    command: 'BLOCKBASE_HOME=<path> blockbase catalog locate --json',
  },
];

function operationFromTokens(args: string[]): CliOperation {
  if (args[0] === 'setup') return 'setup';
  if (args[0] === 'ui' && args[1] === 'status') return 'ui.status';
  if (args[0] === 'ui' && args[1] === 'service' && (args[2] === 'install' || args[2] === 'uninstall' || args[2] === 'status')) return `ui.service.${args[2]}`;
  if (args[0] === 'ui') return 'ui';
  if (args[0] === 'import') return 'import';
  if (args[0] === 'project' && args[1] === 'inspect') return 'project.inspect';
  if (args[0] === 'search') return 'search';
  if (args[0] === 'inspect') return 'inspect';
  if (args[0] === 'adapt') return 'adapt';
  if (args[0] === 'add') return 'add';
  if (args[0] === 'validate') return 'validate';
  if (args[0] === 'theme' && args[1] === 'init') return 'theme.init';
  if (args[0] === 'theme' && args[1] === 'validate') return 'theme.validate';
  if (args[0] === 'theme' && args[1] === 'add') return 'theme.add';
  if (args[0] === 'theme' && args[1] === 'derive') return 'theme.derive';
  if (args[0] === 'catalog' && args[1] === 'rebuild') return 'catalog.rebuild';
  if (args[0] === 'catalog' && args[1] === 'validate') return 'catalog.validate';
  if (args[0] === 'catalog' && args[1] === 'locate') return 'catalog.locate';
  if (args[0] === 'catalog' && args[1] === 'list') return 'catalog.list';
  if (args[0] === 'catalog' && args[1] === 'migrate') return 'catalog.migrate';
  if (args[0] === 'inbox' && (args[1] === 'add' || args[1] === 'list' || args[1] === 'show' || args[1] === 'import' || args[1] === 'discard')) return `inbox.${args[1]}`;
  if (args[0] === 'tag' && (args[1] === 'add' || args[1] === 'remove' || args[1] === 'list')) return `tag.${args[1]}`;
  if (args[0] === 'collection' && (args[1] === 'create' || args[1] === 'add' || args[1] === 'remove' || args[1] === 'reorder' || args[1] === 'delete' || args[1] === 'list')) return `collection.${args[1]}`;
  if (args[0] === 'family' && (args[1] === 'set' || args[1] === 'list')) return `family.${args[1]}`;
  if (args[0] === 'history' && (args[1] === 'list' || args[1] === 'undo' || args[1] === 'restore')) return `history.${args[1]}`;
  if (args[0] === 'agent' && args[1] === 'link') return 'agent.link';
  if (args[0] === 'agent' && args[1] === 'check') return 'agent.check';
  if (args[0] === 'agent' && args[1] === 'unlink') return 'agent.unlink';
  if (args[0] === 'agent' && args[1] === 'install') return 'agent.install';
  if (args[0] === 'agent' && args[1] === 'update') return 'agent.update';
  if (args[0] === 'agent' && args[1] === 'remove') return 'agent.remove';
  if (args[0] === 'doctor') return 'doctor';
  return 'doctor';
}

function parseArgs(args: string[]): ParsedArgs {
  const operation = operationFromTokens(args);
  const positional: string[] = [];
  let catalog: string | undefined;
  let home: string | undefined;
  let provider: string | undefined;
  let scope: string | undefined;
  let source: string | undefined;
  let manifest: string | undefined;
  let entryPoint: string | undefined;
  let namespace: string | undefined;
  let slug: string | undefined;
  let displayName: string | undefined;
  let cwd: string | undefined;
  let revision: string | undefined;
  let project: string | undefined;
  let profile: string | undefined;
  let framework: string | undefined;
  let language: string | undefined;
  let runtime: string | undefined;
  const stylingModes: string[] = [];
  let limit: number | undefined;
  let confidenceMargin: number | undefined;
  let out: string | undefined;
  let dryRun = false;
  let apply = false;
  let json = false;
  let target: string | undefined;
  let baseline: string | undefined;
  let resume: string | undefined;
  let mcp = false;
  let path: string | undefined;
  const tags: string[] = [];
  let from: string | undefined;
  let demo: string | undefined;
  let sourceType: string | undefined;
  let sourceUrl: string | undefined;
  let license: string | undefined;
  let author: string | undefined;
  let id: string | undefined;
  let title: string | undefined;
  let family: string | undefined;
  let create = false;
  let position: number | undefined;
  let steps: number | undefined;
  let to: string | undefined;
  let port: number | undefined;
  const allowedHosts: string[] = [];
  let open = false;
  let noService = false;
  let noSetup = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') {
      json = true;
    } else if (argument === '--dry-run') {
      dryRun = true;
    } else if (argument === '--apply') {
      apply = true;
    } else if (argument === '--mcp') {
      mcp = true;
    } else if (argument === '--create') {
      create = true;
    } else if (argument === '--open') {
      open = true;
    } else if (argument === '--no-service') {
      noService = true;
    } else if (argument === '--no-setup') {
      noSetup = true;
    } else if (argument === '--port' || argument === '--allowed-host') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) throw new UsageError(operation, `${argument} requires a value`);
      if (argument === '--port') port = parsePort(operation, value);
      else allowedHosts.push(value);
      index += 1;
    } else if (argument.startsWith('--port=')) {
      port = parsePort(operation, argument.slice('--port='.length));
    } else if (argument.startsWith('--allowed-host=')) {
      const value = argument.slice('--allowed-host='.length);
      if (!value) throw new UsageError(operation, '--allowed-host requires a value');
      allowedHosts.push(value);
    } else if (argument === '--steps' || argument === '--to') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) throw new UsageError(operation, `${argument} requires a value`);
      if (argument === '--to') to = value;
      else steps = parseSteps(operation, value);
      index += 1;
    } else if (argument.startsWith('--steps=')) {
      steps = parseSteps(operation, argument.slice('--steps='.length));
    } else if (argument.startsWith('--to=')) {
      to = argument.slice('--to='.length);
      if (!to) throw new UsageError(operation, '--to requires a commit');
    } else if (argument === '--from' || argument === '--demo' || argument === '--source-type' || argument === '--source-url' || argument === '--license' || argument === '--author') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) throw new UsageError(operation, `${argument} requires a value`);
      if (argument === '--from') from = value;
      else if (argument === '--demo') demo = value;
      else if (argument === '--source-type') sourceType = value;
      else if (argument === '--source-url') sourceUrl = value;
      else if (argument === '--license') license = value;
      else author = value;
      index += 1;
    } else if (argument.startsWith('--from=') || argument.startsWith('--demo=') || argument.startsWith('--source-type=') || argument.startsWith('--source-url=') || argument.startsWith('--license=') || argument.startsWith('--author=')) {
      const name = argument.slice(0, argument.indexOf('='));
      const value = argument.slice(name.length + 1);
      if (!value) throw new UsageError(operation, `${name} requires a value`);
      if (name === '--from') from = value;
      else if (name === '--demo') demo = value;
      else if (name === '--source-type') sourceType = value;
      else if (name === '--source-url') sourceUrl = value;
      else if (name === '--license') license = value;
      else author = value;
    } else if (argument === '--path' || argument === '--id' || argument === '--title' || argument === '--family' || argument === '--tag' || argument === '--index') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) throw new UsageError(operation, `${argument} requires a value`);
      if (argument === '--path') path = value;
      else if (argument === '--id') id = value;
      else if (argument === '--title') title = value;
      else if (argument === '--family') family = value;
      else if (argument === '--tag') tags.push(value);
      else {
        position = Number(value);
        if (!Number.isInteger(position) || position < 0) throw new UsageError(operation, '--index must be a non-negative integer');
      }
      index += 1;
    } else if (argument.startsWith('--path=')) {
      path = argument.slice('--path='.length);
      if (!path) throw new UsageError(operation, '--path requires a path');
    } else if (argument.startsWith('--id=')) {
      id = argument.slice('--id='.length);
      if (!id) throw new UsageError(operation, '--id requires a value');
    } else if (argument.startsWith('--title=')) {
      title = argument.slice('--title='.length);
      if (!title) throw new UsageError(operation, '--title requires a value');
    } else if (argument.startsWith('--family=')) {
      family = argument.slice('--family='.length);
      if (!family) throw new UsageError(operation, '--family requires a value');
    } else if (argument.startsWith('--tag=')) {
      const value = argument.slice('--tag='.length);
      if (!value) throw new UsageError(operation, '--tag requires a value');
      tags.push(value);
    } else if (argument.startsWith('--index=')) {
      position = Number(argument.slice('--index='.length));
      if (!Number.isInteger(position) || position < 0) throw new UsageError(operation, '--index must be a non-negative integer');
    } else if (argument === '--catalog') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) throw new UsageError(operation, '--catalog requires a path');
      catalog = value;
      index += 1;
    } else if (argument.startsWith('--catalog=')) {
      const value = argument.slice('--catalog='.length);
      if (!value) throw new UsageError(operation, '--catalog requires a path');
      catalog = value;
    } else if (argument === '--provider' || argument === '--scope') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) throw new UsageError(operation, `${argument} requires a value`);
      if (argument === '--provider') provider = value;
      else scope = value;
      index += 1;
    } else if (argument.startsWith('--provider=')) {
      provider = argument.slice('--provider='.length);
      if (!provider) throw new UsageError(operation, '--provider requires a value');
    } else if (argument.startsWith('--scope=')) {
      scope = argument.slice('--scope='.length);
      if (!scope) throw new UsageError(operation, '--scope requires a value');
    } else if (argument === '--home') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) throw new UsageError(operation, '--home requires a path');
      home = value;
      index += 1;
    } else if (argument === '--cwd') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) throw new UsageError(operation, '--cwd requires a path');
      cwd = value;
      index += 1;
    } else if (argument.startsWith('--cwd=')) {
      cwd = argument.slice('--cwd='.length);
      if (!cwd) throw new UsageError(operation, '--cwd requires a path');
    } else if (argument.startsWith('--home=')) {
      const value = argument.slice('--home='.length);
      if (!value) throw new UsageError(operation, '--home requires a path');
      home = value;
    } else if (argument === '--out') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) throw new UsageError(operation, '--out requires a path');
      out = value;
      index += 1;
    } else if (argument.startsWith('--out=')) {
      out = argument.slice('--out='.length);
      if (!out) throw new UsageError(operation, '--out requires a path');
    } else if (argument === '--target' || argument === '--baseline' || argument === '--resume') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) throw new UsageError(operation, `${argument} requires a path`);
      if (argument === '--target') target = value;
      else if (argument === '--baseline') baseline = value;
      else resume = value;
      index += 1;
    } else if (argument.startsWith('--target=')) {
      target = argument.slice('--target='.length);
      if (!target) throw new UsageError(operation, '--target requires a path');
    } else if (argument.startsWith('--baseline=')) {
      baseline = argument.slice('--baseline='.length);
      if (!baseline) throw new UsageError(operation, '--baseline requires a path');
    } else if (argument.startsWith('--resume=')) {
      resume = argument.slice('--resume='.length);
      if (!resume) throw new UsageError(operation, '--resume requires a path');
    } else if (argument === '--manifest' || argument === '--entry-point' || argument === '--namespace' || argument === '--slug' || argument === '--name' || argument === '--revision' || argument === '--project' || argument === '--profile' || argument === '--project-profile' || argument === '--framework' || argument === '--language' || argument === '--runtime' || argument === '--style' || argument === '--limit' || argument === '--confidence-margin') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) throw new UsageError(operation, `${argument} requires a value`);
      if (argument === '--manifest') manifest = value;
      else if (argument === '--entry-point') entryPoint = value;
      else if (argument === '--namespace') namespace = value;
      else if (argument === '--slug') slug = value;
      else if (argument === '--name') displayName = value;
      else if (argument === '--revision') revision = value;
      else if (argument === '--project') project = value;
      else if (argument === '--profile' || argument === '--project-profile') profile = value;
      else if (argument === '--framework') framework = value;
      else if (argument === '--language') language = value;
      else if (argument === '--runtime') runtime = value;
      else if (argument === '--style') stylingModes.push(value);
      else if (argument === '--limit') {
        limit = Number(value);
        if (!Number.isInteger(limit) || limit < 1) throw new UsageError(operation, '--limit must be a positive integer');
      } else {
        confidenceMargin = Number(value);
        if (!Number.isFinite(confidenceMargin) || confidenceMargin < 0 || confidenceMargin > 1) throw new UsageError(operation, '--confidence-margin must be between 0 and 1');
      }
      index += 1;
    } else if (argument.startsWith('--manifest=')) {
      manifest = argument.slice('--manifest='.length);
      if (!manifest) throw new UsageError(operation, '--manifest requires a path');
    } else if (argument.startsWith('--entry-point=')) {
      entryPoint = argument.slice('--entry-point='.length);
      if (!entryPoint) throw new UsageError(operation, '--entry-point requires a path');
    } else if (argument.startsWith('--namespace=')) {
      namespace = argument.slice('--namespace='.length);
      if (!namespace) throw new UsageError(operation, '--namespace requires a value');
    } else if (argument.startsWith('--slug=')) {
      slug = argument.slice('--slug='.length);
      if (!slug) throw new UsageError(operation, '--slug requires a value');
    } else if (argument.startsWith('--name=')) {
      displayName = argument.slice('--name='.length);
      if (!displayName) throw new UsageError(operation, '--name requires a value');
    } else if (argument.startsWith('--revision=')) {
      revision = argument.slice('--revision='.length);
      if (!revision) throw new UsageError(operation, '--revision requires a value');
    } else if (argument.startsWith('--project=')) {
      project = argument.slice('--project='.length);
      if (!project) throw new UsageError(operation, '--project requires a path');
    } else if (argument.startsWith('--profile=') || argument.startsWith('--project-profile=')) {
      profile = argument.slice(argument.indexOf('=') + 1);
      if (!profile) throw new UsageError(operation, '--profile requires a path');
    } else if (argument.startsWith('--framework=')) framework = argument.slice('--framework='.length);
    else if (argument.startsWith('--language=')) language = argument.slice('--language='.length);
    else if (argument.startsWith('--runtime=')) runtime = argument.slice('--runtime='.length);
    else if (argument.startsWith('--style=')) stylingModes.push(argument.slice('--style='.length));
    else if (argument.startsWith('--limit=')) {
      limit = Number(argument.slice('--limit='.length));
      if (!Number.isInteger(limit) || limit < 1) throw new UsageError(operation, '--limit must be a positive integer');
    } else if (argument.startsWith('--confidence-margin=')) {
      confidenceMargin = Number(argument.slice('--confidence-margin='.length));
      if (!Number.isFinite(confidenceMargin) || confidenceMargin < 0 || confidenceMargin > 1) throw new UsageError(operation, '--confidence-margin must be between 0 and 1');
    } else if (argument === '-') {
      positional.push(argument);
    } else if (argument === '--help' || argument === '-h') {
      throw new UsageError(operation, 'help requested');
    } else if (argument.startsWith('-')) {
      throw new UsageError(operation, `unknown option '${argument}'`);
    } else positional.push(argument);
  }
  const expected = operation === 'doctor'
    ? ['doctor']
    : operation === 'import'
      ? ['import']
    : operation === 'project.inspect'
      ? ['project', 'inspect']
    : operation === 'search'
      ? ['search']
    : operation === 'inspect'
      ? ['inspect']
    : operation === 'adapt'
      ? ['adapt']
    : operation === 'add'
      ? ['add']
    : operation === 'validate'
      ? ['validate']
    : operation === 'setup'
      ? ['setup']
    : operation === 'ui' || operation.startsWith('ui.')
      ? ['ui', ...operation.slice('ui'.length).split('.').filter(Boolean)]
    : operation === 'theme.init'
      ? ['theme', 'init']
    : operation === 'theme.validate'
      ? ['theme', 'validate']
    : operation === 'theme.add'
      ? ['theme', 'add']
    : operation === 'theme.derive'
      ? ['theme', 'derive']
    : operation === 'catalog.migrate'
      ? ['catalog', 'migrate']
    : operation === 'catalog.rebuild'
      ? ['catalog', 'rebuild']
    : operation === 'catalog.list'
      ? ['catalog', 'list']
    : operation.startsWith('agent.')
      ? ['agent', operation.slice('agent.'.length)]
      : ['catalog', operation === 'catalog.locate' ? 'locate' : 'validate'];
  const libraryCommand = operation.startsWith('inbox.') || operation.startsWith('tag.') || operation.startsWith('collection.') || operation.startsWith('family.') || operation.startsWith('history.');
  if (libraryCommand) {
    const [group, verb] = operation.split('.');
    if (positional[0] !== group || positional[1] !== verb) throw new UsageError(operation, `expected '${group} ${verb}'`);
    const valued = new Set(['inbox.show', 'inbox.import', 'inbox.discard', 'tag.add', 'tag.remove', 'family.set', 'history.restore']);
    if (operation === 'inbox.add') {
      if (positional.length === 3 && positional[2] === '-' && path === undefined) source = '-';
      else if (positional.length !== 2 || path === undefined) throw new UsageError(operation, 'inbox add requires --path <path> or a stdin paste (-)');
    } else if (operation === 'tag.list' || operation === 'history.list') {
      if (positional.length === 3) source = positional[2];
      else if (positional.length !== 2) throw new UsageError(operation, `expected '${group} ${verb} [component]'`);
    } else if (valued.has(operation)) {
      if (positional.length !== 3) throw new UsageError(operation, `expected '${group} ${verb} <value>'`);
      source = positional[2];
    } else if (positional.length !== 2) throw new UsageError(operation, `expected '${group} ${verb}'`);
  } else if (operation === 'import' || operation === 'search' || operation === 'inspect' || operation === 'adapt' || operation === 'add' || operation === 'validate' || operation === 'theme.init' || operation === 'theme.validate' || operation === 'theme.add') {
    const command = operation;
    const commandTokens = operation.startsWith('theme.') ? ['theme', operation.slice('theme.'.length)] : [command];
    if (positional.length !== commandTokens.length + 1 || commandTokens.some((value, index) => positional[index] !== value)) throw new UsageError(operation, `expected '${commandTokens.join(' ')} <value>'`);
    source = positional[commandTokens.length];
  } else if (positional.length !== expected.length || positional.some((value, index) => value !== expected[index])) {
    throw new UsageError(operation, `expected '${expected.join(' ')}'`);
  }
  if (operation.startsWith('agent.') && catalog !== undefined) {
    throw new UsageError(operation, '--catalog is not valid for agent commands');
  }
  const uiCommand = operation === 'ui' || operation.startsWith('ui.');
  if ((port !== undefined || allowedHosts.length > 0 || open) && !uiCommand && operation !== 'setup') throw new UsageError(operation, '--port, --allowed-host, and --open are only valid for ui and setup commands');
  if (open && operation !== 'ui' && operation !== 'setup') throw new UsageError(operation, '--open is only valid for ui and setup');
  if (noService && operation !== 'setup') throw new UsageError(operation, '--no-service is only valid for setup');
  if (noSetup && operation !== 'agent.install' && operation !== 'agent.update') throw new UsageError(operation, '--no-setup is only valid for agent install and agent update');
  if (mcp && !operation.startsWith('agent.')) throw new UsageError(operation, '--mcp is only valid for agent commands');
  if (!operation.startsWith('agent.') && (provider !== undefined || scope !== undefined)) {
    throw new UsageError(operation, '--provider and --scope are only valid for agent commands');
  }
  if (operation.startsWith('agent.') && operation !== 'agent.link' && operation !== 'agent.check' && operation !== 'agent.unlink' && provider === undefined) {
    throw new UsageError(operation, '--provider is required for provider lifecycle commands');
  }
  if (operation.startsWith('agent.') && operation !== 'agent.link' && operation !== 'agent.check' && operation !== 'agent.unlink' && scope === undefined) scope = 'global';
  if (operation.startsWith('agent.') && (provider !== undefined || scope !== undefined) && operation === 'agent.unlink') {
    throw new UsageError(operation, 'provider lifecycle removal uses agent remove');
  }
  if (!operation.startsWith('agent.') && home !== undefined) {
    throw new UsageError(operation, '--home is only valid for agent commands');
  }
  if (operation !== 'project.inspect' && cwd !== undefined) {
    throw new UsageError(operation, '--cwd is only valid for project inspect');
  }
  const collectionMembership = operation === 'collection.add' || operation === 'collection.remove' || operation === 'collection.reorder';
  if (manifest !== undefined && operation !== 'import' && operation !== 'add') throw new UsageError(operation, '--manifest is only valid for import and add');
  if (entryPoint !== undefined && operation !== 'import' && operation !== 'inbox.add' && operation !== 'inbox.import') throw new UsageError(operation, '--entry-point is only valid for import and inbox');
  if (namespace !== undefined && operation !== 'import' && operation !== 'inbox.import') throw new UsageError(operation, '--namespace is only valid for import and inbox import');
  if (slug !== undefined && operation !== 'import' && operation !== 'inbox.import' && !collectionMembership) throw new UsageError(operation, '--slug is only valid for import, inbox import, and collection membership');
  if (displayName !== undefined && operation !== 'import' && operation !== 'inbox.add' && operation !== 'inbox.import' && operation !== 'family.set') throw new UsageError(operation, '--name is only valid for import, inbox, and family set');
  if (path !== undefined && operation !== 'inbox.add') throw new UsageError(operation, '--path is only valid for inbox add');
  if (tags.length > 0 && operation !== 'tag.add' && operation !== 'tag.remove' && operation !== 'import' && operation !== 'inbox.import') throw new UsageError(operation, '--tag is only valid for tag add, tag remove, import, and inbox import');
  if (from !== undefined && operation !== 'import' && operation !== 'inbox.add') throw new UsageError(operation, '--from is only valid for import and inbox add');
  if (from !== undefined && from !== '21st') throw new UsageError(operation, '--from accepts only 21st');
  if (from !== undefined && source !== '-') throw new UsageError(operation, '--from 21st reads a paste from stdin; pass - as the source');
  if (demo !== undefined && operation !== 'import') throw new UsageError(operation, '--demo is only valid for import');
  if (demo !== undefined && from !== undefined) throw new UsageError(operation, '--demo cannot be combined with --from; the paste already carries its demo');
  if ((sourceType !== undefined || sourceUrl !== undefined || license !== undefined || author !== undefined) && operation !== 'import' && operation !== 'inbox.import') throw new UsageError(operation, '--source-type, --source-url, --license, and --author are only valid for import and inbox import');
  if (sourceType !== undefined && !(SOURCE_TYPES as readonly string[]).includes(sourceType)) throw new UsageError(operation, `--source-type must be one of: ${SOURCE_TYPES.join(', ')}`);
  if ((operation === 'tag.add' || operation === 'tag.remove') && tags.length !== 1) throw new UsageError(operation, '--tag is required once');
  if (id !== undefined && !operation.startsWith('collection.')) throw new UsageError(operation, '--id is only valid for collection commands');
  if ((operation === 'collection.create' || operation === 'collection.delete' || collectionMembership) && !id) throw new UsageError(operation, '--id is required');
  if (title !== undefined && operation !== 'collection.create') throw new UsageError(operation, '--title is only valid for collection create');
  if (operation === 'collection.create' && !title) throw new UsageError(operation, '--title is required');
  if (collectionMembership && !slug) throw new UsageError(operation, '--slug is required');
  if (family !== undefined && operation !== 'family.set') throw new UsageError(operation, '--family is only valid for family set');
  if (operation === 'family.set' && !family) throw new UsageError(operation, '--family is required');
  if (create && operation !== 'family.set') throw new UsageError(operation, '--create is only valid for family set');
  if (position !== undefined && operation !== 'collection.reorder') throw new UsageError(operation, '--index is only valid for collection reorder');
  if (operation === 'collection.reorder' && position === undefined) throw new UsageError(operation, '--index is required');
  if (steps !== undefined && operation !== 'history.undo') throw new UsageError(operation, '--steps is only valid for history undo');
  if (to !== undefined && operation !== 'history.undo' && operation !== 'history.restore') throw new UsageError(operation, '--to is only valid for history undo and history restore');
  if (operation === 'history.undo' && steps !== undefined && to !== undefined) throw new UsageError(operation, 'pass --steps or --to, not both');
  if (operation === 'history.restore' && !to) throw new UsageError(operation, '--to <commit> is required');
  if (operation === 'history.list' && (revision !== undefined || project !== undefined || profile !== undefined || framework !== undefined || language !== undefined || runtime !== undefined || stylingModes.length > 0 || confidenceMargin !== undefined)) throw new UsageError(operation, 'history list accepts a component, --limit, and --catalog only');
  if (operation === 'project.inspect' && catalog !== undefined) {
    throw new UsageError(operation, '--catalog is not valid for project inspect');
  }
  if (operation !== 'catalog.migrate' && (target !== undefined || baseline !== undefined || resume !== undefined)) throw new UsageError(operation, 'migration options are only valid for catalog migrate');
  if (operation === 'catalog.migrate' && (!catalog || !target || (dryRun === apply) || (resume !== undefined && (dryRun || apply)))) throw new UsageError(operation, 'catalog migrate requires --catalog, --target, and exactly one of --dry-run or --apply (or --resume <report>)');
  if (!['search', 'inspect', 'adapt', 'add', 'validate', 'history.list', 'theme.add', 'theme.validate', 'theme.derive', 'agent.link', 'agent.check', 'agent.install', 'agent.update', 'agent.remove'].includes(operation) && (revision !== undefined || project !== undefined || profile !== undefined || framework !== undefined || language !== undefined || runtime !== undefined || stylingModes.length > 0 || limit !== undefined || confidenceMargin !== undefined)) {
    throw new UsageError(operation, 'search and inspect options are only valid for those operations');
  }
  if (operation === 'search' && (revision !== undefined || manifest !== undefined || entryPoint !== undefined || namespace !== undefined || slug !== undefined || displayName !== undefined)) throw new UsageError(operation, 'search accepts query, project, profile, and compatibility options only');
  if (operation === 'inspect' && (manifest !== undefined || entryPoint !== undefined || namespace !== undefined || slug !== undefined || displayName !== undefined || project !== undefined || profile !== undefined || framework !== undefined || language !== undefined || runtime !== undefined || stylingModes.length > 0 || limit !== undefined || confidenceMargin !== undefined)) throw new UsageError(operation, 'inspect accepts an ID, --revision, and --catalog only');
  if (operation === 'adapt' && (!project || dryRun || apply)) throw new UsageError(operation, 'adapt requires --project and does not accept --dry-run or --apply');
  if (operation === 'add' && (!project || dryRun === apply)) throw new UsageError(operation, 'add requires exactly one of --dry-run or --apply, plus --project');
  if (operation === 'validate' && (dryRun || apply || !source)) throw new UsageError(operation, 'validate requires an adaptation manifest path');
  if (operation === 'theme.derive' && (!project || dryRun || apply)) throw new UsageError(operation, 'theme derive requires --project');
  if (operation === 'theme.add' && (project || dryRun || apply)) throw new UsageError(operation, 'theme add does not accept --project or apply flags');
  if (operation === 'theme.validate' && (project || dryRun || apply)) throw new UsageError(operation, 'theme validate accepts only a theme path');
  if (operation === 'theme.init' && (project || dryRun || apply)) throw new UsageError(operation, 'theme init accepts only a theme name');
  if (!['adapt', 'add', 'catalog.migrate', 'theme.init', 'theme.derive'].includes(operation) && out !== undefined) throw new UsageError(operation, '--out is only valid for adapt, add, catalog migrate, theme init, or theme derive');
  return { operation, catalog, home, provider, scope, source, manifest, entryPoint, namespace, slug, displayName, cwd, revision, project, profile, framework, language, runtime, stylingModes, limit, confidenceMargin, out, dryRun, apply, json, target, baseline, resume, mcp, path, tags, from: from as '21st' | undefined, demo, sourceType: sourceType as SourceType | undefined, sourceUrl, license, author, id, title, family, create, index: position, steps, to, port, allowedHosts, open, noService, noSetup };
}

function parseSteps(operation: CliOperation, value: string): number {
  const steps = Number(value);
  if (!Number.isInteger(steps) || steps < 1) throw new UsageError(operation, '--steps must be a positive integer');
  return steps;
}

function parsePort(operation: CliOperation, value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError(operation, '--port must be an integer between 1 and 65535');
  return port;
}

function resolutionOptions(catalog: string | undefined): CatalogResolutionOptions {
  return catalog === undefined ? {} : { catalog };
}

function warningFromDiagnostic(item: CatalogDiagnostic): CliWarning {
  return { code: item.code, message: item.message, ...(item.path ? { path: item.path } : {}) };
}

function warningsFromInventory(inventory: LegacyCatalogInventory): CliWarning[] {
  return inventory.diagnostics.filter((item) => item.severity === 'warning').map(warningFromDiagnostic);
}

function diagnosticDetails(inventory: LegacyCatalogInventory): Record<string, unknown> {
  return {
    diagnostics: inventory.diagnostics,
    counts: inventory.counts,
    catalogPath: inventory.catalogPath,
    rootPath: inventory.rootPath,
  };
}

function runLocate(options: CatalogResolutionOptions) {
  const resolution = resolveCatalog(options);
  if (!resolution.found) {
    return {
      exitCode: EXIT_CODES.notFound,
      envelope: failure(
        'catalog.locate',
        'CATALOG_NOT_FOUND',
        'No catalog was found in the checked locations.',
        { checkedLocations: resolution.checkedLocations },
        [],
        MISSING_CATALOG_ACTIONS,
      ),
    };
  }
  return {
    exitCode: EXIT_CODES.ok,
    envelope: success('catalog.locate', {
      path: resolution.catalogPath,
      ...resolution,
    }),
  };
}

/**
 * `doctor`/`catalog.validate` against a real migrated catalog (an `index.sqlite` root, produced
 * by `catalog migrate --apply`) rather than a pre-migration legacy checkout. None of the legacy
 * diagnostic concepts (taxonomy, preview registry, filed-source conflicts) apply here — a
 * migrated catalog's health is entirely the SQLite index's own integrity, which `diagnoseIndex`
 * already checks (schema version, required tables, `PRAGMA quick_check`).
 */
async function runMigratedValidation(operation: 'catalog.validate' | 'doctor', resolution: CatalogResolution) {
  const status = await diagnoseIndex({ catalogRoot: resolution.rootPath! });
  const history = operation === 'doctor' ? await catalogHistoryHealth(resolution.rootPath!) : undefined;
  const warnings: CliWarning[] = [];
  // A catalog without history yet starts it on its next change; only a missing git blocks rollback.
  if (history?.reason === 'git-missing') warnings.push({ code: 'HISTORY_NOT_ENABLED', message: 'Catalog history needs git on PATH; rollback is unavailable.' });
  if (history && history.uncommittedPaths.length > 0) {
    warnings.push({ code: 'HISTORY_UNCOMMITTED', message: `${history.uncommittedPaths.length} catalog path(s) changed outside Blockbase; the next catalog change records them.` });
  }
  const data = {
    format: 'migrated' as const,
    status: status.healthy ? 'healthy' as const : 'unhealthy' as const,
    rootPath: resolution.rootPath,
    indexPath: status.indexPath,
    classification: status.classification,
    ...(status.schemaVersion !== undefined ? { schemaVersion: status.schemaVersion } : {}),
    ...(status.catalogRevision !== undefined ? { catalogRevision: status.catalogRevision } : {}),
    ...(status.cause !== undefined ? { cause: status.cause } : {}),
    ...(history ? { history } : {}),
  };
  if (!status.healthy) {
    return {
      exitCode: EXIT_CODES.validationFailed,
      envelope: failure(operation, 'CATALOG_VALIDATION_FAILED', 'The migrated catalog index failed its health check.', data, warnings, [status.recoveryAction]),
    };
  }
  return { exitCode: EXIT_CODES.ok, envelope: success(operation, data, warnings) };
}

async function runValidation(operation: 'catalog.validate' | 'doctor', options: CatalogResolutionOptions) {
  const resolution = resolveCatalog(options);
  if (!resolution.found) {
    return {
      exitCode: EXIT_CODES.notFound,
      envelope: failure(operation, 'CATALOG_NOT_FOUND', 'No catalog was found in the checked locations.', {
        checkedLocations: resolution.checkedLocations,
      }, [], MISSING_CATALOG_ACTIONS),
    };
  }
  if (basename(resolution.catalogPath!) === 'index.sqlite') return runMigratedValidation(operation, resolution);
  const inventory = readLegacyCatalog(options);
  const warnings = warningsFromInventory(inventory);
  const errors = inventory.diagnostics.filter((item) => item.severity === 'error');
  const data = operation === 'doctor'
    ? { status: errors.length === 0 ? 'healthy' : 'unhealthy', ...inventory }
    : inventory;
  if (errors.length > 0) {
    return {
      exitCode: EXIT_CODES.validationFailed,
      envelope: failure(operation, 'CATALOG_VALIDATION_FAILED', `${errors.length} catalog diagnostic(s) require attention.`, diagnosticDetails(inventory), warnings, [
        { id: 'inspect-diagnostics', label: 'Inspect catalog diagnostics', safe: true, command: `blockbase catalog validate --catalog ${inventory.catalogPath} --json` },
      ]),
    };
  }
  return { exitCode: EXIT_CODES.ok, envelope: success(operation, data, warnings) };
}

function importCatalogRoot(catalog: string | undefined): string {
  return resolveCatalogRoot(catalog);
}

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function runImport(parsed: ParsedArgs) {
  let manifest;
  if (parsed.manifest) {
    try {
      manifest = JSON.parse(await readFile(parsed.manifest, 'utf8'));
    } catch (error) {
      throw new ImportError('IMPORT_INVALID_ENVELOPE', 'The component manifest could not be read as JSON.', { path: parsed.manifest, cause: error instanceof Error ? error.message : String(error) });
    }
  }
  const options = {
    catalogRoot: importCatalogRoot(parsed.catalog),
    manifest,
    entryPoint: parsed.entryPoint,
    namespace: parsed.namespace,
    slug: parsed.slug,
    displayName: parsed.displayName,
  };
  const extras = importExtrasFor(parsed);
  if (parsed.from === '21st') {
    const imported = await importPaste(await readStdinText(), { ...options, extras });
    return {
      ...importedData(imported),
      paste: {
        format: imported.reading.format,
        files: imported.reading.files.map((file) => ({ path: file.path, role: file.role })),
        entryPoint: imported.reading.entryPoint,
        authorHint: imported.reading.authorHint ?? null,
        suspicions: imported.reading.suspicions,
        normalizations: imported.reading.normalizations,
        rawPastePath: imported.rawPastePath,
        warnings: imported.warnings,
      },
      demo: imported.demo,
    };
  }
  if (extras) {
    const imported = await importSourceWithExtras(parsed.source!, { ...options, extras });
    return imported.demo ? { ...importedData(imported), demo: imported.demo } : importedData(imported);
  }
  const imported = await importSource(parsed.source!, options);
  return importedData(imported);
}

function importedData(imported: Awaited<ReturnType<typeof importSource>>) {
  return {
    revisionId: imported.revisionId,
    packagePath: imported.packagePath,
    componentPath: imported.componentPath,
    revisionPath: imported.revisionPath,
    manifest: imported.manifest,
    envelope: imported.envelope,
    integrity: imported.integrity,
  };
}

/** The import extras given on the command line, or undefined when none was given. */
function importExtrasFor(parsed: ParsedArgs): ImportExtras | undefined {
  const extras: ImportExtras = {};
  if (parsed.sourceType !== undefined) extras.sourceType = parsed.sourceType;
  if (parsed.sourceUrl !== undefined) extras.sourceUrl = parsed.sourceUrl;
  if (parsed.license !== undefined) extras.license = parsed.license;
  if (parsed.author !== undefined) extras.author = parsed.author;
  if (parsed.tags.length > 0) extras.tags = [...parsed.tags];
  if (parsed.demo !== undefined) extras.demoFile = parsed.demo;
  return Object.keys(extras).length > 0 ? extras : undefined;
}

async function runProjectInspect(parsed: ParsedArgs) {
  const profile = await inspectProject(parsed.cwd ?? process.cwd());
  if (profile.conflicts.length > 0) {
    throw new ProjectInspectionError(
      'PROJECT_CONFLICT',
      'Project inspection found material token conflicts; select a definition or add .blockbase/project.json overrides.',
      { conflicts: profile.conflicts, profile },
    );
  }
  return profile;
}

async function compatibilityInput(parsed: ParsedArgs) {
  if (!parsed.profile && !parsed.project && !parsed.framework && !parsed.language && !parsed.runtime && parsed.stylingModes?.length === 0) return undefined;
  let project;
  if (parsed.profile) {
    try {
      project = parseProjectProfile(JSON.parse(await readFile(parsed.profile, 'utf8')));
    } catch (error) {
      throw new ImportError('IMPORT_INVALID_ENVELOPE', 'The project profile could not be read or validated.', { path: parsed.profile, cause: error instanceof Error ? error.message : String(error) });
    }
  } else if (parsed.project) {
    project = await inspectProject(parsed.project);
  }
  return {
    ...(parsed.framework ? { framework: parsed.framework } : {}),
    ...(parsed.language ? { language: parsed.language } : {}),
    ...(parsed.runtime ? { runtime: parsed.runtime } : {}),
    ...(parsed.stylingModes && parsed.stylingModes.length > 0 ? { stylingModes: parsed.stylingModes } : {}),
    ...(project ? { project } : {}),
  };
}

async function runSearch(parsed: ParsedArgs, access: CatalogAccess) {
  if (access.mode === 'remote') return access.client.search(parsed.source!, { filters: await remoteSearchFilters(parsed) });
  return searchComponents(importCatalogRoot(parsed.catalog), parsed.source!, {
    limit: parsed.limit,
    confidenceMargin: parsed.confidenceMargin,
    compatibility: await compatibilityInput(parsed),
  });
}

async function runInspect(parsed: ParsedArgs, access: CatalogAccess) {
  if (access.mode === 'remote') return access.client.inspect(parsed.source!, parsed.revision);
  return inspectComponent(importCatalogRoot(parsed.catalog), parsed.source!, parsed.revision);
}

async function runRebuild(parsed: ParsedArgs) {
  return rebuildIndex({ catalogRoot: importCatalogRoot(parsed.catalog) });
}

async function runMigration(parsed: ParsedArgs) {
  const options: MigrationOptions = {
    sourceRoot: importCatalogRoot(parsed.catalog),
    targetRoot: resolve(parsed.target!),
    ...(parsed.baseline ? { baselineCatalogPath: resolve(parsed.baseline) } : {}),
    ...(parsed.out ? { reportPath: resolve(parsed.out) } : {}),
  };
  if (parsed.resume) return resumeLegacyMigration({ ...options, reportPath: resolve(parsed.resume) });
  if (parsed.apply) return applyLegacyMigration(options, 'apply');
  return planLegacyMigration(options);
}

/** Local-mode passes `catalogRoot`; remote mode passes an already-constructed `catalogSource` — never both, never a project path. */
function catalogOptionsFor(parsed: ParsedArgs, access: CatalogAccess): { catalogRoot?: string; catalogSource?: CatalogSource } {
  return access.mode === 'remote' ? { catalogSource: access.source } : { catalogRoot: importCatalogRoot(parsed.catalog) };
}

async function runAdapt(parsed: ParsedArgs, access: CatalogAccess) {
  return prepareComponentAdaptation(parsed.source!, { ...catalogOptionsFor(parsed, access), projectPath: parsed.project!, revision: parsed.revision, outDir: parsed.out });
}

async function runAdd(parsed: ParsedArgs, access: CatalogAccess) {
  // A dry-run is strictly read-only, including when --out was accidentally supplied.
  const bundle = parsed.manifest
    ? await readAdaptationBundle(parsed.manifest)
    : await prepareComponentAdaptation(parsed.source!, { ...catalogOptionsFor(parsed, access), projectPath: parsed.project!, revision: parsed.revision, outDir: parsed.apply ? parsed.out : undefined });
  if (bundle.componentId !== parsed.source) throw new AdaptationError('ADAPT_COMPONENT_MISMATCH', 'The supplied adaptation manifest belongs to a different component.', { expected: parsed.source, received: bundle.componentId });
  if (resolve(bundle.projectPath) !== resolve(parsed.project!)) throw new AdaptationError('ADAPT_PROJECT_MISMATCH', 'The supplied adaptation manifest belongs to a different destination project.', { expected: bundle.projectPath, received: parsed.project });
  // Applying always writes to the local project only (unchanged): only catalog *resolution* moves to `access`.
  const plan = parsed.apply ? await applyAdaptation(bundle, catalogOptionsFor(parsed, access)) : await createApplyPlan(bundle);
  return { bundle, plan, applied: parsed.apply };
}

async function runValidate(parsed: ParsedArgs) {
  const bundle = await readAdaptationBundle(parsed.source!);
  return validateAdaptation(bundle, { projectPath: parsed.project });
}

function themeIdFromName(name: string): string {
  const id = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!id) throw new ThemeError('THEME_INVALID_ID', 'Theme name must contain at least one letter or number.', { name });
  return id;
}

async function runTheme(parsed: ParsedArgs) {
  if (parsed.operation === 'theme.init') {
    const id = themeIdFromName(parsed.source!);
    const path = await writeStarterTheme(parsed.out ?? `${id}.theme.json`, id, parsed.source!);
    return { path, manifest: parseThemeManifest(JSON.parse(await readFile(path, 'utf8'))) };
  }
  if (parsed.operation === 'theme.validate') {
    const manifest = await readThemeManifest(parsed.source!);
    const result = validateTheme(manifest);
    if (!result.valid) throw new ThemeValidationError(result.issues);
    return result;
  }
  if (parsed.operation === 'theme.add') return new ThemeRegistry({ catalogRoot: importCatalogRoot(parsed.catalog) }).register(parsed.source!);
  const profile = await inspectThemeProject(parsed.project!);
  const draft = deriveThemeFromProject(profile, { id: themeIdFromName(parsed.project!.split(/[\\/]/).filter(Boolean).pop() ?? 'project-draft') });
  if (parsed.out) {
    await mkdir(dirname(resolve(parsed.out)), { recursive: true });
    await writeFile(resolve(parsed.out), `${JSON.stringify(draft, null, 2)}\n`);
    return { ...draft, path: resolve(parsed.out) };
  }
  return draft;
}

type SummaryIssue = { code: string; message: string; repair?: string } | string;

/** Writes setup-style issues to stderr; plain strings (the older `agent check` shape) are skipped. */
function writeIssues(issues: SummaryIssue[] | undefined): void {
  for (const issue of issues ?? []) {
    if (typeof issue === 'string') continue;
    writeDiagnostic(`Issue [${issue.code}]: ${issue.message}${issue.repair ? ` Run: ${issue.repair}` : ''}`);
  }
}

function humanSummary(operation: string, envelope: ReturnType<typeof success> | ReturnType<typeof failure>): void {
  if (envelope.ok) {
    if (operation === 'catalog.locate') process.stdout.write(`Catalog: ${String((envelope.data as { path?: string }).path ?? 'unknown')}\n`);
    else if (operation.startsWith('agent.')) {
      const data = envelope.data as { home?: string; healthy?: boolean; links?: Array<{ name: string; state: string; action?: string }>; issues?: SummaryIssue[] };
      process.stdout.write(`Agent ${operation.slice('agent.'.length)}: ${data.healthy === false ? 'unhealthy' : 'ok'} (${data.home ?? 'unknown'})\n`);
      for (const link of data.links ?? []) process.stdout.write(`- ${link.name}: ${link.state}${link.action ? ` (${link.action})` : ''}\n`);
      // `agent install` and `agent update` run setup, whose problems (a stopped service) still exit 0 and need saying here.
      writeIssues(data.issues);
    }
    else if (operation === 'setup') {
      const data = envelope.data as { catalogRoot?: string; catalog?: string; service?: string; url?: string; issues?: SummaryIssue[] };
      process.stdout.write(`Setup: catalog ${data.catalog ?? 'unknown'} (${data.catalogRoot ?? 'unknown'}), service ${data.service ?? 'unknown'}, ${data.url ?? ''}\n`);
      writeIssues(data.issues);
    }
    else if (operation === 'ui.status') {
      const data = envelope.data as { running?: boolean; url?: string };
      process.stdout.write(`Catalog page: ${data.running ? 'running' : 'not running'} (${data.url ?? 'unknown'})\n`);
    }
    else if (operation.startsWith('ui.service.')) {
      const data = envelope.data as { state?: string; removed?: boolean; installed?: boolean; loaded?: boolean; path?: string };
      process.stdout.write(`Service ${operation.slice('ui.service.'.length)}: ${data.state ?? (data.removed !== undefined ? (data.removed ? 'removed' : 'absent') : `${data.installed ? 'installed' : 'not installed'}, ${data.loaded ? 'loaded' : 'not loaded'}`)}${data.path ? ` (${data.path})` : ''}\n`);
      for (const warning of envelope.warnings) writeDiagnostic(`Warning [${warning.code}]: ${warning.message}`);
    }
    else if (operation === 'search') {
      const data = envelope.data as { results?: Array<{ componentId: string; score: number }>; selection?: { status: string } };
      process.stdout.write(`Search: ${data.results?.length ?? 0} result(s), ${data.selection?.status ?? 'unknown'}\n`);
    }
    else if (operation === 'inspect') {
      const data = envelope.data as { componentId?: string; revisionId?: string };
      process.stdout.write(`Inspect: ${data.componentId ?? 'unknown'} @ ${data.revisionId ?? 'unknown'}\n`);
    }
    else if (operation === 'adapt') {
      const data = envelope.data as { bundleId?: string; componentId?: string; risk?: string };
      process.stdout.write(`Adapt: ${data.componentId ?? 'unknown'} (${data.bundleId ?? 'unknown'}, ${data.risk ?? 'unknown'})\n`);
    }
    else if (operation === 'add') {
      const data = envelope.data as { applied?: boolean; plan?: { writes?: string[]; blocked?: string[] } };
      process.stdout.write(`Add: ${data.applied ? 'applied' : 'dry-run'} (${data.plan?.writes?.length ?? 0} file(s), ${data.plan?.blocked?.length ?? 0} blocked)\n`);
    }
    else if (operation === 'validate') {
      const data = envelope.data as { status?: string; commands?: unknown[] };
      process.stdout.write(`Validate: ${data.status ?? 'unknown'} (${data.commands?.length ?? 0} command(s))\n`);
    }
    else if (operation === 'history.list') {
      const data = envelope.data as { entries?: Array<{ shortCommit: string; committedAt: string; summary: string; actor?: string }> };
      for (const entry of data.entries ?? []) process.stdout.write(`${entry.shortCommit}  ${entry.committedAt}  ${entry.summary}${entry.actor ? `  [${entry.actor}]` : ''}\n`);
    }
    else if (operation === 'history.undo' || operation === 'history.restore') {
      const data = envelope.data as { commit?: string; restoredTo?: string; restoredFrom?: string; undone?: unknown[]; component?: string };
      process.stdout.write(operation === 'history.undo'
        ? `Undo: ${data.undone?.length ?? 0} change(s) rolled back to ${data.restoredTo?.slice(0, 8) ?? 'unknown'}\n`
        : `Restore: ${data.component ?? 'unknown'} from ${data.restoredFrom?.slice(0, 8) ?? 'unknown'}\n`);
    }
    else if (operation === 'catalog.list') {
      const data = envelope.data as { components?: Array<{ componentId: string; category: string }>; collections?: unknown[] };
      for (const component of data.components ?? []) process.stdout.write(`${component.componentId}  ${component.category}\n`);
      process.stdout.write(`Catalog: ${data.components?.length ?? 0} component(s), ${data.collections?.length ?? 0} collection(s)\n`);
    }
    else if (operation === 'catalog.rebuild') {
      const data = envelope.data as { componentCount?: number; indexPath?: string };
      process.stdout.write(`Catalog rebuild: ${data.componentCount ?? 0} component(s) (${data.indexPath ?? 'unknown'})\n`);
    }
    else if (operation === 'catalog.migrate') {
      const data = envelope.data as { mode?: string; status?: string; entries?: unknown[]; blocked?: unknown[]; structuralChanges?: unknown[] };
      process.stdout.write(`Catalog migration: ${data.mode ?? 'unknown'}${data.status ? ` (${data.status})` : ''} (${data.entries?.length ?? 0} entries, ${data.blocked?.length ?? 0} blocked, ${data.structuralChanges?.length ?? 0} structural changes)\n`);
    }
    else if (operation.startsWith('theme.')) {
      const data = envelope.data as { path?: string; revisionId?: string; valid?: boolean; reviewRequired?: boolean; themePath?: string };
      process.stdout.write(`Theme ${operation.slice('theme.'.length)}: ${data.revisionId ?? data.path ?? (data.valid === false ? 'invalid' : 'ok')}\n`);
    }
    else if (operation.startsWith('inbox.') || operation.startsWith('tag.') || operation.startsWith('collection.') || operation.startsWith('family.') || operation.startsWith('history.')) {
      const data = envelope.data as { id?: string; inboxId?: string; componentId?: string; created?: boolean };
      process.stdout.write(`${operation}: ${data.inboxId ?? data.id ?? data.componentId ?? (data.created ? 'created' : 'ok')}\n`);
    }
    else {
      const data = envelope.data as { status?: string; counts?: { entries?: number; uniquePaths?: number }; diagnostics?: unknown[] };
      if (operation === 'import') {
        const imported = envelope.data as { revisionId?: string; packagePath?: string };
        process.stdout.write(`Import: ${imported.revisionId ?? 'unknown'} (${imported.packagePath ?? 'unknown'})\n`);
      } else if (operation === 'project.inspect') {
        const profile = envelope.data as { projectPath?: string; framework?: { name?: string }; conflicts?: string[] };
        process.stdout.write(`Project inspection: ${profile.framework?.name ?? 'unknown'} (${profile.projectPath ?? 'unknown'}, ${profile.conflicts?.length ?? 0} conflicts)\n`);
      } else process.stdout.write(`${operation === 'doctor' ? 'Doctor' : 'Catalog validation'}: ${data.status ?? 'valid'} (${data.counts?.entries ?? 0} entries, ${data.diagnostics?.length ?? 0} diagnostics)\n`);
      for (const warning of envelope.warnings) writeDiagnostic(`Warning [${warning.code}]: ${warning.message}`);
    }
  } else {
    writeDiagnostic(`Error [${envelope.error.code}]: ${envelope.error.message}`);
    for (const action of envelope.recoveryActions) writeDiagnostic(`Recovery: ${action.label}`);
  }
}

type McpTransport = 'stdio' | 'http';

/**
 * Parses `blockbase mcp` transport flags. Defaults to stdio with no flags, matching the
 * historical unflagged behavior exactly. `--host`/`--port` are intentionally passed through
 * unvalidated (even when absent) to `startHttpServer`, which already rejects an invalid
 * host/port/path before opening a socket (see packages/mcp/src/server.ts); this avoids
 * re-implementing that pre-listen validation here.
 */
function parseMcpArgs(rest: string[]): { transport: McpTransport; host?: string; port?: number } | { error: string } {
  let transport: McpTransport = 'stdio';
  let host: string | undefined;
  let port: number | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--transport') {
      const value = rest[++index];
      if (value !== 'stdio' && value !== 'http') return { error: `--transport must be "stdio" or "http" (received ${value === undefined ? 'nothing' : JSON.stringify(value)})` };
      transport = value;
    } else if (argument === '--host') {
      host = rest[++index];
    } else if (argument === '--port') {
      const value = rest[++index];
      port = value === undefined ? undefined : Number(value);
    } else {
      return { error: `unknown option '${argument}' for mcp` };
    }
  }
  return { transport, host, port };
}

async function runMcp(rest: string[]): Promise<number> {
  const parsed = parseMcpArgs(rest);
  if ('error' in parsed) {
    writeDiagnostic(`Error [INVALID_ARGUMENTS]: ${parsed.error}`);
    return EXIT_CODES.usage;
  }
  if (parsed.transport === 'stdio') {
    const { startStdioServer } = await import('@blockbase/mcp');
    await startStdioServer();
    return EXIT_CODES.ok;
  }
  const { startHttpServer } = await import('@blockbase/mcp');
  try {
    // Cast: an absent/invalid host or port is deliberately forwarded so startHttpServer's own
    // pre-listen validation (RangeError, thrown before any socket is opened) is the single
    // source of truth for "missing/invalid host or port" diagnostics.
    const handle = await startHttpServer({ host: parsed.host, port: parsed.port } as Parameters<typeof startHttpServer>[0]);
    writeDiagnostic(`MCP HTTP server listening on ${handle.url}`);
    return EXIT_CODES.ok;
  } catch (error) {
    writeDiagnostic(`Error [INVALID_ARGUMENTS]: ${error instanceof Error ? error.message : 'Invalid HTTP transport configuration'}`);
    return EXIT_CODES.usage;
  }
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (isHelpRequest(argv)) {
    const help = renderHelp(argv);
    (help.ok ? process.stdout : process.stderr).write(help.text);
    return help.ok ? EXIT_CODES.ok : EXIT_CODES.usage;
  }
  if (argv[0] === 'mcp') {
    return runMcp(argv.slice(1));
  }
  const operation = operationFromTokens(argv);
  let parsed: ParsedArgs;
  let remoteConfig: RemoteConfig | undefined;
  try {
    parsed = parseArgs(argv);
    // Validated in the same try/catch as argument parsing: a mutual-exclusivity conflict, a
    // missing/empty token, or remote configuration on a local-only operation are all bounded
    // usage problems, surfaced with the exact same INVALID_ARGUMENTS envelope below — before any
    // remote client is constructed and before any connection is attempted.
    remoteConfig = resolveRemoteConfig(parsed.operation, parsed.catalog);
    // Catalog history records who made each change; an agent harness may already have set it.
    process.env.BLOCKBASE_ACTOR ??= parsed.operation === 'ui' ? 'ui' : process.env.CLAUDECODE ? 'claude-code' : 'cli';
  } catch (error) {
    const usage = operation.startsWith('theme.') ? themeFailure(operation, 'INVALID_ARGUMENTS', error instanceof Error ? error.message : 'Invalid arguments') : failure(operation as OperationName, 'INVALID_ARGUMENTS', error instanceof Error ? error.message : 'Invalid arguments');
    if (argv.includes('--json')) writeJson(usage);
    writeDiagnostic(`Error [${usage.error.code}]: ${usage.error.message}`);
    return EXIT_CODES.usage;
  }
  let remoteClient: RemoteCatalogClient | undefined;
  try {
    if (parsed.operation === 'ui') return await runUi({ catalogRoot: importCatalogRoot(parsed.catalog), port: parsed.port ?? DEFAULT_UI_PORT, allowedHosts: parsed.allowedHosts, open: parsed.open, json: parsed.json });
    const access: CatalogAccess = remoteConfig
      ? { mode: 'remote', client: (remoteClient = createRemoteCatalogClient({ url: remoteConfig.url, token: remoteConfig.token })), source: createRemoteCatalogSource(remoteClient) }
      : { mode: 'local' };
    const result = parsed.operation === 'import'
      ? { exitCode: EXIT_CODES.ok, envelope: success(parsed.operation as OperationName, await runImport(parsed)) }
      : parsed.operation === 'project.inspect'
      ? { exitCode: EXIT_CODES.ok, envelope: success(parsed.operation as OperationName, await runProjectInspect(parsed)) }
      : parsed.operation === 'search'
      ? { exitCode: EXIT_CODES.ok, envelope: success(parsed.operation as OperationName, await runSearch(parsed, access)) }
      : parsed.operation === 'inspect'
      ? { exitCode: EXIT_CODES.ok, envelope: success(parsed.operation as OperationName, await runInspect(parsed, access)) }
      : parsed.operation === 'adapt'
      ? { exitCode: EXIT_CODES.ok, envelope: success(parsed.operation as OperationName, await runAdapt(parsed, access)) }
      : parsed.operation === 'add'
      ? { exitCode: EXIT_CODES.ok, envelope: success(parsed.operation as OperationName, await runAdd(parsed, access)) }
      : parsed.operation === 'validate'
      ? { exitCode: EXIT_CODES.ok, envelope: success(parsed.operation as OperationName, await runValidate(parsed)) }
      : parsed.operation.startsWith('theme.')
      ? { exitCode: EXIT_CODES.ok, envelope: themeSuccess(parsed.operation, await runTheme(parsed)) }
      : parsed.operation === 'setup'
      ? { exitCode: EXIT_CODES.ok, envelope: success(parsed.operation, await runSetup({ catalogRoot: importCatalogRoot(parsed.catalog), port: parsed.port, allowedHosts: parsed.allowedHosts, noService: parsed.noService }), []) }
      : parsed.operation === 'ui.status'
      ? await (async () => { const status = await runUiStatus({ catalogRoot: importCatalogRoot(parsed.catalog), port: parsed.port }); return { exitCode: EXIT_CODES.ok, envelope: success(parsed.operation as OperationName, status.data, status.warnings) }; })()
      : parsed.operation === 'ui.service.status'
      ? (() => { const root = importCatalogRoot(parsed.catalog); const status = serviceStatus(root, configuredPort(parsed.port, root)); return { exitCode: EXIT_CODES.ok, envelope: success(parsed.operation as OperationName, status.status, status.warnings) }; })()
      : parsed.operation === 'ui.service.install'
      ? { exitCode: EXIT_CODES.ok, envelope: success(parsed.operation as OperationName, installService({ catalogRoot: importCatalogRoot(parsed.catalog), port: parsed.port, allowedHosts: parsed.allowedHosts })) }
      : parsed.operation === 'ui.service.uninstall'
      ? { exitCode: EXIT_CODES.ok, envelope: success(parsed.operation as OperationName, uninstallService(importCatalogRoot(parsed.catalog))) }
      : parsed.operation === 'catalog.rebuild'
      ? { exitCode: EXIT_CODES.ok, envelope: success(parsed.operation, await runRebuild(parsed)) }
      : parsed.operation === 'catalog.list'
      ? { exitCode: EXIT_CODES.ok, envelope: success(parsed.operation, await listCatalog(importCatalogRoot(parsed.catalog))) }
      : parsed.operation === 'catalog.migrate'
      ? { exitCode: EXIT_CODES.ok, envelope: success(parsed.operation, await runMigration(parsed)) }
      : parsed.operation.startsWith('inbox.') || parsed.operation.startsWith('tag.') || parsed.operation.startsWith('collection.') || parsed.operation.startsWith('family.') || parsed.operation.startsWith('history.')
        ? await executeLibrary({
            operation: parsed.operation as OperationName,
            catalogRoot: importCatalogRoot(parsed.catalog),
            source: parsed.source,
            path: parsed.path,
            entryPoint: parsed.entryPoint,
            namespace: parsed.namespace,
            slug: parsed.slug,
            displayName: parsed.displayName,
            tag: parsed.operation === 'tag.add' || parsed.operation === 'tag.remove' ? parsed.tags[0] : undefined,
            from: parsed.operation === 'inbox.add' ? parsed.from : undefined,
            extras: parsed.operation === 'inbox.import' ? importExtrasFor(parsed) : undefined,
            id: parsed.id,
            title: parsed.title,
            family: parsed.family,
            create: parsed.create,
            index: parsed.index,
            steps: parsed.steps,
            to: parsed.to,
            limit: parsed.limit,
            stdin: parsed.operation === 'inbox.add' && parsed.source === '-' ? await readStdinText() : undefined,
          })
      : parsed.operation === 'catalog.locate'
      ? runLocate(resolutionOptions(parsed.catalog))
      : parsed.operation === 'agent.link'
        ? parsed.provider ? runAgentProviderLink({ home: parsed.home, provider: parsed.provider, scope: parsed.scope, project: parsed.project, mcp: parsed.mcp }) : runAgentLink({ home: parsed.home })
        : parsed.operation === 'agent.check'
          ? parsed.provider ? await runAgentProviderCheck({ home: parsed.home, provider: parsed.provider, scope: parsed.scope, project: parsed.project }) : runAgentCheck({ home: parsed.home })
          : parsed.operation === 'agent.unlink'
            ? runAgentUnlink({ home: parsed.home })
            : parsed.operation === 'agent.install'
              ? await runAgentProviderInstall({ home: parsed.home, provider: parsed.provider, scope: parsed.scope, project: parsed.project, mcp: parsed.mcp, noSetup: parsed.noSetup })
              : parsed.operation === 'agent.update'
                ? await runAgentProviderUpdate({ home: parsed.home, provider: parsed.provider, scope: parsed.scope, project: parsed.project, mcp: parsed.mcp, noSetup: parsed.noSetup })
                : parsed.operation === 'agent.remove'
                  ? runAgentProviderRemove({ home: parsed.home, provider: parsed.provider, scope: parsed.scope, project: parsed.project })
                  : await runValidation(parsed.operation as 'catalog.validate' | 'doctor', resolutionOptions(parsed.catalog));
    if (parsed.json) {
      writeJson(result.envelope);
      if (!result.envelope.ok) humanSummary(parsed.operation, result.envelope);
      else for (const warning of result.envelope.warnings) writeDiagnostic(`Warning [${warning.code}]: ${warning.message}`);
    } else humanSummary(parsed.operation, result.envelope);
    return result.exitCode;
  } catch (error) {
    if (error instanceof CliFailure) {
      const envelope = failure(parsed.operation as OperationName, error.code, error.message, error.details, [], error.recoveryActions);
      if (parsed.json) writeJson(envelope);
      writeDiagnostic(`Error [${envelope.error.code}]: ${envelope.error.message}`);
      return error.exitCode;
    }
    if (error instanceof RemoteCatalogError) {
      const { exitCode, envelope } = remoteCatalogFailure(parsed.operation as OperationName, error);
      if (parsed.json) writeJson(envelope);
      writeDiagnostic(`Error [${envelope.error.code}]: ${envelope.error.message}`);
      return exitCode;
    }
    if (error instanceof IndexError) {
      const exitCode = error.code === 'INDEX_NOT_FOUND' || error.code === 'COMPONENT_NOT_FOUND' ? EXIT_CODES.notFound : error.code === 'COMPONENT_SELECTION_REQUIRED' ? EXIT_CODES.conflict : EXIT_CODES.validationFailed;
      const action = error.details.recoveryAction;
      const recoveryActions = action && typeof action === 'object' ? [action as RecoveryAction] : [];
      const envelope = parsed.operation.startsWith('theme.') ? themeFailure(parsed.operation, error.code, error.message, error.details) : failure(parsed.operation as OperationName, error.code, error.message, error.details, [], recoveryActions);
      if (parsed.json) writeJson(envelope);
      writeDiagnostic(`Error [${envelope.error.code}]: ${envelope.error.message}`);
      return exitCode;
    }
    if (error instanceof ImportError) {
      const invalid = error.code === 'IMPORT_UNSUPPORTED_FRAMEWORK' ? EXIT_CODES.unsupported : error.code === 'IMPORT_SOURCE_NOT_FOUND' ? EXIT_CODES.notFound : error.code === 'IMPORT_COMMIT_FAILED' ? EXIT_CODES.internal : EXIT_CODES.invalidInput;
      const envelope = parsed.operation.startsWith('theme.') ? themeFailure(parsed.operation, error.code, error.message, error.details) : failure(parsed.operation as OperationName, error.code, error.message, error.details);
      if (parsed.json) writeJson(envelope);
      writeDiagnostic(`Error [${envelope.error.code}]: ${envelope.error.message}`);
      return invalid;
    }
    if (error instanceof ProjectInspectionError) {
      const invalid = error.code === 'PROJECT_NOT_FOUND' ? EXIT_CODES.notFound : error.code === 'PROJECT_UNSUPPORTED_FRAMEWORK' ? EXIT_CODES.unsupported : error.code === 'PROJECT_CONFLICT' ? EXIT_CODES.conflict : EXIT_CODES.invalidInput;
      const envelope = parsed.operation.startsWith('theme.') ? themeFailure(parsed.operation, error.code, error.message, error.details) : failure(parsed.operation as OperationName, error.code, error.message, error.details);
      if (parsed.json) writeJson(envelope);
      writeDiagnostic(`Error [${envelope.error.code}]: ${envelope.error.message}`);
      return invalid;
    }
    if (error instanceof ThemeError) {
      const conflict = error.code === 'THEME_DUPLICATE_ID' || error.code === 'THEME_ALREADY_EXISTS';
      const envelope = parsed.operation.startsWith('theme.') ? themeFailure(parsed.operation, error.code, error.message, error.details) : failure(parsed.operation as OperationName, error.code, error.message, error.details);
      if (parsed.json) writeJson(envelope);
      writeDiagnostic(`Error [${envelope.error.code}]: ${envelope.error.message}`);
      return conflict ? EXIT_CODES.conflict : EXIT_CODES.validationFailed;
    }
    if (error instanceof AdaptationError || error instanceof ValidationError) {
      const code = error.code;
      const conflict = code.includes('CONFLICT') || code.includes('TARGET_CHANGED') || code.includes('PROJECT_MISMATCH');
      const unsupported = code.includes('UNSUPPORTED');
      const envelope = parsed.operation.startsWith('theme.') ? themeFailure(parsed.operation, code, error.message, error.details) : failure(parsed.operation as OperationName, code, error.message, error.details);
      if (parsed.json) writeJson(envelope);
      writeDiagnostic(`Error [${envelope.error.code}]: ${envelope.error.message}`);
      return conflict ? EXIT_CODES.conflict : unsupported ? EXIT_CODES.unsupported : EXIT_CODES.validationFailed;
    }
    const message = error instanceof Error ? error.message : 'Unexpected internal error';
    const envelope = parsed.operation.startsWith('theme.') ? themeFailure(parsed.operation, 'INTERNAL_ERROR', 'The command failed unexpectedly.') : failure(parsed.operation as OperationName, 'INTERNAL_ERROR', 'The command failed unexpectedly.');
    writeDiagnostic(`Internal error: ${message}`);
    if (parsed.json) writeJson(envelope);
    return EXIT_CODES.internal;
  } finally {
    // A remote client is only ever constructed above, inside the try; close it on every path
    // (success, a handled failure, or an unexpected throw) so a one-shot CLI invocation never
    // leaves an open HTTP connection (e.g. the transport's standalone SSE listen channel) behind.
    if (remoteClient) await remoteClient.close().catch(() => undefined);
  }
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  run().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

export { OPERATION_REGISTRY };
