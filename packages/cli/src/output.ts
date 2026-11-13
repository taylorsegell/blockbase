import {
  CONTRACT_VERSION,
  parseCliErrorEnvelope,
  parseCliSuccessEnvelope,
  stableStringify,
  type CliErrorEnvelope,
  type CliSuccessEnvelope,
  type CliWarning,
  type OperationName,
  type RecoveryAction,
} from '@blockbase/contracts';

export function success<T>(operation: OperationName, data: T, warnings: CliWarning[] = []): CliSuccessEnvelope<T> {
  const envelope = { schemaVersion: CONTRACT_VERSION, ok: true as const, operation, data, warnings };
  // Validate at the boundary so a future handler cannot emit an invalid envelope.
  parseCliSuccessEnvelope(envelope);
  return envelope;
}

export function failure(
  operation: OperationName,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
  warnings: CliWarning[] = [],
  recoveryActions: RecoveryAction[] = [],
): CliErrorEnvelope {
  const envelope = {
    schemaVersion: CONTRACT_VERSION,
    ok: false as const,
    operation,
    error: { code, message, ...(Object.keys(details).length > 0 ? { details } : {}) },
    warnings,
    // Recovery actions are deliberately supplied by handlers from a small fixed set.
    recoveryActions: recoveryActions.slice(0, 3),
  };
  parseCliErrorEnvelope(envelope);
  return envelope;
}

export function writeJson(value: CliSuccessEnvelope<unknown> | CliErrorEnvelope): void {
  process.stdout.write(stableStringify(value));
}

export function writeDiagnostic(message: string): void {
  process.stderr.write(`${message.endsWith('\n') ? message : `${message}\n`}`);
}

/** Theme operations are local CLI extensions until the shared v1 envelope contract is promoted. */
export function themeSuccess<T>(operation: string, data: T): CliSuccessEnvelope<T> {
  return { schemaVersion: CONTRACT_VERSION, ok: true, operation: operation as OperationName, data, warnings: [] };
}

export function themeFailure(operation: string, code: string, message: string, details: Record<string, unknown> = {}): CliErrorEnvelope {
  return { schemaVersion: CONTRACT_VERSION, ok: false, operation: operation as OperationName, error: { code, message, ...(Object.keys(details).length > 0 ? { details } : {}) }, warnings: [], recoveryActions: [] };
}
