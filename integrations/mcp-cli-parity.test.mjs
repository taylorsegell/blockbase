import assert from 'node:assert/strict';
import test from 'node:test';
import { runParityMatrix } from './mcp-cli-parity.mjs';

test('MCP and CLI return equivalent normalized contracts across the handoff matrix', async () => {
  const report = await runParityMatrix();
  assert.equal(report.schemaVersion, '1');
  assert.deepEqual(report.cases.map((item) => item.id), ['success', 'miss', 'ambiguity', 'unsupported', 'stale-revision', 'missing-dependency', 'validation-failure']);
  assert.equal(report.processLifecycle.backgroundProcesses, 0);
  assert.ok(report.cases.every((item) => item.records.length > 0));
  const validationFailure = report.cases.find((item) => item.id === 'validation-failure');
  assert.equal(validationFailure.records.find((item) => item.operation === 'validate-failure').cli.contract.data.status, 'failed');
  const stale = report.cases.find((item) => item.id === 'stale-revision');
  assert.equal(stale.records[0].cli.contract.error.code, 'COMPONENT_NOT_FOUND');
});
