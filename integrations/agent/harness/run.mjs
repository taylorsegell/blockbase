#!/usr/bin/env node

import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const harnessRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(harnessRoot, '../..');
const cli = join(repositoryRoot, 'packages/cli/dist/index.js');
const fixtureSpec = JSON.parse(await readFile(join(harnessRoot, 'harness/fixtures/workflows.json'), 'utf8'));
const providers = ['cursor', 'claude-code', 'codex'];
const focusedSkills = ['blockbase-capture', 'blockbase-inbox', 'blockbase-find-and-fit', 'blockbase-organize', 'blockbase-audit'];
const legacyCatalog = join(repositoryRoot, 'tests/fixtures/legacy-catalog/valid');
const defaultScenarioIds = fixtureSpec.scenarios.map((scenario) => scenario.id);

function invoke(executable, args, cwd) {
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd,
    env: { ...process.env, BLOCKBASE_HOME: join(cwd, '.blockbase-home') },
    encoding: 'utf8',
  });
  let json = null;
  if (result.stdout.trim()) {
    try { json = JSON.parse(result.stdout); } catch { /* preserve malformed output in the transcript */ }
  }
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, json };
}

function operationFromArgs(args) {
  if (args[0] === 'project' && args[1] === 'inspect') return 'project.inspect';
  if (args[0] === 'catalog' && args[1]) return `catalog.${args[1]}`;
  return args[0];
}

function decisionFor(result) {
  const envelope = result.json;
  if (!envelope) return 'invalid-output';
  if (!envelope.ok) {
    const code = envelope.error?.code ?? '';
    if (code === 'COMPONENT_SELECTION_REQUIRED') return 'ambiguous';
    if (code === 'COMPONENT_NOT_FOUND') return 'miss';
    if (code.includes('UNSUPPORTED')) return 'unsupported';
    return code === 'PROJECT_CONFLICT' ? 'ambiguous' : 'failure';
  }
  const data = envelope.data ?? {};
  if (data.selection?.status === 'needs-selection') return 'ambiguous';
  if (data.selection?.status === 'miss') return 'miss';
  if (Array.isArray(data.residuals) && data.residuals.length > 0) return 'partial';
  if (data.risk === 'high') return 'partial';
  if (data.status === 'failed') return 'validation-failed';
  if (data.status === 'blocked') return 'bounded-validation-failure';
  return 'success';
}

function scrub(value, roots) {
  if (typeof value === 'string') {
    let output = value.split(sep).join('/');
    for (const [root, replacement] of roots) output = output.split(root.split(sep).join('/')).join(replacement);
    return output;
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item, roots));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item, roots)]));
  return value;
}

function contractProjection(result) {
  const envelope = result.json;
  if (!envelope) return { ok: false, output: result.stdout.slice(0, 240) };
  const data = envelope.data ?? {};
  return {
    ok: envelope.ok,
    operation: envelope.operation,
    errorCode: envelope.error?.code ?? null,
    warningCodes: (envelope.warnings ?? []).map((warning) => warning.code).sort(),
    decision: decisionFor(result),
    selection: data.selection?.status ?? null,
    risk: data.risk ?? null,
    residualCount: Array.isArray(data.residuals) ? data.residuals.length : null,
    validationStatus: data.status ?? null,
    files: Array.isArray(data.files) ? data.files.length : null,
    recoveryActionIds: (envelope.recoveryActions ?? []).map((action) => action.id).sort(),
  };
}

function transcriptRecord({ provider, scenario, phase, step, args, result, roots }) {
  const envelope = result.json;
  return {
    provider,
    scenario,
    phase,
    step,
    operation: envelope?.operation ?? operationFromArgs(args),
    argv: scrub(args, roots),
    exitCode: result.status,
    stderrCodes: [...result.stderr.matchAll(/(?:Error|Warning) \[([^\]]+)\]/g)].map((match) => match[1]),
    contract: scrub(contractProjection(result), roots),
  };
}

function runWorkflowCommand({ provider, scenario, phase, step, executable, args, cwd, roots, transcript }) {
  const result = invoke(executable, [...args, '--json'], cwd);
  transcript.push(transcriptRecord({ provider, scenario: scenario.id, phase, step, args: [...args, '--json'], result, roots }));
  return result;
}

async function prepareCatalog(scenario, catalog) {
  await cp(legacyCatalog, catalog, { recursive: true });
  const source = resolve(repositoryRoot, scenario.source);
  const primaryArgs = ['import', source, '--catalog', catalog];
  const seeded = invoke(cli, primaryArgs, repositoryRoot);
  assert.equal(seeded.status, 0, `${scenario.id} seed import failed: ${seeded.stderr}`);
  for (const seed of scenario.seedImports ?? []) {
    const result = invoke(cli, ['import', source, '--catalog', catalog, '--namespace', 'contract', '--slug', seed.slug, '--name', seed.name], repositoryRoot);
    assert.equal(result.status, 0, `${scenario.id} seed import ${seed.slug} failed: ${result.stderr}`);
  }
  const rebuilt = invoke(cli, ['catalog', 'rebuild', '--catalog', catalog, '--json'], repositoryRoot);
  assert.equal(rebuilt.status, 0, `${scenario.id} seed rebuild failed: ${rebuilt.stderr}`);
}

async function prepareDestination(scenario, destinationRoot) {
  await cp(resolve(repositoryRoot, scenario.destination), destinationRoot, { recursive: true });
  if (scenario.validationCommands) {
    await mkdir(join(destinationRoot, '.blockbase'), { recursive: true });
    await writeFile(join(destinationRoot, '.blockbase/project.json'), `${JSON.stringify({ validationCommands: scenario.validationCommands }, null, 2)}\n`);
  }
}

async function discover(provider, home) {
  const discovered = [];
  for (const skill of focusedSkills) {
    const path = join(home, 'skills', skill, 'SKILL.md');
    const content = await readFile(path, 'utf8');
    const name = content.match(/^name:\s*([^\n]+)$/m)?.[1]?.trim();
    assert.equal(name, skill, `${provider} did not expose ${skill}`);
    discovered.push({ name: skill, path: `skills/${skill}/SKILL.md` });
  }
  return discovered;
}

async function runProvider(provider, scenario) {
  const root = await mkdtemp(join(tmpdir(), `blockbase-${provider}-${scenario.id}-`));
  // Avoid the reserved basename `catalog`: the CLI treats that exact path as
  // a catalog file, while this harness passes a catalog directory root.
  const catalog = join(root, 'catalog-data');
  const destination = join(root, 'destination');
  const staging = join(root, 'staging');
  const home = join(root, 'agent-home');
  const transcript = [];
  const roots = [[root, '$HARNESS'], [resolve(repositoryRoot), '$REPO']];
  try {
    await prepareCatalog(scenario, catalog);
    await prepareDestination(scenario, destination);
    const install = invoke(cli, ['agent', 'install', '--provider', provider, '--scope', 'global', '--home', home, '--json'], repositoryRoot);
    assert.equal(install.status, 0, `${provider} install failed: ${install.stderr}`);
    const discovered = await discover(provider, home);
    const executable = join(home, 'bin', 'blockbase');
    const check = invoke(executable, ['agent', 'check', '--provider', provider, '--scope', 'global', '--home', home, '--json'], repositoryRoot);
    assert.equal(check.status, 0, `${provider} check failed: ${check.stderr}`);

    const capture = runWorkflowCommand({ provider, scenario, phase: 'capture', step: 'import', executable, cwd: repositoryRoot, roots, transcript, args: ['import', resolve(repositoryRoot, scenario.source), '--catalog', catalog] });
    if (capture.status === 0) runWorkflowCommand({ provider, scenario, phase: 'capture', step: 'catalog-validate', executable, cwd: repositoryRoot, roots, transcript, args: ['catalog', 'validate', '--catalog', catalog] });
    const installation = {
      install: scrub(contractProjection(install), roots),
      check: scrub(contractProjection(check), roots),
      executable: '$HARNESS/agent-home/bin/blockbase',
    };
    if (capture.status !== 0) return { provider, scenario: scenario.id, installation, discovered, transcript, exchangeCounts: exchangeCounts(transcript), liveVerification: liveBoundary(provider) };

    const inspected = runWorkflowCommand({ provider, scenario, phase: 'find-and-fit', step: 'project-inspect', executable, cwd: repositoryRoot, roots, transcript, args: ['project', 'inspect', '--cwd', destination] });
    if (inspected.status !== 0) return { provider, scenario: scenario.id, installation, discovered, transcript, exchangeCounts: exchangeCounts(transcript), liveVerification: liveBoundary(provider) };
    const searched = runWorkflowCommand({ provider, scenario, phase: 'find-and-fit', step: 'search', executable, cwd: repositoryRoot, roots, transcript, args: ['search', scenario.query, '--catalog', catalog, '--project', destination] });
    if (searched.status !== 0 || searched.json?.data?.selection?.status !== 'selected') return { provider, scenario: scenario.id, installation, discovered, transcript, exchangeCounts: exchangeCounts(transcript), liveVerification: liveBoundary(provider) };
    const componentId = searched.json.data.selection.selectedComponentId;
    const adapted = runWorkflowCommand({ provider, scenario, phase: 'find-and-fit', step: 'adapt', executable, cwd: repositoryRoot, roots, transcript, args: ['adapt', componentId, '--catalog', catalog, '--project', destination, '--out', staging] });
    if (adapted.status !== 0) return { provider, scenario: scenario.id, installation, discovered, transcript, exchangeCounts: exchangeCounts(transcript), liveVerification: liveBoundary(provider) };
    const added = runWorkflowCommand({ provider, scenario, phase: 'find-and-fit', step: 'add', executable, cwd: repositoryRoot, roots, transcript, args: ['add', componentId, '--catalog', catalog, '--project', destination, '--manifest', join(staging, 'bundle.json'), '--apply'] });
    if (added.status === 0) {
      // Re-pin the bundle after apply so validation observes the destination as
      // it exists now; validating the pre-apply bundle would correctly report
      // its create targets as changed.
      const reprepared = runWorkflowCommand({ provider, scenario, phase: 'find-and-fit', step: 'reprepare-for-validation', executable, cwd: repositoryRoot, roots, transcript, args: ['adapt', componentId, '--catalog', catalog, '--project', destination, '--out', staging] });
      if (reprepared.status === 0) runWorkflowCommand({ provider, scenario, phase: 'find-and-fit', step: 'validate', executable, cwd: repositoryRoot, roots, transcript, args: ['validate', join(staging, 'bundle.json'), '--project', destination] });
    }
    return { provider, scenario: scenario.id, installation, discovered, transcript, exchangeCounts: exchangeCounts(transcript), liveVerification: liveBoundary(provider) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function exchangeCounts(transcript) {
  const workflow = transcript.filter((record) => record.phase === 'find-and-fit');
  const selection = workflow.filter((record) => record.step === 'search' && ['selected', 'needs-selection'].includes(record.contract.selection)).length;
  const correction = workflow.some((record) => record.contract.decision === 'partial' || record.contract.validationStatus === 'failed' || record.contract.validationStatus === 'blocked') ? 1 : 0;
  return { selection, boundedCorrection: correction };
}

function liveBoundary(provider) {
  return { provider, status: 'unverified', reason: 'No live agent harness was configured; this report covers the installed CLI provider fixture only.' };
}

function scenarioDecision(result) {
  const workflow = result.transcript.filter((record) => record.phase === 'find-and-fit');
  for (const record of [...workflow].reverse()) {
    if (record.step === 'validate' || record.step === 'adapt' || record.step === 'search' || record.step === 'project-inspect') return record.contract.decision;
  }
  return result.transcript.find((record) => record.phase === 'capture')?.contract.decision;
}

function parityDiff(results) {
  const baseline = results[0];
  const baselineRecords = baseline.transcript.map(({ provider, ...record }) => record);
  return results.slice(1).flatMap((result) => {
    const records = result.transcript.map(({ provider, ...record }) => record);
    return JSON.stringify(records) === JSON.stringify(baselineRecords) ? [] : [{ providers: [baseline.provider, result.provider], reason: 'normalized workflow transcript differs' }];
  });
}

export async function runHarness({ selectedProviders = providers, selectedScenarios = fixtureSpec.scenarios } = {}) {
  const results = [];
  for (const scenario of selectedScenarios) {
    const scenarioResults = [];
    for (const provider of selectedProviders) scenarioResults.push(await runProvider(provider, scenario));
    const actual = scenarioDecision(scenarioResults[0]);
    assert.equal(actual, scenario.expected, `${scenario.id} expected ${scenario.expected}, got ${actual}`);
    results.push(...scenarioResults);
  }
  const parity = selectedScenarios.flatMap((scenario) => parityDiff(results.filter((result) => result.scenario === scenario.id)));
  const exchangeCounts = Object.fromEntries(selectedScenarios.map((scenario) => [scenario.id, Object.fromEntries(results.filter((result) => result.scenario === scenario.id).map((result) => [result.provider, result.exchangeCounts]))]));
  return {
    schemaVersion: '1',
    harness: 'installed-cli-fixture-replay',
    scenarios: selectedScenarios.map((scenario) => scenario.id),
    providers: selectedProviders,
    results,
    parity: { passed: parity.length === 0, differences: parity },
    exchangeCounts,
    liveAgentVerification: selectedProviders.map(liveBoundary),
    unverifiedBoundaries: ['Live Cursor, Claude Code, and Codex model playback was not configured. The fixture replay does not claim live-agent verification.'],
  };
}

function parseOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const provider = parseOption('--provider');
  const scenarioId = parseOption('--scenario');
  const selectedProviders = provider ? [provider] : providers;
  const selectedScenarios = scenarioId ? fixtureSpec.scenarios.filter((scenario) => scenario.id === scenarioId) : fixtureSpec.scenarios;
  if (selectedProviders.some((item) => !providers.includes(item)) || selectedScenarios.length !== (scenarioId ? 1 : defaultScenarioIds.length)) {
    process.stderr.write('Unknown provider or scenario.\n');
    process.exitCode = 2;
  } else {
    const report = await runHarness({ selectedProviders, selectedScenarios });
    const outputPath = parseOption('--write-report');
    if (outputPath) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.parity.passed ? 0 : 1;
  }
}
