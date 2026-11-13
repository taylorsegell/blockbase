/**
 * Stable error taxonomy for the remote catalog client. Every failure the client can raise is
 * normalized into one of these categories so callers (eventually the CLI, in a later task) can
 * branch on `code` without inspecting transport internals or free-text messages.
 *
 * `message` and `details` are always constructed from fixed strings and from the server's own
 * bounded/redacted tool-error envelope (see `packages/mcp/src/server.ts`'s `toolError`) — never
 * from the bearer token, the `Authorization` header, or any other client-side credential. See
 * `client.ts`'s `toRemoteCatalogError` for the single place that builds these.
 */
export const REMOTE_CATALOG_ERROR_CODES = {
  /** The server rejected the request's credentials (HTTP 401 from the bearer-token boundary). */
  unauthorized: 'unauthorized',
  /** The server could not be reached at all, or did not respond within `timeoutMs`. */
  unavailable: 'unavailable',
  /** The server responded, but not with a well-formed MCP message the client can trust. */
  protocolInvalid: 'protocol-invalid',
  /** The requested component (or revision) does not exist on the remote catalog. */
  notFound: 'not-found',
  /** A retrieved component package failed task 5.1's path/hash verification. */
  integrityInvalid: 'integrity-invalid',
  /** A recognized remote tool error that does not fit any of the categories above. */
  remoteError: 'remote-error',
} as const;

export type RemoteCatalogErrorCode = (typeof REMOTE_CATALOG_ERROR_CODES)[keyof typeof REMOTE_CATALOG_ERROR_CODES];

export class RemoteCatalogError extends Error {
  readonly code: RemoteCatalogErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: RemoteCatalogErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'RemoteCatalogError';
    this.code = code;
    this.details = details;
  }
}
