import type { ThemeValidationIssue } from './types.js';

export class ThemeError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ThemeError';
    this.code = code;
    this.details = details;
  }
}
export class ThemeValidationError extends ThemeError {
  readonly issues: ThemeValidationIssue[];

  constructor(issues: ThemeValidationIssue[]) {
    super('THEME_INVALID', `Theme validation failed with ${issues.length} issue(s).`, { issues });
    this.name = 'ThemeValidationError';
    this.issues = issues;
  }
}
