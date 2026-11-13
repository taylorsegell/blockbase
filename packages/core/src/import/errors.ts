export const IMPORT_ERROR_CODES = {
  sourceNotFound: 'IMPORT_SOURCE_NOT_FOUND',
  invalidPath: 'IMPORT_INVALID_PATH',
  pathTraversal: 'IMPORT_PATH_TRAVERSAL',
  symlinkEscape: 'IMPORT_SYMLINK_ESCAPE',
  symlinkUnsupported: 'IMPORT_SYMLINK_UNSUPPORTED',
  entryPointMissing: 'IMPORT_ENTRYPOINT_MISSING',
  entryPointNotFound: 'IMPORT_ENTRYPOINT_NOT_FOUND',
  unsupportedFramework: 'IMPORT_UNSUPPORTED_FRAMEWORK',
  hashMismatch: 'IMPORT_HASH_MISMATCH',
  invalidEnvelope: 'IMPORT_INVALID_ENVELOPE',
  commitFailed: 'IMPORT_COMMIT_FAILED',
  pasteUnreadable: 'IMPORT_PASTE_UNREADABLE',
  pasteNameRequired: 'IMPORT_PASTE_NAME_REQUIRED',
} as const;

export type ImportErrorCode = (typeof IMPORT_ERROR_CODES)[keyof typeof IMPORT_ERROR_CODES];

export class ImportError extends Error {
  readonly code: ImportErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ImportErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
    this.details = details;
  }
}
