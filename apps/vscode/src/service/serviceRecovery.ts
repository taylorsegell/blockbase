/**
 * "Catalog page isn't running" recovery: checks status, offers Install / Run for this session /
 * Restart, then polls an injected health check until the page answers.
 *
 * Integration hook for the catalog panel (ARK-418): call `recovery.check()` before loading and
 * when the iframe fails; while `state.kind !== "up"`, show `renderNotRunningHtml(state, nonce)`
 * and forward its `{ type: "blockbase.service", action }` messages to `recovery.handleAction()`;
 * reload the page when `onDidChangeState` fires with `up`.
 */
import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { CLI_CALLS, probeServiceStatus, type CliRunner, type ServiceState } from "./status";

export interface SessionProcess {
  kill(): void;
  onExit(callback: () => void): void;
}

export type SessionSpawner = (file: string, args: readonly string[]) => SessionProcess;
export type HealthCheck = () => Promise<boolean>;
export type ServiceAction = "install" | "runSession" | "restart" | "retry";

export interface RetryOptions {
  sleep?: (ms: number) => Promise<void>;
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
  signal?: AbortSignal;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls `health` with doubling delays. Resolves true once it answers, false on give-up or abort. */
export async function waitUntilUp(health: HealthCheck, options: RetryOptions = {}): Promise<boolean> {
  const { sleep = defaultSleep, initialDelayMs = 250, maxDelayMs = 4000, maxAttempts = 30, signal } = options;
  let delay = initialDelayMs;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) return false;
    if (await health().catch(() => false)) return true;
    if (attempt === maxAttempts) break;
    await sleep(delay);
    delay = Math.min(delay * 2, maxDelayMs);
  }
  return false;
}

export const spawnSessionProcess: SessionSpawner = (file, args) => {
  const child = spawn(file, [...args], { shell: false, stdio: "ignore", windowsHide: true });
  child.on("error", () => {}); // a missing binary surfaces through the next status check
  return { kill: () => void child.kill(), onExit: (cb) => void child.once("exit", cb) };
};

export interface ServiceRecoveryOptions {
  bin: string;
  runner: CliRunner;
  spawnSession?: SessionSpawner;
  /** Defaults to "status says running". Tests and the panel may inject a direct page probe. */
  health?: HealthCheck;
  sleep?: (ms: number) => Promise<void>;
}

export class ServiceRecovery implements vscode.Disposable {
  private session: SessionProcess | undefined;
  private retry: AbortController | undefined;
  private readonly emitter = new vscode.EventEmitter<ServiceState>();
  readonly onDidChangeState = this.emitter.event;
  state: ServiceState = { kind: "starting" };

  constructor(private readonly options: ServiceRecoveryOptions) {}

  private lastUrl = "";

  private setState(state: ServiceState): ServiceState {
    if ("url" in state && state.url) this.lastUrl = state.url;
    this.state = state;
    this.emitter.fire(state);
    return state;
  }

  async check(): Promise<ServiceState> {
    return this.setState(await probeServiceStatus(this.options.bin, this.options.runner));
  }

  async install(): Promise<void> {
    await this.runThenWait(CLI_CALLS.installService);
  }

  async restart(): Promise<void> {
    await this.runThenWait(CLI_CALLS.restartService);
  }

  /** Starts `blockbase ui` as a child of the extension host; killed on dispose/deactivate. */
  async runForSession(): Promise<void> {
    if (!this.session) {
      const child = (this.options.spawnSession ?? spawnSessionProcess)(this.options.bin, CLI_CALLS.runSession);
      child.onExit(() => {
        if (this.session === child) this.session = undefined;
      });
      this.session = child;
    }
    await this.waitForPage();
  }

  handleAction(action: ServiceAction): Promise<unknown> {
    switch (action) {
      case "install":
        return this.install();
      case "runSession":
        return this.runForSession();
      case "restart":
        return this.restart();
      case "retry":
        return this.check();
    }
  }

  private async runThenWait(args: readonly string[]): Promise<void> {
    try {
      const result = await this.options.runner(this.options.bin, args);
      if (result.exitCode !== 0) {
        this.setState({ kind: "unknown", reason: result.stderr.trim() || `\`${this.options.bin} ${args.join(" ")}\` failed.` });
        return;
      }
    } catch (error) {
      this.setState({ kind: "unknown", reason: (error as Error).message });
      return;
    }
    await this.waitForPage();
  }

  private async waitForPage(): Promise<void> {
    this.retry?.abort();
    const retry = new AbortController();
    this.retry = retry;
    this.setState({ kind: "starting" });
    const health = this.options.health ?? (async () => (await probeServiceStatus(this.options.bin, this.options.runner)).kind === "up");
    const up = await waitUntilUp(health, { sleep: this.options.sleep, signal: retry.signal });
    if (retry.signal.aborted) return;
    if (up) this.setState({ kind: "up", url: this.lastUrl });
    else await this.check();
  }

  dispose(): void {
    this.retry?.abort();
    this.session?.kill();
    this.session = undefined;
    this.emitter.dispose();
  }
}
