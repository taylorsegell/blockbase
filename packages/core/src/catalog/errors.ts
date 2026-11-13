import type { CatalogDiagnostic, CatalogResolution } from './types.js';

export class CatalogError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CatalogError';
    this.code = code;
    this.details = details;
  }
}

export class CatalogNotFoundError extends CatalogError {
  readonly resolution: CatalogResolution;

  constructor(resolution: CatalogResolution) {
    super('catalog.missing', 'No catalog was found in the checked locations.', {
      checkedLocations: resolution.checkedLocations,
    });
    this.name = 'CatalogNotFoundError';
    this.resolution = resolution;
  }
}

// Name used by callers that model discovery as a missing-catalog validation.
export const MissingCatalogError = CatalogNotFoundError;

export class CatalogConflictError extends CatalogError {
  readonly diagnostics: CatalogDiagnostic[];

  constructor(diagnostics: CatalogDiagnostic[], message = 'Catalog validation found conflicts.') {
    super('catalog.conflict', message, { diagnostics });
    this.name = 'CatalogConflictError';
    this.diagnostics = diagnostics;
  }
}
