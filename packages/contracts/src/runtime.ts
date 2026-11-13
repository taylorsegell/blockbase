export const CONTRACT_VERSION = '1' as const;
export type ContractVersion = typeof CONTRACT_VERSION;

export type JsonObject = Record<string, unknown>;

export type ContractIssue = {
  path: string;
  message: string;
};

export class ContractValidationError extends Error {
  readonly issues: ContractIssue[];

  constructor(schema: string, issues: ContractIssue[]) {
    super(`${schema} is invalid: ${issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`);
    this.name = 'ContractValidationError';
    this.issues = issues;
  }
}

export function objectAt(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractValidationError('contract', [{ path, message: 'must be an object' }]);
  }
  return value as JsonObject;
}

export function stringAt(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ContractValidationError('contract', [{ path, message: 'must be a non-empty string' }]);
  }
  return value;
}

export function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ContractValidationError('contract', [{ path, message: 'must be an array' }]);
  }
  return value;
}

export function recordAt(value: unknown, path: string): JsonObject {
  return objectAt(value, path);
}

export function stringArrayAt(value: unknown, path: string): string[] {
  return arrayAt(value, path).map((item, index) => stringAt(item, `${path}[${index}]`));
}

export function versionedObject(input: unknown, schema: string): JsonObject {
  const object = objectAt(input, '$');
  if (object.schemaVersion !== CONTRACT_VERSION) {
    throw new ContractValidationError(schema, [
      { path: '$.schemaVersion', message: `must equal '${CONTRACT_VERSION}'` },
    ]);
  }
  return object;
}

export function parseVersioned<T>(input: unknown, schema: string, validate: (object: JsonObject) => void): T {
  const object = versionedObject(input, schema);
  try {
    validate(object);
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw new ContractValidationError(schema, error.issues);
    }
    throw error;
  }
  return object as T;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

export function requiredString(object: JsonObject, key: string): string {
  return stringAt(object[key], `$.${key}`);
}

export function requiredArray(object: JsonObject, key: string): unknown[] {
  return arrayAt(object[key], `$.${key}`);
}

export function requiredObject(object: JsonObject, key: string): JsonObject {
  return objectAt(object[key], `$.${key}`);
}

export function optionalString(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return value === undefined ? undefined : stringAt(value, `$.${key}`);
}

export function enumAt<T extends string>(value: unknown, path: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new ContractValidationError('contract', [
      { path, message: `must be one of ${values.map((entry) => `'${entry}'`).join(', ')}` },
    ]);
  }
  return value as T;
}

export function finiteNumberAt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ContractValidationError('contract', [{ path, message: 'must be a finite number' }]);
  }
  return value;
}

export function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ContractValidationError('contract', [{ path, message: 'must be a boolean' }]);
  }
  return value;
}
