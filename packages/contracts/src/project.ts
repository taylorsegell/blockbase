import {
  parseVersioned,
  requiredArray,
  requiredObject,
  requiredString,
  stringAt,
  stringArrayAt,
  type JsonObject,
} from './runtime.js';
import type { ContractVersion } from './runtime.js';

export type ProjectEvidence = {
  path: string;
  source: 'package.json' | 'lockfile' | 'config' | 'source' | 'override';
  fact: string;
  confidence: 'high' | 'medium' | 'low';
};

export type ProjectProfile = {
  schemaVersion: ContractVersion;
  projectPath: string;
  framework: {
    name: string;
    version?: string;
  };
  language: {
    name: string;
    moduleFormat: 'esm' | 'commonjs' | 'mixed';
  };
  styling: {
    systems: string[];
    tokenFiles: string[];
  };
  tokens: {
    values: Record<string, string>;
    aliases: Record<string, string>;
  };
  dependencies: {
    runtime: Record<string, string>;
    development: Record<string, string>;
  };
  conventions: {
    componentDirectory: string;
    filenameCase: 'kebab' | 'pascal' | 'camel' | 'mixed';
    importAlias?: string;
  };
  validationCommands: string[];
  evidence: ProjectEvidence[];
  conflicts: string[];
};

function validateRecord(value: unknown, path: string): void {
  const object = value as JsonObject;
  if (object === null || typeof object !== 'object' || Array.isArray(object)) {
    throw new Error(`${path} must be an object`);
  }
  for (const [key, entry] of Object.entries(object)) stringAt(entry, `${path}.${key}`);
}

function validateEvidence(value: unknown, index: number): void {
  const object = value as JsonObject;
  requiredString(object, 'path');
  stringAt(object.source, `$.evidence[${index}].source`);
  requiredString(object, 'fact');
  stringAt(object.confidence, `$.evidence[${index}].confidence`);
}

export function parseProjectProfile(input: unknown): ProjectProfile {
  return parseVersioned<ProjectProfile>(input, 'ProjectProfile', (object) => {
    requiredString(object, 'projectPath');
    const framework = requiredObject(object, 'framework');
    requiredString(framework, 'name');
    if (framework.version !== undefined) stringAt(framework.version, '$.framework.version');
    const language = requiredObject(object, 'language');
    requiredString(language, 'name');
    stringAt(language.moduleFormat, '$.language.moduleFormat');
    const styling = requiredObject(object, 'styling');
    stringArrayAt(styling.systems, '$.styling.systems');
    stringArrayAt(styling.tokenFiles, '$.styling.tokenFiles');
    const tokens = requiredObject(object, 'tokens');
    validateRecord(tokens.values, '$.tokens.values');
    validateRecord(tokens.aliases, '$.tokens.aliases');
    const dependencies = requiredObject(object, 'dependencies');
    validateRecord(dependencies.runtime, '$.dependencies.runtime');
    validateRecord(dependencies.development, '$.dependencies.development');
    const conventions = requiredObject(object, 'conventions');
    requiredString(conventions, 'componentDirectory');
    stringAt(conventions.filenameCase, '$.conventions.filenameCase');
    if (conventions.importAlias !== undefined) stringAt(conventions.importAlias, '$.conventions.importAlias');
    requiredArray(object, 'validationCommands').forEach((command, index) => stringAt(command, `$.validationCommands[${index}]`));
    requiredArray(object, 'evidence').forEach(validateEvidence);
    stringArrayAt(object.conflicts, '$.conflicts');
  });
}
