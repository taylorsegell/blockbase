import {
  enumAt,
  optionalString,
  parseVersioned,
  requiredArray,
  requiredObject,
  requiredString,
  stringAt,
  stringArrayAt,
  type JsonObject,
} from './runtime.js';
import type { ContractVersion } from './runtime.js';

export const SOURCE_TYPES = ['file', 'directory', 'stdin', 'paste', 'url', 'adapter'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export type SourceFile = {
  path: string;
  content: string;
  contentHash: string;
};

export type SourceAsset = {
  path: string;
  mediaType: string;
  contentHash: string;
};

export type SourceProvenance = {
  sourceType: SourceType;
  locator: string;
  fetchedAt?: string;
  adapterId?: string;
};

export type SourceEnvelope = {
  schemaVersion: ContractVersion;
  sourceType: SourceType;
  files: SourceFile[];
  assets: SourceAsset[];
  entryPoint?: string;
  provenance: SourceProvenance;
};

function validateSourceFile(value: unknown, index: number): void {
  const object = value as JsonObject;
  stringAt(object?.path, `$.files[${index}].path`);
  if (typeof object?.content !== 'string') throw new Error(`$.files[${index}].content must be a string`);
  stringAt(object?.contentHash, `$.files[${index}].contentHash`);
}

function validateSourceAsset(value: unknown, index: number): void {
  const object = value as JsonObject;
  stringAt(object?.path, `$.assets[${index}].path`);
  stringAt(object?.mediaType, `$.assets[${index}].mediaType`);
  stringAt(object?.contentHash, `$.assets[${index}].contentHash`);
}

export function parseSourceEnvelope(input: unknown): SourceEnvelope {
  return parseVersioned<SourceEnvelope>(input, 'SourceEnvelope', (object) => {
    enumAt(object.sourceType, '$.sourceType', SOURCE_TYPES);
    requiredArray(object, 'files').forEach(validateSourceFile);
    requiredArray(object, 'assets').forEach(validateSourceAsset);
    const provenance = requiredObject(object, 'provenance');
    enumAt(provenance.sourceType, '$.provenance.sourceType', SOURCE_TYPES);
    stringAt(provenance.locator, '$.provenance.locator');
    optionalString(object, 'entryPoint');
    optionalString(provenance, 'fetchedAt');
    optionalString(provenance, 'adapterId');
  });
}

export function sourceFilePaths(source: SourceEnvelope): string[] {
  return stringArrayAt(source.files.map((file) => file.path), '$.files');
}
