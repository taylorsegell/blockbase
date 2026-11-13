import type { ProjectThemeDraft, ThemeManifest, ThemeMode, PreviewMapping } from '../themes/types.js';
import { emitPreviewCss, validateTheme } from '../themes/registry.js';
import { REQUIRED_THEME_ROLES } from '../themes/types.js';
import { PREVIEW_CSP } from './sandbox.js';
import { startPreviewSession, type PreviewRequest, type PreviewRunnerOptions, type PreviewSession, type PreviewStartResult } from './runner.js';
import type { PreviewRefusalResult } from './policy.js';

export type PreviewThemeInput = ThemeManifest | ProjectThemeDraft;

export type PreviewThemeResolution = {
  schemaVersion: '1';
  themeId: string;
  themeName: string;
  mode: ThemeMode;
  provenance: 'saved' | 'project-derived';
  evidenceOnly: boolean;
  reviewed: boolean;
  renderable: boolean;
  mappings: PreviewMapping[];
  missingRoles: string[];
  css: string;
  validationIssues: ReturnType<typeof validateTheme>['issues'];
  projectPath?: string;
};

export type ThemedPreviewRequest = PreviewRequest & {
  theme: PreviewThemeInput;
  mode?: ThemeMode;
};

export type ThemedPreviewSession = {
  schemaVersion: '1';
  status: 'running';
  theme: PreviewThemeResolution;
  session: PreviewSession;
};

export type ThemedPreviewStartResult = ThemedPreviewSession | PreviewRefusalResult;

export function resolvePreviewTheme(theme: PreviewThemeInput, mode: ThemeMode = 'light'): PreviewThemeResolution {
  const validation = validateTheme(theme, { requireReview: false });
  const manifest = validation.manifest ?? {
    schemaVersion: '1' as const,
    id: typeof theme.id === 'string' ? theme.id : 'invalid-theme',
    name: typeof theme.name === 'string' ? theme.name : 'Invalid theme',
    modes: { [mode]: {} },
  } as ThemeManifest;
  const emitted = validation.valid ? emitPreviewCss(manifest, { mode }) : { css: '', mappings: [] };
  const missingRoles = REQUIRED_THEME_ROLES.filter((role) => !emitted.mappings.some((mapping) => mapping.role === role));
  const projectDerived = 'projectProfile' in theme;
  return {
    schemaVersion: '1',
    themeId: manifest.id,
    themeName: manifest.name,
    mode,
    provenance: projectDerived ? 'project-derived' : 'saved',
    evidenceOnly: projectDerived,
    reviewed: theme.reviewed === true,
    renderable: validation.valid && missingRoles.length === 0,
    mappings: emitted.mappings,
    missingRoles,
    css: emitted.css,
    validationIssues: validation.issues,
    ...(projectDerived ? { projectPath: theme.derivedFrom.projectPath } : {}),
  };
}

export async function startThemedPreviewSession(request: ThemedPreviewRequest, options: PreviewRunnerOptions = {}): Promise<ThemedPreviewStartResult> {
  const { theme, mode = 'light', ...previewRequest } = request;
  const resolution = resolvePreviewTheme(theme, mode);
  if (!resolution.renderable) {
    return {
      schemaVersion: '1',
      status: 'refused',
      refusal: {
        code: 'invalid-request',
        message: `Theme '${resolution.themeId}' is not renderable for ${mode} preview.`,
        details: { theme: resolution, csp: PREVIEW_CSP },
      },
    };
  }
  const session = await startPreviewSession(previewRequest, options);
  if (session.status === 'refused') return session;
  return { schemaVersion: '1', status: 'running', theme: resolution, session };
}
