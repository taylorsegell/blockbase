import {
  enumAt,
  parseVersioned,
  requiredArray,
  requiredObject,
  requiredString,
  stringAt,
  stringArrayAt,
  type JsonObject,
} from './runtime.js';
import type { ContractVersion } from './runtime.js';

export const VALIDATION_STATUSES = ['passed', 'failed', 'blocked'] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

export type ValidationCommandResult = {
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  exitCode?: number;
  output?: string;
};

export type ValidationResult = {
  schemaVersion: ContractVersion;
  bundleId: string;
  status: ValidationStatus;
  commands: ValidationCommandResult[];
  residuals: string[];
  warnings: string[];
  fixes?: Array<{ path: string; action: string; reason: string }>;
};

function validateCommand(value: unknown, index: number): void {
  const object = value as JsonObject;
  requiredString(object, 'command');
  stringAt(object.status, `$.commands[${index}].status`);
  if (object.output !== undefined) stringAt(object.output, `$.commands[${index}].output`);
}

export function parseValidationResult(input: unknown): ValidationResult {
  return parseVersioned<ValidationResult>(input, 'ValidationResult', (object) => {
    requiredString(object, 'bundleId');
    enumAt(object.status, '$.status', VALIDATION_STATUSES);
    requiredArray(object, 'commands').forEach(validateCommand);
    stringArrayAt(object.residuals, '$.residuals');
    stringArrayAt(object.warnings, '$.warnings');
    if (object.fixes !== undefined) {
      requiredArray(object, 'fixes').forEach((entry, index) => {
        const fix = entry as JsonObject;
        requiredString(fix, 'path');
        requiredString(fix, 'action');
        requiredString(fix, 'reason');
        void index;
      });
    }
  });
}
