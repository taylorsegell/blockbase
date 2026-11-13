import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EXIT_CODES, type CliWarning, type RecoveryAction } from '@blockbase/contracts';
import { CliFailure } from '../errors.js';
import { cliEntry } from '../paths.js';
import { stableNodePath } from './nodePath.js';
import { LAUNCHD_LABEL, launchdLogPaths, launchdPlistPath, plistNodePath, renderPlist, type ServiceDefinition } from './launchd.js';
import { SYSTEMD_UNIT, renderUnit, systemdUnitPath, unitNodePath } from './systemd.js';
import { readServiceInventory, removeServiceInventory, serviceInventoryPath, sha256Of, writeServiceInventory } from './inventory.js';

export { readServiceInventory } from './inventory.js';

export const DEFAULT_UI_PORT = 47821;

export type ServiceInstallOptions = {
  catalogRoot: string;
  /** Defaults to the port recorded by the previous install, then DEFAULT_UI_PORT. */
  port?: number;
  /** Empty or omitted keeps the hosts recorded by the previous install. */
  allowedHosts?: string[];
};

/**
 * A refresh (`agent update`, `setup`, or `ui service install` without flags) must not silently drop
 * the port or `--allowed-host` values chosen at first install, so unspecified values come from the
 * service inventory.
 */
export function resolveServiceSettings(options: ServiceInstallOptions): { port: number; allowedHosts: string[] } {
  const inventory = readServiceInventory(options.catalogRoot);
  return {
    port: options.port ?? inventory?.port ?? DEFAULT_UI_PORT,
    allowedHosts: options.allowedHosts && options.allowedHosts.length > 0 ? options.allowedHosts : inventory?.allowedHosts ?? [],
  };
}

export type ServiceState = 'installed' | 'refreshed' | 'present';

type Platform = 'darwin' | 'linux';
type Spec = { platform: Platform; path: string; label: string };

function spec(): Spec | undefined {
  if (process.platform === 'darwin') return { platform: 'darwin', path: launchdPlistPath(), label: LAUNCHD_LABEL };
  if (process.platform === 'linux') return { platform: 'linux', path: systemdUnitPath(), label: SYSTEMD_UNIT };
  return undefined;
}

function requireSpec(): Spec {
  const found = spec();
  if (!found) throw new CliFailure('SERVICE_UNSUPPORTED', `A user login service is not supported on ${process.platform}; run 'blockbase ui' in a terminal instead.`, EXIT_CODES.unsupported, { platform: process.platform });
  return found;
}

export function serviceEntry(): string {
  return cliEntry();
}

type RunResult = { status: number; stdout: string; stderr: string };

/** Longest a single service-manager call may take, so a hung launchctl or systemctl cannot block forever. */
const RUN_TIMEOUT_MS = 5000;
/** launchctl's exit code for "no such service". */
const LAUNCHCTL_NOT_FOUND = 113;

/**
 * Scales every time budget in this file (deadlines, reserves, per-call timeout). Always 1 in production;
 * `BLOCKBASE_SERVICE_BUDGET_SCALE` (a number between 0 and 1) lets tests with a hung mock runner finish quickly.
 */
function budgetScale(): number {
  const override = Number(process.env.BLOCKBASE_SERVICE_BUDGET_SCALE);
  return Number.isFinite(override) && override > 0 && override < 1 ? override : 1;
}

function scaled(ms: number): number {
  return Math.max(1, Math.round(ms * budgetScale()));
}

/**
 * Runs the platform service manager. `BLOCKBASE_SERVICE_RUNNER` replaces `launchctl`/`systemctl`
 * with an executable that receives the same arguments, so tests never touch the real manager.
 * A call that exceeds its timeout is killed with SIGKILL (a process that ignores SIGTERM would
 * otherwise outlive it) and counts as a failed result (status 124).
 */
function run(platform: Platform, args: string[], timeoutMs: number = scaled(RUN_TIMEOUT_MS)): RunResult {
  const command = process.env.BLOCKBASE_SERVICE_RUNNER || (platform === 'darwin' ? 'launchctl' : 'systemctl');
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL' });
  if (result.error) {
    const timedOut = (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    return { status: timedOut ? 124 : 127, stdout: '', stderr: timedOut ? `${command} did not answer within ${timeoutMs} ms` : result.error.message };
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Like `run`, but never lets a call outlive the shared deadline (epoch milliseconds). */
function runBefore(platform: Platform, args: string[], deadline: number): RunResult {
  const left = deadline - Date.now();
  if (left <= 0) return { status: 124, stdout: '', stderr: 'the service-manager time budget is used up' };
  return run(platform, args, Math.min(scaled(RUN_TIMEOUT_MS), left));
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

function commandFailure(args: string[], result: RunResult): CliFailure {
  return new CliFailure('SERVICE_COMMAND_FAILED', `The service manager rejected '${args.join(' ')}'.`, EXIT_CODES.internal, { args, status: result.status, stderr: result.stderr.trim() });
}

function mustBefore(platform: Platform, args: string[], deadline: number): void {
  const result = runBefore(platform, args, deadline);
  if (result.status !== 0) throw commandFailure(args, result);
}

function isLoaded(found: Spec, deadline?: number): boolean {
  const call = (platform: Platform, args: string[]) => (deadline === undefined ? run(platform, args) : runBefore(platform, args, deadline));
  if (found.platform === 'darwin') return call('darwin', ['print', `${domain()}/${found.label}`]).status === 0;
  return call('linux', ['--user', 'is-active', '--quiet', SYSTEMD_UNIT]).status === 0;
}

/**
 * Base wait unit in milliseconds for launchd teardown polling and bootstrap backoff (default 250).
 * `BLOCKBASE_SERVICE_WAIT_MS` shortens it so tests using the mock runner stay fast.
 */
function waitUnitMs(): number {
  const override = Number(process.env.BLOCKBASE_SERVICE_WAIT_MS);
  return Number.isFinite(override) && override > 0 ? override : 250;
}

/** Synchronous sleep; the service code is spawnSync-based so it cannot be async. */
function sleep(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Time budget. The VS Code extension gives `blockbase ui status` 15 seconds
 * (apps/vscode/src/service/status.ts), and a refresh that fails must still answer inside that, so the
 * deadlines of the whole failed-refresh path add up to 10 seconds (11 at most) at the default wait
 * unit of 250 ms:
 *
 *   new definition: an 8 s deadline. Teardown polling (up to 27 polls, 26 sleeps = 6.5 s) may use all
 *                   of it except a 1.5 s reserve, so that at least one bootstrap attempt always runs,
 *                   even when `print` hangs. Up to 4 bootstrap attempts follow, backing off 1x, 2x
 *                   and 4x, as far as the deadline allows.
 *   restore:        a 2 s deadline for one short pass: up to 4 teardown polls (0.75 s of sleeping),
 *                   a 1 s reserve for 2 bootstrap attempts (0.25 s backoff), then the final
 *                   running check.
 *
 * The deadlines also cap each service-manager call, so a hung launchctl costs at most the time left
 * in its phase rather than the full 5 s per-call timeout.
 */
type LoadPlan = { budgetMs: number; reserveMs: number; teardownPolls: number; bootstrapAttempts: number };
const LOAD_PLAN: LoadPlan = { budgetMs: 8000, reserveMs: 1500, teardownPolls: 27, bootstrapAttempts: 4 };
const RESTORE_PLAN: LoadPlan = { budgetMs: 2000, reserveMs: 1000, teardownPolls: 4, bootstrapAttempts: 2 };

function loadDarwin(found: Spec, plan: LoadPlan, deadline: number): void {
  const target = `${domain()}/${found.label}`;
  const unit = waitUnitMs();
  // Teardown work (bootout and the `print` polls) stops here so the bootstrap attempts keep their reserve.
  const teardownEnd = deadline - scaled(plan.reserveMs);
  const pause = (ms: number, until: number) => sleep(Math.min(ms, until - Date.now()));
  // A stale registration makes bootstrap fail, so replace it; "not found" from bootout is expected.
  // bootout can return before the job has finished tearing down, so wait until `print` reports the
  // job as not found. Any other answer keeps polling until the poll bound or the teardown time ends.
  runBefore('darwin', ['bootout', target], teardownEnd);
  for (let poll = 0; poll < plan.teardownPolls; poll += 1) {
    if (runBefore('darwin', ['print', target], teardownEnd).status === LAUNCHCTL_NOT_FOUND) break;
    if (Date.now() >= teardownEnd) break;
    if (poll < plan.teardownPolls - 1) pause(unit, teardownEnd);
  }
  const args = ['bootstrap', domain(), found.path];
  for (let attempt = 0; attempt < plan.bootstrapAttempts; attempt += 1) {
    const result = runBefore('darwin', args, deadline);
    if (result.status === 0) return;
    if (attempt === plan.bootstrapAttempts - 1) throw commandFailure(args, result);
    pause(unit * 2 ** attempt, deadline);
  }
}

function load(found: Spec, fresh: boolean, plan: LoadPlan = LOAD_PLAN): void {
  const deadline = Date.now() + scaled(plan.budgetMs);
  if (found.platform === 'darwin') return loadDarwin(found, plan, deadline);
  mustBefore('linux', ['--user', 'daemon-reload'], deadline);
  mustBefore('linux', ['--user', 'enable', '--now', SYSTEMD_UNIT], deadline);
  if (!fresh) mustBefore('linux', ['--user', 'restart', SYSTEMD_UNIT], deadline);
}

type Previous = { content: Buffer; inventory: Buffer | undefined };

/** `restored`: the definition file and inventory are back. `running`: the manager reports the service loaded. */
type Restoration = { restored: boolean; running: boolean; problem?: string };

function putBack(path: string, bytes: Buffer): void {
  if (existsSync(path) && readFileSync(path).equals(bytes)) return;
  writeFileSync(path, bytes);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Puts the previous definition and inventory back. With `reload`, also tries to start the previous
 * service again (the new definition had already been handed to the manager). The two outcomes are
 * reported separately because a restored file does not mean a running service.
 */
function restorePrevious(found: Spec, catalogRoot: string, previous: Previous, reload: boolean): Restoration {
  const deadline = Date.now() + scaled(RESTORE_PLAN.budgetMs);
  let restored = true;
  let problem: string | undefined;
  try {
    putBack(found.path, previous.content);
    if (previous.inventory) putBack(serviceInventoryPath(catalogRoot), previous.inventory);
    else removeServiceInventory(catalogRoot);
  } catch (error) {
    restored = false;
    problem = errorText(error);
  }
  // A reload that failed, or that could not be attempted because the files did not come back, means the
  // previous service was not started again. `print` and `is-active` can still answer "loaded" for a job
  // that is only tearing down (launchd) or for a unit that is about to stop, so a failed reload counts
  // against `running` whatever the manager says afterwards.
  let reloadOk = true;
  if (reload && !restored) reloadOk = false;
  if (reload && restored) {
    try {
      if (found.platform === 'darwin') {
        load(found, false, RESTORE_PLAN);
      } else {
        mustBefore('linux', ['--user', 'daemon-reload'], deadline);
        mustBefore('linux', ['--user', 'restart', SYSTEMD_UNIT], deadline);
      }
    } catch (error) {
      reloadOk = false;
      problem = error instanceof CliFailure ? `${error.message} ${String(error.details.stderr ?? '')}`.trim() : errorText(error);
    }
  }
  const running = reloadOk && isLoaded(found, deadline);
  return { restored, running, ...(problem ? { problem } : {}) };
}

function restoreSentence(restoration: Restoration): string {
  const { restored, running } = restoration;
  if (restored && running) return 'The previous service definition was restored and the service is running.';
  if (restored) return 'The previous service definition was restored, but the service is stopped.';
  if (running) return 'The previous service definition could not be restored; the service is still running.';
  return 'The previous service definition could not be restored and the service is stopped.';
}

/** The failure for a refresh that did not take, carrying the restore outcome and a way back to a running service. */
function refreshFailure(error: CliFailure, restoration: Restoration): CliFailure {
  const details = { ...error.details, restored: restoration.restored, running: restoration.running, ...(restoration.problem ? { restoreProblem: restoration.problem } : {}) };
  const actions: RecoveryAction[] = restoration.running ? [] : [{ id: 'start-service', label: 'Start the catalog service again', safe: true, command: 'blockbase ui service install --json' }];
  return new CliFailure(error.code, `${error.message} ${restoreSentence(restoration)}`, error.exitCode, details, [...error.recoveryActions, ...actions]);
}

function writeFailure(error: unknown, found: Spec): CliFailure {
  if (error instanceof CliFailure) return error;
  const code = (error as NodeJS.ErrnoException).code;
  return new CliFailure('SERVICE_WRITE_FAILED', `Could not write the service files: ${errorText(error)}`, EXIT_CODES.internal, { path: found.path, ...(typeof code === 'string' ? { errno: code } : {}) });
}

export function installService(options: ServiceInstallOptions): { state: ServiceState; path: string; platform: Platform; label: string; port: number } {
  const found = requireSpec();
  const { port, allowedHosts } = resolveServiceSettings(options);
  const definition: ServiceDefinition = { nodePath: stableNodePath(process.execPath), entry: serviceEntry(), port, catalogRoot: options.catalogRoot, allowedHosts };
  const content = found.platform === 'darwin' ? renderPlist(definition) : renderUnit(definition);
  const digest = sha256Of(content);
  const inventory = readServiceInventory(options.catalogRoot);
  const exists = existsSync(found.path);
  let state: ServiceState = 'installed';
  if (exists) {
    const current = sha256Of(readFileSync(found.path));
    if (!inventory || inventory.path !== found.path || inventory.sha256 !== current) {
      throw new CliFailure('SERVICE_CONFLICT', `${found.path} exists and Blockbase does not own it; it was not changed.`, EXIT_CODES.conflict, { path: found.path, owned: Boolean(inventory) });
    }
    state = current === digest ? 'present' : 'refreshed';
  }
  if (state === 'present') {
    if (!isLoaded(found)) load(found, true);
  } else {
    const inventoryFile = serviceInventoryPath(options.catalogRoot);
    const previous: Previous | undefined = state === 'refreshed' ? { content: readFileSync(found.path), inventory: existsSync(inventoryFile) ? readFileSync(inventoryFile) : undefined } : undefined;
    // Until the manager has been asked to load the new definition, the old service (if any) is untouched.
    let stage: 'write' | 'load' = 'write';
    try {
      mkdirSync(dirname(found.path), { recursive: true });
      if (found.platform === 'darwin') mkdirSync(dirname(launchdLogPaths().out), { recursive: true });
      writeFileSync(found.path, content, 'utf8');
      writeServiceInventory(options.catalogRoot, { schemaVersion: '1', platform: found.platform, path: found.path, sha256: digest, label: found.label, port, allowedHosts, installedAt: new Date().toISOString() });
      stage = 'load';
      load(found, state === 'installed');
    } catch (cause) {
      const error = writeFailure(cause, found);
      if (previous) throw refreshFailure(error, restorePrevious(found, options.catalogRoot, previous, stage === 'load'));
      // A fresh install that could not record ownership must not leave a definition Blockbase does not own.
      if (stage === 'write') {
        rmSync(found.path, { force: true });
        removeServiceInventory(options.catalogRoot);
      }
      throw error;
    }
  }
  return { state, path: found.path, platform: found.platform, label: found.label, port };
}

export function uninstallService(catalogRoot: string): { removed: boolean; path?: string; platform?: Platform } {
  const found = requireSpec();
  const inventory = readServiceInventory(catalogRoot);
  if (!inventory) return { removed: false };
  if (inventory.path !== found.path) {
    throw new CliFailure('SERVICE_CONFLICT', 'The service inventory points outside the Blockbase service location; nothing was removed.', EXIT_CODES.conflict, { inventoryPath: inventory.path, expected: found.path });
  }
  if (existsSync(found.path) && sha256Of(readFileSync(found.path)) !== inventory.sha256) {
    throw new CliFailure('SERVICE_CONFLICT', `${found.path} was modified after Blockbase installed it; it was not removed.`, EXIT_CODES.conflict, { path: found.path });
  }
  if (found.platform === 'darwin') run('darwin', ['bootout', `${domain()}/${found.label}`]);
  else run('linux', ['--user', 'disable', '--now', SYSTEMD_UNIT]);
  rmSync(found.path, { force: true });
  if (found.platform === 'linux') run('linux', ['--user', 'daemon-reload']);
  removeServiceInventory(catalogRoot);
  return { removed: true, path: found.path, platform: found.platform };
}

export type ServiceStatus = {
  supported: boolean;
  platform: string;
  installed: boolean;
  owned: boolean;
  loaded: boolean;
  path?: string;
  port?: number;
  nodePath?: string;
  nodePathExists?: boolean;
};

/** Read-only: never writes, starts, or stops anything. */
export function serviceStatus(catalogRoot: string, port?: number): { status: ServiceStatus; warnings: CliWarning[] } {
  const found = spec();
  if (!found) return { status: { supported: false, platform: process.platform, installed: false, owned: false, loaded: false }, warnings: [] };
  const inventory = readServiceInventory(catalogRoot);
  const exists = existsSync(found.path);
  const content = exists ? readFileSync(found.path, 'utf8') : undefined;
  const owned = Boolean(exists && inventory && inventory.path === found.path && content !== undefined && sha256Of(content) === inventory.sha256);
  const nodePath = content === undefined ? undefined : found.platform === 'darwin' ? plistNodePath(content) : unitNodePath(content);
  const status: ServiceStatus = {
    supported: true,
    platform: found.platform,
    installed: owned,
    owned,
    loaded: exists ? isLoaded(found) : false,
    path: found.path,
    port: port ?? inventory?.port,
    ...(nodePath !== undefined ? { nodePath, nodePathExists: existsSync(nodePath) } : {}),
  };
  const warnings: CliWarning[] = [];
  if (nodePath !== undefined && !status.nodePathExists) {
    warnings.push({ code: 'SERVICE_NODE_MISSING', message: `The service runs ${nodePath}, which no longer exists (a Node upgrade moves it). Run 'blockbase ui service install --json' to refresh it.`, path: found.path });
  }
  if (exists && !owned) warnings.push({ code: 'SERVICE_NOT_OWNED', message: `${found.path} exists but is not recorded in this catalog's service inventory.`, path: found.path });
  return { status, warnings };
}
