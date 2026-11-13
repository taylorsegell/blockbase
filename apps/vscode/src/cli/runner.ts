import { execFile } from "node:child_process";

/** Result of one CLI process. stdout carries the JSON envelope when `--json` is passed. */
export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the `blockbase` CLI with an argument array. Never a shell string: arguments such as
 * search queries are passed through untouched. Tests inject a fake runner.
 */
export type CliRunner = (args: readonly string[]) => Promise<CliResult>;

/** The CLI executable could not be started (not on PATH). */
export class CliNotFoundError extends Error {
  constructor(readonly command: string) {
    super(`'${command}' was not found on PATH.`);
    this.name = "CliNotFoundError";
  }
}

export interface ExecFileRunnerOptions {
  command?: string;
  timeoutMs?: number;
}

export function execFileRunner(options: ExecFileRunnerOptions = {}): CliRunner {
  const command = options.command ?? "blockbase";
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        command,
        [...args],
        { shell: false, timeout: options.timeoutMs ?? 30_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (error && (error as NodeJS.ErrnoException).code === "ENOENT") return reject(new CliNotFoundError(command));
          // A non-zero exit still carries a JSON error envelope on stdout; anything else is a spawn failure.
          if (error && typeof error.code !== "number") return reject(error);
          resolve({ exitCode: error ? Number(error.code) : 0, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
}
