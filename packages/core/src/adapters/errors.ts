export type AdapterErrorCode = 'ADAPTER_INVALID_MANIFEST' | 'ADAPTER_INCOMPATIBLE_VERSION' | 'ADAPTER_NETWORK_DENIED' | 'ADAPTER_PATH_ESCAPE' | 'ADAPTER_TIMEOUT' | 'ADAPTER_EXIT_FAILED' | 'ADAPTER_MALFORMED_OUTPUT';

export class AdapterError extends Error {
  constructor(readonly code: AdapterErrorCode, message: string, readonly details: Record<string, unknown> = {}) { super(message); }
}
