export const REVISION_STORE_ERROR_CODES = {
  locked: 'STORE_LOCKED',
  staleManifest: 'STORE_STALE_MANIFEST',
  recoveryFailed: 'STORE_RECOVERY_FAILED',
} as const;

export type RevisionStoreErrorCode = (typeof REVISION_STORE_ERROR_CODES)[keyof typeof REVISION_STORE_ERROR_CODES];

export class RevisionStoreError extends Error {
  readonly code: RevisionStoreErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: RevisionStoreErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'RevisionStoreError';
    this.code = code;
    this.details = details;
  }
}

export class RevisionLockError extends RevisionStoreError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(REVISION_STORE_ERROR_CODES.locked, message, details);
    this.name = 'RevisionLockError';
  }
}

export class StaleManifestError extends RevisionStoreError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(REVISION_STORE_ERROR_CODES.staleManifest, message, details);
    this.name = 'StaleManifestError';
  }
}

// Short aliases make the typed errors convenient for callers without changing
// the stable error names or codes above.
export const LockError = RevisionLockError;
export const StaleRevisionError = StaleManifestError;
