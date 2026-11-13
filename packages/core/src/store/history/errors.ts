export const HISTORY_ERROR_CODES = {
  unavailable: 'HISTORY_UNAVAILABLE',
  invalidRevision: 'HISTORY_INVALID_REVISION',
  nothingToUndo: 'HISTORY_NOTHING_TO_UNDO',
  busy: 'HISTORY_BUSY',
  invalidArgument: 'HISTORY_INVALID_ARGUMENT',
  failed: 'HISTORY_FAILED',
} as const;

export type HistoryErrorCode = (typeof HISTORY_ERROR_CODES)[keyof typeof HISTORY_ERROR_CODES];

export class HistoryError extends Error {
  readonly code: HistoryErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: HistoryErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'HistoryError';
    this.code = code;
    this.details = details;
  }
}
