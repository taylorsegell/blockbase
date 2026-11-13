import { readFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CONTRACT_VERSION, stableStringify, type CanonicalTokenContract, type ProjectProfile } from '@blockbase/contracts';
import { sha256 } from '../import/local.js';
import { recordCatalogOperation } from '../store/history/git.js';
import { canonicalRoleValues } from './mapper.js';
import { ThemeError, ThemeValidationError } from './errors.js';
import { REQUIRED_THEME_ROLES, THEME_MODES, type PreviewMapping, type ProjectThemeDraft, type StoredThemeManifest, type ThemeAlias, type ThemeManifest, type ThemeMode, type ThemeModeValues, type ThemeRevision, type ThemeValidationIssue, type ThemeValidationResult, type ThemeValue } from './types.js';

const ID_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const COLOR_NAMES = new Set(['black', 'white', 'red', 'blue', 'green', 'transparent', 'currentcolor', 'inherit']);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function aliasTarget(value: ThemeValue): string | undefined {
  if (isObject(value) && typeof value.alias === 'string' && value.alias.length > 0) return value.alias;
  if (typeof value !== 'string') return undefined;
  const match = value.match(/^\$([a-zA-Z0-9_.-]+)$/) ?? value.match(/^alias\(([a-zA-Z0-9_.-]+)\)$/) ?? value.match(/^\{([a-zA-Z0-9_.-]+)\}$/);
  return match?.[1] ?? (typeof value === 'string' && /^[a-z][a-z0-9-]*(?:\.[a-z0-9_-]+)+$/.test(value) ? value : undefined);
}

function validRawValue(role: string, value: string): boolean {
  if (!value.trim() || value.includes('\n') || value.includes('\0') || /^var\(/.test(value)) return false;
  if (role.startsWith('color.')) return /^(?:#[\da-f]{3,8}|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)\([^)]*\)|[a-z]+)$/i.test(value.trim()) && (COLOR_NAMES.has(value.toLowerCase()) || value.startsWith('#') || /^[a-z-]+\(/i.test(value));
  if (role.startsWith('space.') || role.startsWith('radius.')) return /^(?:0|(?:-?\d+(?:\.\d+)?)(?:px|rem|em|%|vh|vw|ch|ex|cm|mm|in|pt|pc))$/i.test(value.trim());
  if (role.startsWith('motion.')) return /^-?(?:\d+(?:\.\d+)?)(?:ms|s)$/i.test(value.trim());
  return true;
}

function issue(path: string, code: ThemeValidationIssue['code'], message: string, evidence?: string): ThemeValidationIssue {
  return { path, code, message, ...(evidence ? { evidence } : {}) };
}

function validateMode(mode: string, values: unknown, issues: ThemeValidationIssue[]): void {
  const modePath = `$.modes.${mode}`;
  if (!(THEME_MODES as readonly string[]).includes(mode)) {
    issues.push(issue(modePath, 'invalid-mode', `Mode '${mode}' is not supported; expected one of ${THEME_MODES.join(', ')}.`));
    return;
  }
  if (!isObject(values)) {
    issues.push(issue(modePath, 'invalid-shape', 'Mode values must be an object.'));
    return;
  }
  for (const role of REQUIRED_THEME_ROLES) {
    if (!(role in values)) issues.push(issue(`${modePath}.${role}`, 'missing-role', `Required canonical role '${role}' is missing.`, `Required role evidence: ${role}.`));
  }
  for (const [role, raw] of Object.entries(values)) {
    const path = `${modePath}.${role}`;
    const target = aliasTarget(raw as ThemeValue);
    if (target) {
      if (!target.includes('.')) issues.push(issue(path, 'alias-missing', `Alias target '${target}' must name a canonical role.`));
      else if (!(target in values)) issues.push(issue(path, 'alias-missing', `Alias target '${target}' is not defined in mode '${mode}'.`));
      continue;
    }
    if (typeof raw !== 'string' || !validRawValue(role, raw)) issues.push(issue(path, 'invalid-value', `Value for '${role}' is not a valid canonical token value.`, `Received value: ${typeof raw === 'string' ? raw : String(raw)}.`));
  }
  for (const role of Object.keys(values)) {
    const seen: string[] = [];
    let current = role;
    while (true) {
      const next = aliasTarget(values[current] as ThemeValue);
      if (!next) break;
      const cycleAt = seen.indexOf(next);
      if (cycleAt >= 0) {
        const cycle = [...seen.slice(cycleAt), next];
        issues.push(issue(`${modePath}.${role}`, 'alias-cycle', `Alias cycle detected: ${cycle.join(' -> ')}.`, `Alias chain: ${cycle.join(' -> ')}.`));
        break;
      }
      if (!(next in values)) break;
      seen.push(current);
      current = next;
    }
  }
}

export function validateTheme(input: unknown, options: { requireReview?: boolean } = {}): ThemeValidationResult {
  const issues: ThemeValidationIssue[] = [];
  if (!isObject(input)) return { valid: false, issues: [issue('$', 'invalid-shape', 'Theme manifest must be an object.')], warnings: [] };
  if (input.schemaVersion !== CONTRACT_VERSION) issues.push(issue('$.schemaVersion', 'invalid-shape', `Theme schemaVersion must equal '${CONTRACT_VERSION}'.`));
  if (typeof input.id !== 'string' || !ID_PATTERN.test(input.id)) issues.push(issue('$.id', 'invalid-id', 'Theme id must contain only lowercase letters, numbers, hyphens, or underscores.'));
  if (typeof input.name !== 'string' || !input.name.trim()) issues.push(issue('$.name', 'invalid-shape', 'Theme name must be a non-empty string.'));
  if (!isObject(input.modes) || Object.keys(input.modes).length === 0) issues.push(issue('$.modes', 'invalid-shape', 'Theme modes must contain at least one mode.'));
  else for (const [mode, values] of Object.entries(input.modes)) validateMode(mode, values, issues);
  if (input.reviewRequired === true && options.requireReview !== false && input.reviewed !== true) issues.push(issue('$.reviewed', 'unreviewed-draft', 'Project-derived theme drafts require review before registration.'));
  if (input.derivedFrom !== undefined) {
    if (!isObject(input.derivedFrom) || typeof input.derivedFrom.projectPath !== 'string' || !Array.isArray(input.derivedFrom.evidence) || typeof input.derivedFrom.profileHash !== 'string') issues.push(issue('$.derivedFrom', 'invalid-shape', 'derivedFrom must include projectPath, evidence, and profileHash.'));
  }
  if (issues.length > 0) return { valid: false, issues, warnings: [] };
  const modes = input.modes as Record<ThemeMode, ThemeModeValues>;
  return { valid: true, issues: [], warnings: [], manifest: { schemaVersion: CONTRACT_VERSION, id: input.id as string, name: input.name as string, modes, ...(input.reviewRequired === true ? { reviewRequired: true as const, reviewed: input.reviewed === true } : {}), ...(input.derivedFrom ? { derivedFrom: input.derivedFrom as ThemeManifest['derivedFrom'] } : {}) } };
}

export function parseThemeManifest(input: unknown, options: { requireReview?: boolean } = {}): ThemeManifest {
  const result = validateTheme(input, options);
  if (!result.valid || !result.manifest) throw new ThemeValidationError(result.issues);
  return result.manifest;
}

export async function readThemeManifest(path: string, options: { requireReview?: boolean } = {}): Promise<ThemeManifest> {
  let value: unknown;
  try { value = JSON.parse(await readFile(resolve(path), 'utf8')); }
  catch (error) { throw new ThemeError('THEME_SOURCE_NOT_FOUND', `The theme manifest could not be read: ${resolve(path)}.`, { path: resolve(path), cause: error instanceof Error ? error.message : String(error) }); }
  return parseThemeManifest(value, options);
}

function resolvedValues(theme: ThemeManifest, mode: ThemeMode, roles?: readonly string[]): PreviewMapping[] {
  const values = theme.modes[mode];
  const resolveValue = (role: string, seen = new Set<string>()): string => {
    if (seen.has(role)) throw new ThemeValidationError([issue(`$.modes.${mode}.${role}`, 'alias-cycle', `Alias cycle detected while resolving '${role}'.`)]);
    const value = values[role];
    const target = aliasTarget(value);
    if (target) return resolveValue(target, new Set([...seen, role]));
    return String(value);
  };
  return (roles ? [...new Set(roles)].filter((role) => role in values) : Object.keys(values)).sort().map((role) => ({ role, customProperty: `--${role.replaceAll('.', '-')}`, value: resolveValue(role) }));
}

export function emitPreviewCss(theme: ThemeManifest, options: { scope?: string; mode?: ThemeMode; tokenContract?: CanonicalTokenContract } = {}): { css: string; mappings: PreviewMapping[] } {
  const scope = options.scope ?? '.blockbase-preview';
  const modes = options.mode ? [options.mode] : THEME_MODES.filter((mode) => theme.modes[mode]);
  const roles = options.tokenContract?.tokens.map((token) => token.name);
  const mappings = modes.flatMap((mode) => resolvedValues(theme, mode, roles));
  const blocks = modes.map((mode) => {
    const values = resolvedValues(theme, mode, roles);
    return `${scope}[data-theme="${theme.id}"][data-mode="${mode}"] {\n${values.map((mapping) => `  ${mapping.customProperty}: ${mapping.value};`).join('\n')}\n}`;
  });
  return { css: `${blocks.join('\n\n')}\n`, mappings };
}

export const emitScopedPreview = emitPreviewCss;

export function starterTheme(id: string, name = id): ThemeManifest {
  const base: ThemeModeValues = {
    'color.action.primary.background': '#2563eb',
    'color.action.primary.foreground': '#ffffff',
    'color.border.default': '#d1d5db',
    'color.surface.default': '#ffffff',
    'color.surface.elevated': '#f9fafb',
    'color.text.muted': '#6b7280',
    'color.text.primary': '#111827',
  };
  const dark: ThemeModeValues = { ...base, 'color.action.primary.background': '#60a5fa', 'color.action.primary.foreground': '#111827', 'color.border.default': '#374151', 'color.surface.default': '#111827', 'color.surface.elevated': '#1f2937', 'color.text.muted': '#9ca3af', 'color.text.primary': '#f9fafb' };
  return { schemaVersion: CONTRACT_VERSION, id, name, modes: { light: base, dark } };
}

export async function writeStarterTheme(path: string, id: string, name = id): Promise<string> {
  const destination = resolve(path);
  try { await stat(destination); throw new ThemeError('THEME_ALREADY_EXISTS', `Theme starter already exists at '${destination}'.`, { path: destination }); } catch (error) { if (error instanceof ThemeError) throw error; }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, stableStringify(starterTheme(id, name)));
  return destination;
}

export class ThemeRegistry {
  readonly catalogRoot: string;

  constructor(options: { catalogRoot: string }) { this.catalogRoot = resolve(options.catalogRoot); }

  async register(input: ThemeManifest | string): Promise<ThemeRevision> {
    return recordCatalogOperation<ThemeRevision>(this.catalogRoot, { operation: 'theme.add', summary: (revision) => `theme add ${revision.manifest.id}` }, () => this.writeTheme(input));
  }

  private async writeTheme(input: ThemeManifest | string): Promise<ThemeRevision> {
    const manifest = typeof input === 'string' ? await readThemeManifest(input) : parseThemeManifest(input);
    const validation = validateTheme(manifest);
    if (!validation.valid) throw new ThemeValidationError(validation.issues);
    const revisionId = sha256(stableStringify(manifest));
    const themePath = join(this.catalogRoot, 'themes', manifest.id);
    const revisionRoot = join(themePath, 'revisions', revisionId.slice('sha256:'.length));
    try { await stat(themePath); throw new ThemeError('THEME_DUPLICATE_ID', `Theme id '${manifest.id}' is already registered.`, { id: manifest.id, path: themePath }); } catch (error) { if (error instanceof ThemeError) throw error; }
    const preview = emitPreviewCss(manifest);
    await mkdir(dirname(revisionRoot), { recursive: true });
    await mkdir(revisionRoot);
    await writeFile(join(revisionRoot, 'theme.json'), stableStringify(manifest));
    const previewCss = `/* Generated from theme.json; revision ${revisionId}. */\n${preview.css}`;
    await writeFile(join(revisionRoot, 'preview.css'), previewCss);
    const stored: StoredThemeManifest = { ...manifest, currentRevision: revisionId, manifestVersion: 1 };
    await writeFile(join(themePath, 'theme.json'), stableStringify(stored));
    await writeFile(join(themePath, 'preview.css'), previewCss);
    return { revisionId, manifest, themePath: join(themePath, 'theme.json'), previewPath: join(themePath, 'preview.css'), previewCssHash: sha256(previewCss) };
  }

  async read(id: string): Promise<StoredThemeManifest> {
    const path = join(this.catalogRoot, 'themes', id, 'theme.json');
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    const manifest = parseThemeManifest(value, { requireReview: false });
    const stored = value as Partial<StoredThemeManifest>;
    if (typeof stored.currentRevision !== 'string' || typeof stored.manifestVersion !== 'number') throw new ThemeError('THEME_INVALID_REGISTRATION', `Registered theme '${id}' has no immutable revision metadata.`, { path });
    return { ...manifest, currentRevision: stored.currentRevision, manifestVersion: stored.manifestVersion };
  }
}

export async function registerTheme(input: ThemeManifest | string, catalogRoot: string): Promise<ThemeRevision> {
  return new ThemeRegistry({ catalogRoot }).register(input);
}

export function deriveThemeFromProject(profile: ProjectProfile, options: { id?: string; name?: string } = {}): ProjectThemeDraft {
  const id = options.id ?? 'project-draft';
  const mappings = canonicalRoleValues(REQUIRED_THEME_ROLES, profile);
  const light: ThemeModeValues = {};
  for (const mapping of mappings) if (mapping.value !== undefined) light[mapping.sourceToken] = mapping.value;
  const dark: ThemeModeValues = { ...light };
  const profileHash = sha256(stableStringify(profile));
  return { schemaVersion: CONTRACT_VERSION, id, name: options.name ?? `Project draft (${profile.framework.name})`, modes: { light, dark }, reviewRequired: true, reviewed: false, derivedFrom: { projectPath: profile.projectPath, evidence: profile.evidence.map((entry) => ({ ...entry })), profileHash }, projectProfile: profile };
}
