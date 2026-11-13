import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { parseAdaptationBundle, parseValidationResult, type AdaptationBundle, type ValidationResult } from '@blockbase/contracts';
import { createApplyPlan, AdaptationError } from '../adapt/index.js';

export type ValidationOptions = {
  projectPath?: string;
  timeoutMs?: number;
};

export class ValidationError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.details = details;
  }
}

function commandParts(command: string): [string, string[]] {
  // Validation commands originate in the inspected package.json. Refuse shell
  // syntax so a manifest cannot turn validation into an arbitrary shell hook.
  if (!command.trim() || /[;&|><`$(){}]/.test(command)) throw new ValidationError('VALIDATE_COMMAND_UNSAFE', 'The validation command contains unsupported shell syntax.', { command });
  const parts = command.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^(['"])(.*)\1$/, '$2')) ?? [];
  if (parts.length === 0) throw new ValidationError('VALIDATE_COMMAND_INVALID', 'The validation command is empty.', { command });
  return [parts[0], parts.slice(1)];
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<{ status: 'passed' | 'failed' | 'skipped'; exitCode?: number; output?: string }> {
  const [executable, args] = commandParts(command);
  return new Promise((resolveResult) => {
    const child = spawn(executable, args, { cwd, shell: false, env: process.env });
    let output = '';
    let settled = false;
    const finish = (result: { status: 'passed' | 'failed' | 'skipped'; exitCode?: number; output?: string }) => {
      if (settled) return;
      settled = true;
      resolveResult({ ...result, ...(output ? { output: output.slice(0, 16_384) } : {}) });
    };
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('error', (error) => finish({ status: 'failed', exitCode: 127, output: error.message }));
    child.on('close', (code) => finish({ status: code === 0 ? 'passed' : 'failed', exitCode: code ?? 1 }));
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ status: 'failed', exitCode: 124, output: `Command timed out after ${timeoutMs}ms.` });
    }, timeoutMs);
    child.on('close', () => clearTimeout(timer));
  });
}

function boundedFixes(commands: ValidationResult['commands']): NonNullable<ValidationResult['fixes']> {
  return commands.filter((command) => command.status === 'failed').slice(0, 3).map((command) => ({
    path: '<destination>',
    action: `Review the output from '${command.command}' and correct only the reported destination error.`,
    reason: (command.output ?? 'The destination command returned a non-zero exit code.').split('\n').find(Boolean) ?? 'The destination check failed.',
  }));
}

export async function validateAdaptation(bundle: AdaptationBundle, options: ValidationOptions = {}): Promise<ValidationResult> {
  const projectPath = resolve(options.projectPath ?? bundle.projectPath);
  if (bundle.projectPath && resolve(bundle.projectPath) !== projectPath) throw new ValidationError('VALIDATE_PROJECT_MISMATCH', 'The validation project does not match the bundle project.', { expected: bundle.projectPath, received: projectPath });
  let plan;
  try {
    parseAdaptationBundle(bundle);
    plan = await createApplyPlan({ ...bundle, projectPath });
  } catch (error) {
    if (error instanceof AdaptationError) throw new ValidationError(error.code, error.message, error.details);
    throw error;
  }
  if (plan.blocked.length > 0) {
    const result = {
      schemaVersion: '1' as const,
      bundleId: bundle.bundleId,
      status: 'blocked' as const,
      commands: bundle.validationCommands.map((command) => ({ command, status: 'skipped' as const, output: plan.blocked.join('\n') })),
      residuals: plan.blocked.slice().sort(),
      warnings: bundle.warnings.slice().sort(),
      fixes: plan.blocked.slice(0, 3).map((item) => ({ path: item.split(':')[0], action: 'Re-prepare the adaptation and review the changed destination target.', reason: item })),
    };
    return parseValidationResult(result);
  }
  const commands = [] as ValidationResult['commands'];
  for (const command of bundle.validationCommands) {
    const result = await runCommand(command, projectPath, options.timeoutMs ?? 120_000);
    commands.push({ command, ...result });
  }
  const residuals = bundle.residuals.slice().sort();
  const warnings = bundle.warnings.slice().sort();
  const status = commands.some((command) => command.status === 'failed') ? 'failed' : residuals.length > 0 ? 'blocked' : 'passed';
  return parseValidationResult({ schemaVersion: '1', bundleId: bundle.bundleId, status, commands, residuals, warnings, fixes: status === 'failed' ? boundedFixes(commands) : [] });
}

export async function readAdaptationBundle(path: string): Promise<AdaptationBundle> {
  const inputPath = resolve(path);
  const raw = JSON.parse(await readFile(inputPath, 'utf8')) as unknown;
  try {
    return parseAdaptationBundle(raw);
  } catch (error) {
    const sibling = resolve(dirname(inputPath), basename(inputPath) === 'manifest.json' ? 'bundle.json' : 'adaptation.json');
    try {
      return parseAdaptationBundle(JSON.parse(await readFile(sibling, 'utf8')));
    } catch {
      throw new ValidationError('VALIDATE_MANIFEST_INVALID', 'The adaptation manifest or its sibling bundle is invalid.', { path: inputPath, cause: error instanceof Error ? error.message : String(error) });
    }
  }
}

export const validateBundle = validateAdaptation;
