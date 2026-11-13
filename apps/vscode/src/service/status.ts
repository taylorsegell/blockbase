/**
 * Reads `blockbase ui status --json` and turns it into one of four states.
 * Every CLI call is an argument array run through an injectable runner (execFile, no shell).
 */
import { execFile } from "node:child_process";

/** Argument arrays for every CLI call the extension makes. Never joined into a shell string. */
export const CLI_CALLS = {
  status: ["ui", "status", "--json"],
  installService: ["ui", "service", "install"],
  // The CLI has no `ui service restart`. Re-running install is idempotent: it re-loads an
  // owned service that is installed but not loaded, and refreshes a stale definition.
  restartService: ["ui", "service", "install"],
  runSession: ["ui"],
} as const satisfies Record<string, readonly string[]>;

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Runs `file` with `args`. Tests pass a fake; production uses execFile. */
export type CliRunner = (file: string, args: readonly string[]) => Promise<CliResult>;

export type ServiceState =
  | { kind: "up"; url: string }
  | { kind: "installed-down"; url: string }
  | { kind: "no-service"; url: string }
  | { kind: "starting" }
  | { kind: "unknown"; reason: string };

export const execFileRunner: CliRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { shell: false, timeout: 15_000, windowsHide: true }, (error, stdout, stderr) => {
      // A non-zero exit still prints a JSON failure envelope; only spawn failures reject.
      if (error && typeof (error as NodeJS.ErrnoException).code === "string") return reject(error);
      const code = error ? Number((error as { code?: unknown }).code ?? 1) : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: Number.isFinite(code) ? code : 1 });
    });
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Classifies a parsed `ui status --json` envelope. Anything unexpected is `unknown`. */
export function classifyStatus(envelope: unknown): ServiceState {
  if (!isRecord(envelope)) return { kind: "unknown", reason: "Blockbase returned no status." };
  if (envelope.ok !== true) {
    const error = isRecord(envelope.error) ? envelope.error : {};
    return { kind: "unknown", reason: typeof error.message === "string" ? error.message : "Blockbase reported an error." };
  }
  const data = envelope.data;
  if (!isRecord(data) || typeof data.running !== "boolean") return { kind: "unknown", reason: "Unrecognised status output." };
  const url = typeof data.url === "string" ? data.url : "";
  if (data.running) return { kind: "up", url };
  const service = isRecord(data.service) ? data.service : {};
  return service.installed === true ? { kind: "installed-down", url } : { kind: "no-service", url };
}

export async function probeServiceStatus(bin: string, runner: CliRunner): Promise<ServiceState> {
  let result: CliResult;
  try {
    result = await runner(bin, CLI_CALLS.status);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { kind: "unknown", reason: code === "ENOENT" ? `The \`${bin}\` command was not found on PATH.` : String((error as Error).message) };
  }
  try {
    return classifyStatus(JSON.parse(result.stdout));
  } catch {
    return { kind: "unknown", reason: "Could not read `blockbase ui status --json` output." };
  }
}
