import {
  enumAt,
  finiteNumberAt,
  parseVersioned,
  requiredArray,
  requiredString,
  stringAt,
  type JsonObject,
} from './runtime.js';
import type { ContractVersion } from './runtime.js';

export const NORMALIZATION_STATUSES = ['complete', 'partial', 'unsupported'] as const;
export type NormalizationStatus = (typeof NORMALIZATION_STATUSES)[number];

export type NormalizationResidual = {
  path: string;
  kind: 'unsupported-syntax' | 'unresolved-token' | 'unresolved-import' | 'ambiguous';
  reason: string;
  source?: string;
  line?: number;
  column?: number;
};

export type NormalizationReport = {
  schemaVersion: ContractVersion;
  sourceHash: string;
  normalizerVersion: string;
  status: NormalizationStatus;
  coverage: {
    total: number;
    normalized: number;
    residual: number;
  };
  residuals: NormalizationResidual[];
  warnings: string[];
};

function validateResidual(value: unknown, index: number): void {
  const object = value as JsonObject;
  requiredString(object, 'path');
  stringAt(object.kind, `$.residuals[${index}].kind`);
  requiredString(object, 'reason');
  if (object.source !== undefined) stringAt(object.source, `$.residuals[${index}].source`);
}

export function parseNormalizationReport(input: unknown): NormalizationReport {
  return parseVersioned<NormalizationReport>(input, 'NormalizationReport', (object) => {
    requiredString(object, 'sourceHash');
    requiredString(object, 'normalizerVersion');
    enumAt(object.status, '$.status', NORMALIZATION_STATUSES);
    const coverage = object.coverage as JsonObject;
    finiteNumberAt(coverage?.total, '$.coverage.total');
    finiteNumberAt(coverage?.normalized, '$.coverage.normalized');
    finiteNumberAt(coverage?.residual, '$.coverage.residual');
    requiredArray(object, 'residuals').forEach(validateResidual);
    requiredArray(object, 'warnings').forEach((warning, index) => stringAt(warning, `$.warnings[${index}]`));
  });
}
