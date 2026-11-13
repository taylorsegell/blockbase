import {
  CONTRACT_VERSION,
  type AdaptationBundle,
  type SourceEnvelope,
  parseSourceEnvelope,
} from '@blockbase/contracts';

export const consumerContractVersion: '1' = CONTRACT_VERSION;

export function consumeContracts(input: unknown): Pick<SourceEnvelope, 'schemaVersion'> {
  const source = parseSourceEnvelope(input);
  return { schemaVersion: source.schemaVersion };
}

export function acceptBundle(bundle: AdaptationBundle): string {
  return bundle.bundleId;
}
