import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  DEFAULT_VISUAL_VALIDATION_SETTINGS,
  compareVisualFixture,
  resolvePreviewTheme,
  sha256,
  startThemedPreviewSession,
  starterTheme,
  serializeVisualValidationReport,
  visualValidationReportHash,
} from '../dist/index.js';

function source() {
  const content = 'export default function Card() { return null; }';
  return { schemaVersion: '1', sourceType: 'stdin', files: [{ path: 'Card.tsx', content, contentHash: sha256(content) }], assets: [], entryPoint: 'Card.tsx', provenance: { sourceType: 'stdin', locator: '<fixture>' } };
}

function projectDraft() {
  return { ...starterTheme('project-draft', 'Project draft'), reviewRequired: true, reviewed: false, derivedFrom: { projectPath: '/tmp/project', evidence: [{ path: 'src/index.css', source: 'config', fact: 'Canonical roles mapped from project tokens.', confidence: 'high' }], profileHash: 'sha256:profile' }, projectProfile: {} };
}

test('saved and project-derived themes resolve canonical roles with explicit provenance', () => {
  const saved = resolvePreviewTheme(starterTheme('saved'), 'dark');
  assert.equal(saved.renderable, true);
  assert.equal(saved.provenance, 'saved');
  assert.equal(saved.evidenceOnly, false);
  assert.match(saved.css, /--color-text-primary/);
  const draft = resolvePreviewTheme(projectDraft());
  assert.equal(draft.renderable, true);
  assert.equal(draft.provenance, 'project-derived');
  assert.equal(draft.evidenceOnly, true);
  assert.equal(draft.reviewed, false);
  assert.equal(draft.projectPath, '/tmp/project');
});

test('themed preview keeps destination roots untouched and closes cleanly', async () => {
  const destination = await mkdtemp(join(tmpdir(), 'blockbase-preview-destination-'));
  const before = await readdir(destination);
  const result = await startThemedPreviewSession({ source: source(), theme: starterTheme('saved'), renderedHtml: '<!doctype html><html><body>fixture</body></html>' });
  assert.equal(result.status, 'running');
  assert.equal(result.theme.evidenceOnly, false);
  assert.deepEqual(await readdir(destination), before);
  assert.equal((await result.session.close()).status, 'stopped');
  assert.deepEqual(await readdir(destination), before);
});

test('visual reports pin playback settings and distinguish pass, drift, and non-renderable', () => {
  assert.deepEqual(DEFAULT_VISUAL_VALIDATION_SETTINGS, { viewport: { width: 1280, height: 800 }, fonts: ['system-ui', 'sans-serif'], reducedMotion: true, animationDurationMs: 0, tolerance: 0, maxDiffPixels: 0 });
  const pass = compareVisualFixture({ id: 'card', original: [0, 0, 0, 255], normalized: [0, 0, 0, 255] });
  const drift = compareVisualFixture({ id: 'card-drift', original: [0, 0, 0, 255], normalized: [0, 0, 1, 255] });
  const missing = compareVisualFixture({ id: 'unsupported', original: '', normalized: '', renderable: false, nonRenderableReason: 'Unsupported framework.' });
  assert.equal(pass.status, 'passed');
  assert.equal(drift.status, 'drift');
  assert.equal(missing.status, 'non-renderable');
  assert.equal(serializeVisualValidationReport(pass), serializeVisualValidationReport(pass));
  assert.equal(visualValidationReportHash(pass), visualValidationReportHash(pass));
});
