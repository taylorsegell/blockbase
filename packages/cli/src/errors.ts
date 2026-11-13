import type { ExitCode, RecoveryAction } from '@blockbase/contracts';

/** A bounded, already-classified failure: the dispatcher renders it as the standard error envelope. */
export class CliFailure extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly details: Record<string, unknown>;
  readonly recoveryActions: RecoveryAction[];

  constructor(code: string, message: string, exitCode: ExitCode, details: Record<string, unknown> = {}, recoveryActions: RecoveryAction[] = []) {
    super(message);
    this.name = 'CliFailure';
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
    this.recoveryActions = recoveryActions;
  }
}
