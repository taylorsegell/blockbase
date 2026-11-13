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

export type AdaptedFile = {
  path: string;
  content: string;
  operation: 'create' | 'replace' | 'patch';
  contentHash: string;
  /** Hash of the destination file observed during preparation, when it exists. */
  targetHash?: string;
};

export type TokenMapping = {
  sourceToken: string;
  destinationExpression: string;
  confidence: 'high' | 'medium' | 'low';
};

export type DependencyDelta = {
  add: Array<{ name: string; range: string; kind: 'runtime' | 'development' }>;
  remove: string[];
  conflicts: string[];
};

export type AdaptationManifest = {
  schemaVersion: ContractVersion;
  bundleId: string;
  componentId: string;
  revisionId: string;
  generatedAt: string;
  files: Array<{ path: string; operation: AdaptedFile['operation']; contentHash: string; targetHash?: string }>;
  validationCommands: string[];
  /** Absolute destination root captured during preparation. */
  projectPath?: string;
};

export type AdaptationBundle = {
  schemaVersion: ContractVersion;
  bundleId: string;
  componentId: string;
  revisionId: string;
  projectPath: string;
  manifest: AdaptationManifest;
  files: AdaptedFile[];
  tokenMappings: TokenMapping[];
  dependencyDelta: DependencyDelta;
  placement: {
    directory: string;
    importPath: string;
  };
  providers: string[];
  residuals: string[];
  warnings: string[];
  risk: 'low' | 'medium' | 'high';
  validationCommands: string[];
  provenance?: {
    sourceType: string;
    locator: string;
    license: string;
    attributionStatus: string;
    sourceHash: string;
  };
};

function validateFiles(value: unknown, path: string, includeContent: boolean): void {
  requiredArray({ value }, 'value').forEach((entry, index) => {
    const file = entry as JsonObject;
    requiredString(file, 'path');
    stringAt(file.operation, `${path}[${index}].operation`);
    requiredString(file, 'contentHash');
    if (file.targetHash !== undefined) requiredString(file, 'targetHash');
    if (includeContent && typeof file.content !== 'string') throw new Error(`${path}[${index}].content must be a string`);
  });
}

function validateDependencyDelta(value: unknown): void {
  const object = value as JsonObject;
  requiredArray(object, 'add').forEach((entry, index) => {
    const dependency = entry as JsonObject;
    requiredString(dependency, 'name');
    requiredString(dependency, 'range');
    stringAt(dependency.kind, `$.dependencyDelta.add[${index}].kind`);
  });
  stringArrayAt(object.remove, '$.dependencyDelta.remove');
  stringArrayAt(object.conflicts, '$.dependencyDelta.conflicts');
}

function validateManifest(value: unknown): void {
  const object = value as JsonObject;
  if (object.schemaVersion !== '1') throw new Error('$.manifest.schemaVersion must equal 1');
  requiredString(object, 'bundleId');
  requiredString(object, 'componentId');
  requiredString(object, 'revisionId');
  requiredString(object, 'generatedAt');
  validateFiles(object.files, '$.manifest.files', false);
  stringArrayAt(object.validationCommands, '$.manifest.validationCommands');
  if (object.projectPath !== undefined) requiredString(object, 'projectPath');
}

export function parseAdaptationBundle(input: unknown): AdaptationBundle {
  return parseVersioned<AdaptationBundle>(input, 'AdaptationBundle', (object) => {
    requiredString(object, 'bundleId');
    requiredString(object, 'componentId');
    requiredString(object, 'revisionId');
    requiredString(object, 'projectPath');
    validateManifest(requiredObject(object, 'manifest'));
    validateFiles(object.files, '$.files', true);
    requiredArray(object, 'tokenMappings').forEach((entry, index) => {
      const mapping = entry as JsonObject;
      requiredString(mapping, 'sourceToken');
      requiredString(mapping, 'destinationExpression');
      stringAt(mapping.confidence, `$.tokenMappings[${index}].confidence`);
    });
    validateDependencyDelta(requiredObject(object, 'dependencyDelta'));
    const placement = requiredObject(object, 'placement');
    requiredString(placement, 'directory');
    requiredString(placement, 'importPath');
    stringArrayAt(object.providers, '$.providers');
    stringArrayAt(object.residuals, '$.residuals');
    stringArrayAt(object.warnings, '$.warnings');
    enumAt(object.risk, '$.risk', ['low', 'medium', 'high']);
    stringArrayAt(object.validationCommands, '$.validationCommands');
    if (object.provenance !== undefined) {
      const provenance = requiredObject(object, 'provenance');
      requiredString(provenance, 'sourceType');
      requiredString(provenance, 'locator');
      requiredString(provenance, 'license');
      requiredString(provenance, 'attributionStatus');
      requiredString(provenance, 'sourceHash');
    }
  });
}
