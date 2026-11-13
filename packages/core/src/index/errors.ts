export const INDEX_ERROR_CODES = {
  notFound: 'INDEX_NOT_FOUND',
  corrupt: 'INDEX_CORRUPT',
  schemaMismatch: 'INDEX_SCHEMA_MISMATCH',
  manifestInvalid: 'INDEX_MANIFEST_INVALID',
  componentNotFound: 'COMPONENT_NOT_FOUND',
  ambiguous: 'COMPONENT_SELECTION_REQUIRED',
} as const;

export type IndexErrorCode = (typeof INDEX_ERROR_CODES)[keyof typeof INDEX_ERROR_CODES];

export type IndexFailureClassification = 'missing' | 'malformed' | 'schema-mismatch' | 'incomplete';

export class IndexError extends Error {
  readonly code: IndexErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: IndexErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'IndexError';
    this.code = code;
    this.details = details;
  }
}
