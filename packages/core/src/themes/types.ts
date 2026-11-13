import type { ContractVersion, ProjectEvidence, ProjectProfile } from '@blockbase/contracts';

export const THEME_MODES = ['light', 'dark'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];
export const REQUIRED_THEME_ROLES = [
  'color.action.primary.background',
  'color.action.primary.foreground',
  'color.border.default',
  'color.surface.default',
  'color.surface.elevated',
  'color.text.muted',
  'color.text.primary',
] as const;
export type RequiredThemeRole = (typeof REQUIRED_THEME_ROLES)[number];

export type ThemeAlias = { alias: string };
export type ThemeValue = string | ThemeAlias;
export type ThemeModeValues = Record<string, ThemeValue>;

export type ThemeDerivation = {
  projectPath: string;
  evidence: ProjectEvidence[];
  profileHash: string;
};

export type ThemeManifest = {
  schemaVersion: ContractVersion;
  id: string;
  name: string;
  modes: Record<ThemeMode, ThemeModeValues>;
  reviewRequired?: boolean;
  reviewed?: boolean;
  derivedFrom?: ThemeDerivation;
};

export type StoredThemeManifest = ThemeManifest & {
  currentRevision: string;
  manifestVersion: number;
};

export type ThemeValidationIssue = {
  path: string;
  code: 'invalid-value' | 'invalid-mode' | 'alias-missing' | 'alias-cycle' | 'missing-role' | 'invalid-id' | 'invalid-shape' | 'unreviewed-draft';
  message: string;
  evidence?: string;
};

export type ThemeValidationResult = {
  valid: boolean;
  issues: ThemeValidationIssue[];
  warnings: string[];
  manifest?: ThemeManifest;
};

export type ThemeRevision = {
  revisionId: string;
  manifest: ThemeManifest;
  themePath: string;
  previewPath: string;
  previewCssHash: string;
};

export type ProjectThemeDraft = ThemeManifest & {
  reviewRequired: true;
  reviewed: false;
  derivedFrom: ThemeDerivation;
  projectProfile: ProjectProfile;
};

export type PreviewMapping = {
  role: string;
  customProperty: string;
  value: string;
};
