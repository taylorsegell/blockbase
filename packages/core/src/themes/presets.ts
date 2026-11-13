/**
 * Migration accounting for the legacy preview presets. The legacy CSS files
 * are intentionally deferred until their authoritative token inputs are
 * declared; they are not silently treated as canonical theme manifests.
 */
export const LEGACY_PRESET_MIGRATION = {
  status: 'intentionally-deferred' as const,
  authoritativeInput: 'preview/src/lib/themes-config.ts',
  generatedSources: ['preview/src/styles/themes/*.css'],
  reason: 'Legacy presets are generated from preview-only CSS and do not yet declare the canonical token contract.',
  action: 'Register each preset from a reviewed theme.json before publishing it through the canonical registry.',
};

export type LegacyPresetMigrationReport = typeof LEGACY_PRESET_MIGRATION;
