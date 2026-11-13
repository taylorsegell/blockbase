import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ContractValidationError,
  parseAdaptationBundle,
  parseCliErrorEnvelope,
  parseCliSuccessEnvelope,
  parseComponentManifest,
  parseNormalizationReport,
  parseProjectProfile,
  parseRemoteComponentPackage,
  parseSourceEnvelope,
  parseTokenContract,
  parseValidationResult,
  stableStringify,
} from '../dist/index.js';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = resolve(testDirectory, '../fixtures/v1');

async function fixture(name) {
  return JSON.parse(await readFile(resolve(fixtureDirectory, name), 'utf8'));
}

const schemas = [
  ['source-envelope.json', parseSourceEnvelope],
  ['component-manifest.json', parseComponentManifest],
  ['token-contract.json', parseTokenContract],
  ['normalization-report.json', parseNormalizationReport],
  ['project-profile.json', parseProjectProfile],
  ['adaptation-bundle.json', parseAdaptationBundle],
  ['validation-result.json', parseValidationResult],
  ['cli-success-envelope.json', parseCliSuccessEnvelope],
  ['cli-error-envelope.json', parseCliErrorEnvelope],
  ['remote-component-package.json', parseRemoteComponentPackage],
];

for (const [name, parse] of schemas) {
  await assert.doesNotReject(async () => {
    const value = await fixture(name);
    const parsed = parse(value);
    assert.equal(stableStringify(parsed), stableStringify(value));
  }, `${name} should accept its canonical fixture and round-trip deterministically`);
}

for (const [name, parse] of schemas) {
  await assert.rejects(
    async () => {
      const value = await fixture(name);
      value.schemaVersion = '2';
      parse(value);
    },
    ContractValidationError,
    `${name} should reject an incompatible schema version`,
  );
}

const malformedCases = [
  ['source-envelope.json', parseSourceEnvelope, (value) => delete value.files],
  ['component-manifest.json', parseComponentManifest, (value) => delete value.componentId],
  ['token-contract.json', parseTokenContract, (value) => delete value.contractId],
  ['normalization-report.json', parseNormalizationReport, (value) => delete value.sourceHash],
  ['project-profile.json', parseProjectProfile, (value) => delete value.projectPath],
  ['adaptation-bundle.json', parseAdaptationBundle, (value) => delete value.bundleId],
  ['validation-result.json', parseValidationResult, (value) => delete value.bundleId],
  ['cli-success-envelope.json', parseCliSuccessEnvelope, (value) => delete value.data],
  ['cli-error-envelope.json', parseCliErrorEnvelope, (value) => delete value.error],
  ['remote-component-package.json', parseRemoteComponentPackage, (value) => delete value.revisionId],
];

for (const [name, parse, mutate] of malformedCases) {
  await assert.rejects(
    async () => {
      const value = await fixture(name);
      mutate(value);
      parse(value);
    },
    `${name} should reject a malformed required field`,
  );
}

{
  const value = await fixture('component-manifest.json');
  delete value.provenance.author;
  assert.equal(parseComponentManifest(value).provenance.author, undefined, 'a manifest without provenance.author stays valid');
  const withAuthor = await fixture('component-manifest.json');
  withAuthor.provenance.author = 'Ada Example';
  assert.equal(parseComponentManifest(withAuthor).provenance.author, 'Ada Example', 'provenance.author is accepted when it is a string');
  const badAuthor = await fixture('component-manifest.json');
  badAuthor.provenance.author = 42;
  assert.throws(() => parseComponentManifest(badAuthor), ContractValidationError, 'provenance.author must be a string when present');
}
