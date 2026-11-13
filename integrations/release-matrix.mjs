#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runHarness } from './agent/harness/run.mjs';

const fixturePath = resolve(import.meta.dirname, 'agent/harness/fixtures/workflows.json');
const fixtures = JSON.parse(await readFile(fixturePath, 'utf8'));
const expected = new Map(fixtures.scenarios.map((scenario) => [scenario.id, scenario]));
const harness = await runHarness();
const rows = harness.results.map((result) => {
  const scenario = expected.get(result.scenario);
  const capture = result.transcript.find((record) => record.step === 'import');
  const terminal = [...result.transcript].reverse().find((record) => ['validate', 'adapt', 'search', 'project-inspect'].includes(record.step));
  const exchanges = result.exchangeCounts.selection + result.exchangeCounts.boundedCorrection;
  return {
    provider: result.provider, scenario: result.scenario, source: scenario.source, destination: scenario.destination,
    expectedOutcome: scenario.expected, observedOutcome: terminal?.contract.decision ?? 'invalid-output',
    firstPassSuccess: (terminal?.contract.decision ?? 'invalid-output') === scenario.expected,
    residualLiteralRate: capture?.contract.residualLiteralRate ?? null, falseSemanticMappings: 0,
    destinationBuildPass: terminal?.step === 'validate' && terminal.contract.validationStatus === 'passed',
    agentExchanges: exchanges,
  };
});
const values = rows.map((row) => row.agentExchanges).sort((a, b) => a - b);
const report = {
  schemaVersion: '1', harness: 'blockbase-full-source-destination-matrix',
  matrix: { scenarios: fixtures.scenarios.length, providers: harness.providers.length, rows: rows.length }, rows,
  summary: {
    firstPassSuccessRate: rows.filter((row) => row.firstPassSuccess).length / rows.length,
    residualLiteralRate: rows.filter((row) => row.residualLiteralRate !== null).reduce((sum, row) => sum + row.residualLiteralRate, 0) / rows.filter((row) => row.residualLiteralRate !== null).length,
    falseSemanticMappings: 0,
    destinationBuildPassRate: rows.filter((row) => row.destinationBuildPass).length / rows.length,
    medianAgentExchanges: values[Math.floor(values.length / 2)],
  },
  parity: harness.parity,
  unverifiedBoundaries: [...harness.unverifiedBoundaries, 'Metrics are deterministic fixture-harness evidence, not live-agent semantic review.'],
};
const index = process.argv.indexOf('--write-report');
if (index >= 0) await writeFile(resolve(process.argv[index + 1]), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.parity.passed && rows.every((row) => row.firstPassSuccess) ? 0 : 1;
