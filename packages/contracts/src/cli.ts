import {
  enumAt,
  parseVersioned,
  requiredObject,
  requiredString,
  stringArrayAt,
  type ContractVersion,
  type JsonObject,
} from './runtime.js';

export const OPERATION_NAMES = [
  'catalog.migrate',
  'catalog.locate',
  'catalog.list',
  'catalog.rebuild',
  'catalog.validate',
  'doctor',
  'import',
  'search',
  'inspect',
  'project.inspect',
  'adapt',
  'add',
  'validate',
  'agent.link',
  'agent.check',
  'agent.unlink',
  'agent.install',
  'agent.update',
  'agent.remove',
  'inbox.add',
  'inbox.list',
  'inbox.show',
  'inbox.import',
  'inbox.discard',
  'tag.add',
  'tag.remove',
  'tag.list',
  'collection.create',
  'collection.add',
  'collection.remove',
  'collection.reorder',
  'collection.delete',
  'collection.list',
  'family.set',
  'family.list',
  'history.list',
  'history.undo',
  'history.restore',
  'setup',
  'ui',
  'ui.status',
  'ui.service.install',
  'ui.service.uninstall',
  'ui.service.status',
] as const;
export type OperationName = (typeof OPERATION_NAMES)[number];

export const EXIT_CODES = {
  ok: 0,
  usage: 2,
  notFound: 3,
  invalidInput: 4,
  conflict: 5,
  unsupported: 6,
  validationFailed: 7,
  internal: 10,
} as const;
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export type CliWarning = {
  code: string;
  message: string;
  path?: string;
};

export type RecoveryAction = {
  id: string;
  label: string;
  safe: boolean;
  command?: string;
};

export type CliError = {
  code: string;
  message: string;
  details?: JsonObject;
};

export type CliSuccessEnvelope<T> = {
  schemaVersion: ContractVersion;
  ok: true;
  operation: OperationName;
  data: T;
  warnings: CliWarning[];
};

export type CliErrorEnvelope = {
  schemaVersion: ContractVersion;
  ok: false;
  operation: OperationName;
  error: CliError;
  warnings: CliWarning[];
  recoveryActions: RecoveryAction[];
};

function validateWarnings(value: unknown): void {
  if (!Array.isArray(value)) throw new Error('$.warnings must be an array');
  value.forEach((entry, index) => {
    const warning = entry as JsonObject;
    requiredString(warning, 'code');
    requiredString(warning, 'message');
    if (warning.path !== undefined) requiredString(warning, 'path');
    void index;
  });
}

export function parseCliSuccessEnvelope<T>(input: unknown): CliSuccessEnvelope<T> {
  return parseVersioned<CliSuccessEnvelope<T>>(input, 'CliSuccessEnvelope', (object) => {
    if (object.ok !== true) throw new Error('$.ok must equal true');
    enumAt(object.operation, '$.operation', OPERATION_NAMES);
    if (object.data === undefined) throw new Error('$.data is required');
    validateWarnings(object.warnings);
  });
}

export function parseCliErrorEnvelope(input: unknown): CliErrorEnvelope {
  return parseVersioned<CliErrorEnvelope>(input, 'CliErrorEnvelope', (object) => {
    if (object.ok !== false) throw new Error('$.ok must equal false');
    enumAt(object.operation, '$.operation', OPERATION_NAMES);
    const error = requiredObject(object, 'error');
    requiredString(error, 'code');
    requiredString(error, 'message');
    validateWarnings(object.warnings);
    if (!Array.isArray(object.recoveryActions)) throw new Error('$.recoveryActions must be an array');
    object.recoveryActions.forEach((entry) => {
      const action = entry as JsonObject;
      requiredString(action, 'id');
      requiredString(action, 'label');
      if (typeof action.safe !== 'boolean') throw new Error('$.recoveryActions.safe must be a boolean');
      if (action.command !== undefined) requiredString(action, 'command');
    });
  });
}

export function isOperationName(value: string): value is OperationName {
  return (OPERATION_NAMES as readonly string[]).includes(value);
}

export function warningsFor(...warnings: CliWarning[]): CliWarning[] {
  return warnings.map((warning) => ({ ...warning }));
}

export function recoveryActionsFor(...actions: RecoveryAction[]): RecoveryAction[] {
  return actions.map((action) => ({ ...action }));
}
