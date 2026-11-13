import { stableStringify } from '@blockbase/contracts';
import { sha256 } from '../import/local.js';

export type VisualValidationSettings = {
  viewport: { width: number; height: number };
  fonts: string[];
  reducedMotion: true;
  animationDurationMs: 0;
  tolerance: number;
  maxDiffPixels: number;
};

export const DEFAULT_VISUAL_VALIDATION_SETTINGS: VisualValidationSettings = Object.freeze({
  viewport: Object.freeze({ width: 1280, height: 800 }),
  fonts: Object.freeze(['system-ui', 'sans-serif']) as unknown as string[],
  reducedMotion: true,
  animationDurationMs: 0,
  tolerance: 0,
  maxDiffPixels: 0,
});

export type VisualFixture = {
  id: string;
  original: string | readonly number[];
  normalized: string | readonly number[];
  renderable?: boolean;
  nonRenderableReason?: string;
};

export type VisualValidationStatus = 'passed' | 'drift' | 'non-renderable';

export type VisualValidationReport = {
  schemaVersion: '1';
  harness: 'blockbase-visual-validation';
  fixtureId: string;
  status: VisualValidationStatus;
  settings: VisualValidationSettings;
  originalHash: string;
  normalizedHash: string;
  diffPixels: number | null;
  maxChannelDelta: number | null;
  reason?: string;
};

function hash(value: string | readonly number[]): string {
  return sha256(typeof value === 'string' ? value : stableStringify([...value]));
}

function pixelDiff(original: readonly number[], normalized: readonly number[], tolerance: number): { diffPixels: number; maxChannelDelta: number } | undefined {
  if (original.length !== normalized.length) return undefined;
  let differingChannels = 0;
  let maxChannelDelta = 0;
  for (let index = 0; index < original.length; index += 1) {
    const delta = Math.abs(original[index] - normalized[index]);
    maxChannelDelta = Math.max(maxChannelDelta, delta);
    if (delta > tolerance) differingChannels += 1;
  }
  return { diffPixels: Math.ceil(differingChannels / 4), maxChannelDelta };
}

export function compareVisualFixture(fixture: VisualFixture, settings: VisualValidationSettings = DEFAULT_VISUAL_VALIDATION_SETTINGS): VisualValidationReport {
  const originalHash = hash(fixture.original);
  const normalizedHash = hash(fixture.normalized);
  if (fixture.renderable === false) {
    return { schemaVersion: '1', harness: 'blockbase-visual-validation', fixtureId: fixture.id, status: 'non-renderable', settings, originalHash, normalizedHash, diffPixels: null, maxChannelDelta: null, reason: fixture.nonRenderableReason ?? 'Fixture did not produce a renderable preview.' };
  }
  const diff = Array.isArray(fixture.original) && Array.isArray(fixture.normalized)
    ? pixelDiff(fixture.original, fixture.normalized, settings.tolerance)
    : undefined;
  const diffPixels = diff?.diffPixels ?? (originalHash === normalizedHash ? 0 : Number.POSITIVE_INFINITY);
  const status = diffPixels <= settings.maxDiffPixels ? 'passed' : 'drift';
  return { schemaVersion: '1', harness: 'blockbase-visual-validation', fixtureId: fixture.id, status, settings, originalHash, normalizedHash, diffPixels: Number.isFinite(diffPixels) ? diffPixels : null, maxChannelDelta: diff?.maxChannelDelta ?? (originalHash === normalizedHash ? 0 : null), ...(status === 'drift' ? { reason: 'Normalized output exceeds the pinned visual tolerance.' } : {}) };
}

export function serializeVisualValidationReport(report: VisualValidationReport): string {
  return `${stableStringify(report)}\n`;
}

export function visualValidationReportHash(report: VisualValidationReport): string {
  return sha256(serializeVisualValidationReport(report));
}
