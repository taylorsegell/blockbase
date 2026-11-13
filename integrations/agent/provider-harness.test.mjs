import assert from 'node:assert/strict';
import test from 'node:test';
import { runHarness } from './harness/run.mjs';

test('all providers execute equivalent workflow contracts across the fixture matrix', async () => {
  const report = await runHarness();
  assert.deepEqual(report.providers, ['cursor', 'claude-code', 'codex']);
  assert.equal(report.parity.passed, true);
  assert.deepEqual(report.unverifiedBoundaries, [
    'Live Cursor, Claude Code, and Codex model playback was not configured. The fixture replay does not claim live-agent verification.',
  ]);
  for (const result of report.results) {
    assert.equal(result.installation.install.operation, 'agent.install');
    assert.equal(result.installation.install.ok, true);
    assert.equal(result.installation.check.operation, 'agent.check');
    assert.equal(result.installation.check.ok, true);
    assert.deepEqual(result.discovered.map((skill) => skill.name), ['blockbase-capture', 'blockbase-inbox', 'blockbase-find-and-fit', 'blockbase-organize', 'blockbase-audit']);
    assert.ok(result.transcript.length >= 2);
  }
  const byScenario = new Map(report.results.filter((result) => result.provider === 'cursor').map((result) => [result.scenario, result]));
  assert.deepEqual(byScenario.get('success').exchangeCounts, { selection: 1, boundedCorrection: 0 });
  assert.deepEqual(byScenario.get('ambiguity').exchangeCounts, { selection: 1, boundedCorrection: 0 });
  assert.deepEqual(byScenario.get('search-miss').exchangeCounts, { selection: 0, boundedCorrection: 0 });
  assert.deepEqual(byScenario.get('partial-normalization').exchangeCounts, { selection: 1, boundedCorrection: 1 });
  assert.deepEqual(byScenario.get('unsupported-framework').exchangeCounts, { selection: 0, boundedCorrection: 0 });
  assert.deepEqual(byScenario.get('bounded-validation-failure').exchangeCounts, { selection: 1, boundedCorrection: 1 });
  const record = (scenario, step) => byScenario.get(scenario).transcript.find((item) => item.step === step);
  assert.equal(record('success', 'validate').contract.validationStatus, 'passed');
  assert.equal(record('ambiguity', 'search').contract.selection, 'needs-selection');
  assert.equal(record('search-miss', 'search').contract.selection, 'miss');
  assert.ok(record('partial-normalization', 'adapt').contract.residualCount > 0);
  assert.equal(record('unsupported-framework', 'project-inspect').contract.errorCode, 'PROJECT_UNSUPPORTED_FRAMEWORK');
  assert.equal(record('bounded-validation-failure', 'validate').contract.validationStatus, 'failed');
  assert.deepEqual(report.exchangeCounts['success'], {
    cursor: { selection: 1, boundedCorrection: 0 },
    'claude-code': { selection: 1, boundedCorrection: 0 },
    codex: { selection: 1, boundedCorrection: 0 },
  });
});
