export const ORGANIZE_ERROR_CODES = {
  notFound: 'ORGANIZE_NOT_FOUND',
  ambiguous: 'ORGANIZE_AMBIGUOUS',
  unknownFamily: 'ORGANIZE_UNKNOWN_FAMILY',
  invalidFamily: 'ORGANIZE_INVALID_FAMILY',
  invalidTag: 'ORGANIZE_INVALID_TAG',
  invalidCollection: 'ORGANIZE_INVALID_COLLECTION',
  reservedCollection: 'ORGANIZE_RESERVED_COLLECTION',
  duplicateCollection: 'ORGANIZE_DUPLICATE_COLLECTION',
  invalidArgument: 'ORGANIZE_INVALID_ARGUMENT',
} as const;

export type OrganizeErrorCode = (typeof ORGANIZE_ERROR_CODES)[keyof typeof ORGANIZE_ERROR_CODES];

export class OrganizeError extends Error {
  readonly code: OrganizeErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: OrganizeErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'OrganizeError';
    this.code = code;
    this.details = details;
  }
}
