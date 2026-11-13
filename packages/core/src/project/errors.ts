export const PROJECT_ERROR_CODES = {
  projectNotFound: 'PROJECT_NOT_FOUND',
  invalidPackage: 'PROJECT_INVALID_PACKAGE',
  invalidOverride: 'PROJECT_INVALID_OVERRIDE',
  unsupportedFramework: 'PROJECT_UNSUPPORTED_FRAMEWORK',
  conflict: 'PROJECT_CONFLICT',
} as const;

export type ProjectErrorCode = (typeof PROJECT_ERROR_CODES)[keyof typeof PROJECT_ERROR_CODES];

export class ProjectInspectionError extends Error {
  readonly code: ProjectErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ProjectErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ProjectInspectionError';
    this.code = code;
    this.details = details;
  }
}
