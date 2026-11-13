import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  LEGACY_PRESET_MIGRATION,
  REQUIRED_THEME_ROLES,
  ThemeRegistry,
  ThemeValidationError,
  canonicalRoleMappings,
  deriveThemeFromProject,
  emitPreviewCss,
  starterTheme,
  validateTheme,
} from '../dist/index.js';

function profile() {
  return {
    schemaVersion: '1', projectPath: '/tmp/project', framework: { name: 'vite' }, language: { name: 'typescript', moduleFormat: 'esm' },
    styling: { systems: ['css'], tokenFiles: ['src/index.css'] },
    tokens: { values: { '--surface': '#fff', '--foreground': '#111', '--primary': '#f60' }, aliases: {} },
    dependencies: { runtime: {}, development: {} }, conventions: { componentDirectory: 'src/components', filenameCase: 'pascal' }, validationCommands: [], evidence: [{ path: 'src/index.css', source: 'config', fact: 'Token --surface = #fff.', confidence: 'high' }], conflicts: [],
  };
}

test('theme validation reports invalid values, unsupported modes, missing roles, and alias cycles', () => {
  const theme = starterTheme('demo', 'Demo');
  delete theme.modes.light['color.border.default'];
  theme.modes.light['color.surface.default'] = '$color.surface.elevated';
  theme.modes.light['color.surface.elevated'] = '$color.surface.default';
  theme.modes.ocean = {};
  theme.modes.dark['color.text.primary'] = 'not-a-color';
  const result = validateTheme(theme);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((item) => item.code === 'missing-role' && item.path.endsWith('.color.border.default')));
  assert.ok(result.issues.some((item) => item.code === 'alias-cycle'));
  assert.ok(result.issues.some((item) => item.code === 'invalid-mode'));
  assert.ok(result.issues.some((item) => item.code === 'invalid-value'));
});

test('registration writes immutable revision and reproducible scoped CSS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockbase-themes-'));
  const registry = new ThemeRegistry({ catalogRoot: root });
  const first = await registry.register(starterTheme('demo', 'Demo'));
  const cssA = await readFile(first.previewPath, 'utf8');
  const second = emitPreviewCss(starterTheme('demo', 'Demo')).css;
  assert.equal(cssA.endsWith(second), true);
  assert.match(cssA, /\.blockbase-preview\[data-theme="demo"\]\[data-mode="light"\]/);
  assert.equal((await registry.read('demo')).currentRevision, first.revisionId);
  await assert.rejects(() => registry.register(starterTheme('demo', 'Demo')), (error) => error.code === 'THEME_DUPLICATE_ID');
  await stat(join(root, 'themes', 'demo', 'revisions', first.revisionId.slice(7), 'theme.json'));
});

test('derived themes retain project evidence and require review', () => {
  const draft = deriveThemeFromProject(profile(), { id: 'project-draft' });
  assert.equal(draft.reviewRequired, true);
  assert.equal(draft.reviewed, false);
  assert.equal(draft.derivedFrom.evidence[0].path, 'src/index.css');
  assert.ok(validateTheme(draft).issues.some((item) => item.code === 'unreviewed-draft'));
  assert.equal(canonicalRoleMappings(REQUIRED_THEME_ROLES, profile()).find((item) => item.sourceToken === 'color.surface.default').destinationExpression, 'var(--surface)');
});

test('legacy presets are explicitly accounted for as deferred inputs', () => {
  assert.equal(LEGACY_PRESET_MIGRATION.status, 'intentionally-deferred');
  assert.equal(LEGACY_PRESET_MIGRATION.authoritativeInput, 'preview/src/lib/themes-config.ts');
});
