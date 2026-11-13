export const INBOX_ERROR_CODES = {
  invalidPath: 'INBOX_INVALID_PATH',
  invalidId: 'INBOX_INVALID_ID',
  notFound: 'INBOX_NOT_FOUND',
  emptyPaste: 'INBOX_EMPTY_PASTE',
  copyFailed: 'INBOX_COPY_FAILED',
} as const;

export type InboxErrorCode = (typeof INBOX_ERROR_CODES)[keyof typeof INBOX_ERROR_CODES];

export class InboxError extends Error {
  readonly code: InboxErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: InboxErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'InboxError';
    this.code = code;
    this.details = details;
  }
}
