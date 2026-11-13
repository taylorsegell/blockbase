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

export const TOKEN_VALUE_TYPES = ['color', 'dimension', 'font', 'duration', 'shadow', 'number', 'string'] as const;
export type TokenValueType = (typeof TOKEN_VALUE_TYPES)[number];

export type TokenDefinition = {
  name: string;
  role: string;
  valueType: TokenValueType;
  defaultValue: string;
  fallbackValue?: string;
  confidence: number;
};

export type CanonicalTokenContract = {
  schemaVersion: ContractVersion;
  contractId: string;
  tokens: TokenDefinition[];
};

function validateToken(value: unknown, index: number): void {
  const object = value as JsonObject;
  requiredString(object, 'name');
  requiredString(object, 'role');
  enumAt(object.valueType, `$.tokens[${index}].valueType`, TOKEN_VALUE_TYPES);
  requiredString(object, 'defaultValue');
  finiteNumberAt(object.confidence, `$.tokens[${index}].confidence`);
  if (object.fallbackValue !== undefined) stringAt(object.fallbackValue, `$.tokens[${index}].fallbackValue`);
}

export function parseTokenContract(input: unknown): CanonicalTokenContract {
  return parseVersioned<CanonicalTokenContract>(input, 'CanonicalTokenContract', (object) => {
    requiredString(object, 'contractId');
    requiredArray(object, 'tokens').forEach(validateToken);
  });
}
