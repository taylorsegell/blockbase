import {
  ContractValidationError,
  parseRemoteComponentPackage,
  REMOTE_PACKAGE_MAX_DECODED_BYTES,
  type RemoteComponentPackage,
} from '@blockbase/contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ComponentInspection, SearchResponse } from '../index/types.js';
import { REMOTE_CATALOG_ERROR_CODES, RemoteCatalogError } from './errors.js';

/** The exact result shape `Client#callTool` resolves with — derived rather than imported so it always matches the pinned SDK's own (occasionally task-execution-augmented) inference. */
type ToolCallResult = Awaited<ReturnType<Client['callTool']>>;

/**
 * A read-only, authenticated client for the remote Blockbase MCP catalog surface
 * (`search_components` / `get_component` / `get_component_package` — see
 * `packages/mcp/src/server.ts`). It never reads or writes anything on the local filesystem: it
 * only ever talks to `options.url`, and it never sends a `catalog_root` argument, so the remote
 * server's own configured catalog root is always what answers every call — this client has no
 * local-catalog-root dependency to violate.
 */
export type RemoteCatalogClientOptions = {
  /** Base URL of the remote MCP Streamable HTTP endpoint (e.g. `https://catalog.example/mcp`). */
  url: string;
  /** `BLOCKBASE_MCP_TOKEN` value; sent only as an `Authorization: Bearer <token>` request header. */
  token: string;
  /** Bounds both the initial connection/handshake and every subsequent tool call. Default 10s. */
  timeoutMs?: number;
};

export type RemoteSearchFilters = {
  framework?: string;
  language?: string;
  runtime?: string;
  stylingModes?: string[];
  limit?: number;
  confidenceMargin?: number;
};

export type RemoteSearchOptions = {
  filters?: RemoteSearchFilters;
  /** Forwarded to the server so it can compute project compatibility; never a local catalog path. */
  projectPath?: string;
};

export type RemoteCatalogClient = {
  search(query: string, options?: RemoteSearchOptions): Promise<SearchResponse>;
  inspect(id: string, revision?: string): Promise<ComponentInspection>;
  getPackage(id: string, revision?: string): Promise<RemoteComponentPackage>;
  close(): Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const CLIENT_NAME = 'blockbase-remote-catalog-client';
const CLIENT_VERSION = '0.1.0';

/**
 * Same bound task 5.1 already enforces on a decoded `RemoteComponentPackage`
 * (`REMOTE_PACKAGE_MAX_DECODED_BYTES`, 8 MiB) — reused here as the cap on one raw HTTP response
 * body, so an oversized or runaway response is rejected before it is ever fully buffered.
 */
const MAX_RESPONSE_BYTES = REMOTE_PACKAGE_MAX_DECODED_BYTES;

class ResponseSizeLimitError extends Error {}

function tooLargeError(maxBytes: number, observed: number | string): ResponseSizeLimitError {
  return new ResponseSizeLimitError(`Remote catalog response is ${observed} bytes, exceeding the ${maxBytes}-byte limit.`);
}

/**
 * Fully reads `response.body` up to `maxBytes`, rejecting the moment the cap would be exceeded,
 * and otherwise returns a fresh `Response` over the buffered bytes. Every JSON-RPC request this
 * client makes is a single POST whose answer (`application/json` or `text/event-stream`, per the
 * pinned SDK's `StreamableHTTPClientTransport`) always finishes promptly — so buffering it here
 * turns an oversized response into an immediate rejection of the `fetch()` call that triggered it,
 * rather than an error raised deep inside the SDK's stream parser that no caller ever observes
 * (see `withStreamedBound` below for why the *other* kind of response can't be handled this way).
 */
async function withBufferedBound(response: Response, maxBytes: number): Promise<Response> {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLargeError(maxBytes, total);
    }
    chunks.push(value);
  }
  const buffered = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffered.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(buffered, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * Caps `response.body` as it streams, without ever waiting for it to end. This is for the one
 * connection this client's transport can hold open indefinitely — the standalone listening GET
 * request `StreamableHTTPClientTransport` opens after `initialize` for server-pushed
 * notifications — which `withBufferedBound` must not touch, since "buffer until EOF" would hang
 * forever on a stream that may never end. Nothing in `RemoteCatalogClient`'s public API depends on
 * that channel; this only exists so a hostile/broken server can't grow it without bound in memory.
 */
function withStreamedBound(response: Response, maxBytes: number): Response {
  let total = 0;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        controller.error(tooLargeError(maxBytes, total));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return new Response(response.body!.pipeThrough(limiter), { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Wraps `fetch` so every response body this client reads is capped at `maxBytes`, never unbounded. */
function boundedFetch(maxBytes: number): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && Number(declaredLength) > maxBytes) {
      await response.body?.cancel();
      throw tooLargeError(maxBytes, declaredLength);
    }
    if (!response.body) return response;
    const method = typeof init?.method === 'string' ? init.method.toUpperCase() : 'GET';
    return method === 'POST' ? withBufferedBound(response, maxBytes) : withStreamedBound(response, maxBytes);
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Duck-types a `fetch`-thrown network failure (`TypeError`, e.g. connection refused, DNS, TLS). */
function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}

/** Duck-types a Zod (or Zod-compatible) validation failure without importing zod into `@blockbase/core`. */
function isSchemaValidationError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Array.isArray((error as { issues?: unknown }).issues);
}

/**
 * Normalizes any error the SDK client, the bounded fetch wrapper, or task 5.1's contract parser
 * can throw into a `RemoteCatalogError`. This is the single place responsible for keeping the
 * bearer token out of thrown messages: every branch below builds its own fixed message string
 * instead of forwarding the underlying error's `message` (which, for HTTP-layer failures, is
 * server-controlled response text — never the token the client sent).
 */
function toRemoteCatalogError(error: unknown, context: { timeoutMs: number }): RemoteCatalogError {
  if (error instanceof RemoteCatalogError) return error;
  if (error instanceof ContractValidationError) {
    return new RemoteCatalogError(
      REMOTE_CATALOG_ERROR_CODES.integrityInvalid,
      'The remote catalog server returned a component package that failed path/hash integrity verification.',
      { issues: error.issues },
    );
  }
  if (error instanceof ResponseSizeLimitError) {
    return new RemoteCatalogError(REMOTE_CATALOG_ERROR_CODES.protocolInvalid, 'The remote catalog server response exceeded the allowed size limit.');
  }
  if (error instanceof StreamableHTTPError) {
    if (error.code === 401) {
      return new RemoteCatalogError(REMOTE_CATALOG_ERROR_CODES.unauthorized, 'The remote catalog server rejected the request credentials.');
    }
    return new RemoteCatalogError(REMOTE_CATALOG_ERROR_CODES.unavailable, `The remote catalog server is unavailable (HTTP ${error.code}).`, { status: error.code });
  }
  if (error instanceof McpError) {
    if (error.code === ErrorCode.RequestTimeout) {
      return new RemoteCatalogError(REMOTE_CATALOG_ERROR_CODES.unavailable, `The remote catalog request did not complete within ${context.timeoutMs}ms.`, { timeoutMs: context.timeoutMs });
    }
    return new RemoteCatalogError(REMOTE_CATALOG_ERROR_CODES.protocolInvalid, 'The remote catalog server returned an invalid MCP protocol message.', { mcpErrorCode: error.code });
  }
  if (isAbortError(error)) {
    return new RemoteCatalogError(REMOTE_CATALOG_ERROR_CODES.unavailable, `The remote catalog request did not complete within ${context.timeoutMs}ms.`, { timeoutMs: context.timeoutMs });
  }
  if (isNetworkError(error)) {
    return new RemoteCatalogError(REMOTE_CATALOG_ERROR_CODES.unavailable, 'The remote catalog server could not be reached.');
  }
  if (isSchemaValidationError(error) || error instanceof SyntaxError) {
    return new RemoteCatalogError(REMOTE_CATALOG_ERROR_CODES.protocolInvalid, 'The remote catalog server returned a response that does not match the expected MCP protocol shape.');
  }
  return new RemoteCatalogError(REMOTE_CATALOG_ERROR_CODES.remoteError, 'The remote catalog client encountered an unexpected error.');
}

type ToolErrorEnvelope = { code?: unknown; message?: unknown; details?: unknown };

/** Maps a tool call's `isError` result (see `toolError` in `packages/mcp/src/server.ts`) to a `RemoteCatalogError`. */
function toToolCallError(result: ToolCallResult): RemoteCatalogError {
  const content = result.structuredContent;
  const rawError: ToolErrorEnvelope =
    content && typeof content === 'object' && 'error' in (content as Record<string, unknown>)
      ? ((content as Record<string, unknown>).error as ToolErrorEnvelope)
      : {};
  const remoteCode = typeof rawError.code === 'string' ? rawError.code : 'UNKNOWN';
  const message = typeof rawError.message === 'string' ? rawError.message : 'The remote catalog server reported a tool error.';
  const details = rawError.details && typeof rawError.details === 'object' ? (rawError.details as Record<string, unknown>) : {};
  if (remoteCode === 'COMPONENT_NOT_FOUND') {
    return new RemoteCatalogError(REMOTE_CATALOG_ERROR_CODES.notFound, message, { ...details, remoteCode });
  }
  return new RemoteCatalogError(REMOTE_CATALOG_ERROR_CODES.remoteError, message, { ...details, remoteCode });
}

/** Unwraps a successful `CallToolResult`'s `structuredContent`, or throws a classified error. */
function unwrapToolResult(result: ToolCallResult): unknown {
  if (result.isError) throw toToolCallError(result);
  if (result.structuredContent === undefined || typeof result.structuredContent !== 'object' || result.structuredContent === null) {
    throw new RemoteCatalogError(REMOTE_CATALOG_ERROR_CODES.protocolInvalid, 'The remote catalog server returned a tool result without structured content.');
  }
  return result.structuredContent;
}

function toWireFilters(filters: RemoteSearchFilters | undefined): Record<string, unknown> | undefined {
  if (!filters) return undefined;
  return {
    ...(filters.framework !== undefined ? { framework: filters.framework } : {}),
    ...(filters.language !== undefined ? { language: filters.language } : {}),
    ...(filters.runtime !== undefined ? { runtime: filters.runtime } : {}),
    ...(filters.stylingModes !== undefined ? { styling_modes: filters.stylingModes } : {}),
    ...(filters.limit !== undefined ? { limit: filters.limit } : {}),
    ...(filters.confidenceMargin !== undefined ? { confidence_margin: filters.confidenceMargin } : {}),
  };
}

type ConnectedClient = { client: Client; transport: StreamableHTTPClientTransport };

export function createRemoteCatalogClient(options: RemoteCatalogClientOptions): RemoteCatalogClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const targetUrl = options.url;
  const token = options.token;

  let closed = false;
  let connection: Promise<ConnectedClient> | undefined;

  async function connect(): Promise<ConnectedClient> {
    const transport = new StreamableHTTPClientTransport(new URL(targetUrl), {
      // The token is supplied only as this one static Authorization header — never as a query
      // parameter, a body field, or anything that could end up in a log line or a cache key.
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: boundedFetch(MAX_RESPONSE_BYTES),
    });
    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
    try {
      await client.connect(transport, { timeout: timeoutMs });
    } catch (error) {
      throw toRemoteCatalogError(error, { timeoutMs });
    }
    return { client, transport };
  }

  function ensureConnected(): Promise<ConnectedClient> {
    if (closed) {
      return Promise.reject(new RemoteCatalogError(REMOTE_CATALOG_ERROR_CODES.unavailable, 'The remote catalog client has been closed.'));
    }
    if (!connection) connection = connect();
    return connection;
  }

  async function callRemoteTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const { client } = await ensureConnected();
    try {
      return await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
    } catch (error) {
      throw toRemoteCatalogError(error, { timeoutMs });
    }
  }

  return {
    async search(query, searchOptions = {}) {
      const wireFilters = toWireFilters(searchOptions.filters);
      const result = await callRemoteTool('search_components', {
        query,
        ...(wireFilters ? { filters: wireFilters } : {}),
        ...(searchOptions.projectPath !== undefined ? { project_path: searchOptions.projectPath } : {}),
      });
      return unwrapToolResult(result) as SearchResponse;
    },

    async inspect(id, revision) {
      const result = await callRemoteTool('get_component', { id, ...(revision !== undefined ? { revision } : {}) });
      return unwrapToolResult(result) as ComponentInspection;
    },

    async getPackage(id, revision) {
      const result = await callRemoteTool('get_component_package', { id, ...(revision !== undefined ? { revision } : {}) });
      const payload = unwrapToolResult(result);
      try {
        // Re-validates paths/hashes client-side, independent of the server's own verification, so
        // a malformed or tampered-in-transit response is rejected here too, not just trusted.
        return parseRemoteComponentPackage(payload);
      } catch (error) {
        throw toRemoteCatalogError(error, { timeoutMs });
      }
    },

    async close() {
      closed = true;
      if (!connection) return;
      const pending = connection;
      connection = undefined;
      try {
        const { client } = await pending;
        await client.close();
      } catch {
        // connect() itself failed or was already rejected; there is nothing left to close.
      }
    },
  };
}
