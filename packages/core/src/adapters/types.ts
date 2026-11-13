import type { SourceEnvelope } from '@blockbase/contracts';

export type AdapterManifest = {
  schemaVersion: '1';
  id: string;
  name: string;
  version: string;
  capabilities: { network: 'none' | 'fetch' };
};

export type AdapterRequest = {
  schemaVersion: '1';
  operation: 'acquire';
  locator: string;
  allowRoot?: string;
  fetch?: boolean;
};

export type AdapterExecutionOptions = { manifestPath: string; command: string; args?: string[]; request: AdapterRequest; timeoutMs?: number };
export type AdapterExecutionResult = { schemaVersion: '1'; adapter: Pick<AdapterManifest, 'id' | 'version'>; envelope: SourceEnvelope; network: 'none' | 'fetch' };
