import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { defaultCatalogRoot, type CompatibilityInput, type ComponentInspection, type ProjectProfile } from '@blockbase/core';
import {
  type AdaptationBundle,
  CONTRACT_VERSION,
  parseAdaptationBundle,
  parseProjectProfile,
  parseRemoteComponentPackage,
  parseValidationResult,
  REMOTE_PACKAGE_MAX_DECODED_BYTES,
  REMOTE_PACKAGE_MAX_ENTRIES,
  stableStringify,
  type RemoteComponentPackage,
  type SourceEnvelope,
} from '@blockbase/contracts';
import {
  AdaptationError,
  IndexError,
  inspectComponent,
  inspectProject,
  prepareComponentAdaptation,
  ProjectInspectionError,
  revisionHash,
  searchComponents,
  sha256,
  validateAdaptation,
  ValidationError,
  type SearchResponse,
} from '@blockbase/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const TOOL_VERSION = CONTRACT_VERSION;
const DEFAULT_SERVER_VERSION = '0.1.0';
const shutdownRequestSchema = z.object({ method: z.literal('shutdown') }).passthrough();
const exitNotificationSchema = z.object({ method: z.literal('notifications/exit') }).passthrough();

const filtersSchema = z.object({
  framework: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
  runtime: z.string().min(1).optional(),
  styling_modes: z.array(z.string().min(1)).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  confidence_margin: z.number().min(0).max(1).optional(),
}).strict().optional();

const catalogRootSchema = z.string().min(1).optional();

const searchInputSchema = {
  query: z.string().min(1),
  filters: filtersSchema,
  project_path: z.string().min(1).optional(),
  catalog_root: catalogRootSchema,
};

const getComponentInputSchema = {
  id: z.string().min(1),
  revision: z.string().min(1).optional(),
  catalog_root: catalogRootSchema,
};

const getComponentPackageInputSchema = {
  id: z.string().min(1),
  revision: z.string().min(1).optional(),
  catalog_root: catalogRootSchema,
};

const inspectProjectInputSchema = {
  project_path: z.string().min(1),
};

const prepareAdaptationInputSchema = {
  id: z.string().min(1),
  project_path: z.string().min(1),
  catalog_root: catalogRootSchema,
  options: z.object({
    revision: z.string().min(1).optional(),
    out_dir: z.string().min(1).optional(),
  }).strict().optional(),
};

const validateAdaptationInputSchema = {
  bundle_id: z.string().min(1).optional(),
  project_path: z.string().min(1),
  bundle: z.unknown().optional(),
};

export type McpServices = {
  searchComponents: typeof searchComponents;
  inspectComponent: typeof inspectComponent;
  inspectProject: typeof inspectProject;
  prepareComponentAdaptation: typeof prepareComponentAdaptation;
  validateAdaptation: typeof validateAdaptation;
};

export type McpServerOptions = {
  catalogRoot?: string;
  serverName?: string;
  serverVersion?: string;
  services?: Partial<McpServices>;
};

type ToolError = {
  schemaVersion: typeof TOOL_VERSION;
  ok: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  warnings: [];
  recoveryActions: Array<{ id: string; label: string; safe: boolean; command?: string }>;
};

type ToolSuccess<T> = T;

const REMOTE_PACKAGE_ERROR_CODES = {
  integrity: 'REMOTE_PACKAGE_INTEGRITY',
  tooLarge: 'REMOTE_PACKAGE_TOO_LARGE',
} as const;

/**
 * Raised by `get_component_package` when the on-disk revision fails a bounded read or an
 * integrity check against its own immutable revision ID (see `buildRemoteComponentPackage`).
 * Mirrors the shape of `@blockbase/core`'s own domain error classes (`code` + `details`) so it
 * flows through the same `errorCode`/`errorMessage`/`errorDetails` handling below.
 */
class RemotePackageError extends Error {
  readonly code: (typeof REMOTE_PACKAGE_ERROR_CODES)[keyof typeof REMOTE_PACKAGE_ERROR_CODES];
  readonly details: Record<string, unknown>;

  constructor(code: (typeof REMOTE_PACKAGE_ERROR_CODES)[keyof typeof REMOTE_PACKAGE_ERROR_CODES], message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'RemotePackageError';
    this.code = code;
    this.details = details;
  }
}

function boundedValue(value: unknown, depth = 0): unknown {
  if (depth > 2) return '[truncated]';
  if (typeof value === 'string') return value.slice(0, 2048);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => boundedValue(item, depth + 1));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).slice(0, 12).map(([key, item]) => [key, boundedValue(item, depth + 1)]));
  }
  return String(value).slice(0, 2048);
}

function errorDetails(error: unknown): Record<string, unknown> | undefined {
  if (error instanceof IndexError || error instanceof ProjectInspectionError || error instanceof AdaptationError || error instanceof ValidationError || error instanceof RemotePackageError) {
    const details = boundedValue(error.details);
    return details && typeof details === 'object' && !Array.isArray(details) ? details as Record<string, unknown> : undefined;
  }
  if (error instanceof z.ZodError) return { issues: error.issues.slice(0, 8).map((issue) => ({ path: issue.path, message: issue.message })) };
  return undefined;
}

function recoveryActions(error: unknown): ToolError['recoveryActions'] {
  if (error instanceof IndexError) {
    const action = error.details.recoveryAction;
    if (action && typeof action === 'object' && !Array.isArray(action)) return [action as ToolError['recoveryActions'][number]];
  }
  return [];
}

function errorCode(error: unknown): string {
  if (error instanceof IndexError || error instanceof ProjectInspectionError || error instanceof AdaptationError || error instanceof ValidationError || error instanceof RemotePackageError) return error.code;
  if (error instanceof z.ZodError) return 'INVALID_INPUT';
  if (error instanceof SyntaxError) return 'INVALID_INPUT';
  if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return 'CATALOG_NOT_FOUND';
  return 'INTERNAL_ERROR';
}

function errorMessage(error: unknown): string {
  if (error instanceof IndexError || error instanceof ProjectInspectionError || error instanceof AdaptationError || error instanceof ValidationError || error instanceof RemotePackageError || error instanceof z.ZodError) return error.message;
  if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return 'The requested catalog or project path was not found.';
  return 'The MCP tool failed unexpectedly.';
}

function toolError(error: unknown): CallToolResult {
  const envelope: ToolError = {
    schemaVersion: TOOL_VERSION,
    ok: false,
    error: {
      code: errorCode(error),
      message: errorMessage(error),
      ...(errorDetails(error) ? { details: errorDetails(error) } : {}),
    },
    warnings: [],
    recoveryActions: recoveryActions(error),
  };
  return {
    isError: true,
    structuredContent: envelope,
    content: [{ type: 'text', text: stableStringify(envelope) }],
  };
}

function toolSuccess<T>(value: ToolSuccess<T>): CallToolResult {
  const text = stableStringify(value);
  return { structuredContent: value as Record<string, unknown>, content: [{ type: 'text', text }] };
}

/**
 * The actual media type of a stored asset is not persisted to disk by `RevisionStore` (see
 * `packages/core/src/store/revisions/store.ts` and `packages/core/src/import/local.ts`, both of
 * which hardcode this same value at commit time) — only its bytes and hash survive. This is the
 * documented bounded read contract for `get_component_package`'s assets.
 */
const DEFAULT_REMOTE_ASSET_MEDIA_TYPE = 'application/octet-stream';

type RevisionTreeEntry = { path: string; absolute: string };

/**
 * Recursively lists regular files under `root`, using forward-slash relative paths. Rejects
 * symbolic links outright (an immutable revision's committed content never contains one) rather
 * than silently following or skipping them. When `allowMissingRoot` is set, a missing `root`
 * itself yields an empty list — this is expected for a revision with no assets, since
 * `RevisionStore` only creates an `assets/` directory when a revision actually has any.
 */
async function listRevisionTree(root: string, allowMissingRoot: boolean): Promise<RevisionTreeEntry[]> {
  const output: RevisionTreeEntry[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.slice().sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw new RemotePackageError(REMOTE_PACKAGE_ERROR_CODES.integrity, 'The stored revision contains a symbolic link, which immutable component packages do not support.', { path: relativePath });
      }
      if (entry.isDirectory()) {
        await visit(absolute, relativePath);
        continue;
      }
      if (entry.isFile()) output.push({ path: relativePath, absolute });
    }
  }
  try {
    await visit(root, '');
  } catch (error) {
    if (allowMissingRoot && error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return output;
}

type RevisionBudget = { entries: number; bytes: number };

/**
 * Reads every file `listRevisionTree` found under `root`, enforcing the same combined
 * entry-count and decoded-byte bounds `parseRemoteComponentPackage` documents and enforces
 * (`REMOTE_PACKAGE_MAX_ENTRIES` / `REMOTE_PACKAGE_MAX_DECODED_BYTES`), so a revision directory
 * that would fail contract validation is refused here first with a clear tool error instead of
 * an oversized read.
 */
async function readBoundedRevisionTree(root: string, allowMissingRoot: boolean, budget: RevisionBudget): Promise<Array<{ path: string; bytes: Buffer }>> {
  const tree = await listRevisionTree(root, allowMissingRoot);
  const output: Array<{ path: string; bytes: Buffer }> = [];
  for (const entry of tree) {
    budget.entries += 1;
    if (budget.entries > REMOTE_PACKAGE_MAX_ENTRIES) {
      throw new RemotePackageError(REMOTE_PACKAGE_ERROR_CODES.tooLarge, `The stored revision exceeds the maximum of ${REMOTE_PACKAGE_MAX_ENTRIES} readable files and assets.`, { limit: REMOTE_PACKAGE_MAX_ENTRIES });
    }
    const bytes = await readFile(entry.absolute);
    budget.bytes += bytes.byteLength;
    if (budget.bytes > REMOTE_PACKAGE_MAX_DECODED_BYTES) {
      throw new RemotePackageError(REMOTE_PACKAGE_ERROR_CODES.tooLarge, `The stored revision exceeds the maximum decoded size of ${REMOTE_PACKAGE_MAX_DECODED_BYTES} bytes.`, { limit: REMOTE_PACKAGE_MAX_DECODED_BYTES });
    }
    output.push({ path: entry.path, bytes });
  }
  return output;
}

/**
 * Builds and fully verifies the `RemoteComponentPackage` for one resolved component revision.
 * Reads only the two known, bounded subdirectories an immutable revision can contain —
 * `revisions/<id>/original/**` (source files) and `revisions/<id>/assets/**` (binary assets) —
 * never anything else under the component's package directory, and never a raw filesystem path
 * makes it into the returned value.
 *
 * Integrity: `inspection.revisionId` is itself the cryptographic commitment `RevisionStore`
 * computed over this exact revision's canonical (path, contentHash) pairs at commit time (see
 * `revisionHash` in `packages/core/src/import/local.ts`). Recomputing that same hash from what
 * is actually on disk right now and comparing it to `inspection.revisionId` is therefore a
 * complete manifest/disk integrity check — for the manifest's current revision *and* for any
 * older immutable revision explicitly requested — without needing per-file hashes to be
 * separately declared anywhere in `ComponentManifest`.
 */
async function buildRemoteComponentPackage(inspection: Pick<ComponentInspection, 'componentId' | 'revisionId' | 'manifest' | 'revisionPath'>): Promise<RemoteComponentPackage> {
  const budget: RevisionBudget = { entries: 0, bytes: 0 };
  const fileEntries = await readBoundedRevisionTree(join(inspection.revisionPath, 'original'), false, budget);
  const assetEntries = await readBoundedRevisionTree(join(inspection.revisionPath, 'assets'), true, budget);

  const files = fileEntries.map((entry) => ({ path: entry.path, content: entry.bytes.toString('utf8'), contentHash: sha256(entry.bytes) }));
  const assets = assetEntries.map((entry) => ({ path: entry.path, contentBase64: entry.bytes.toString('base64'), contentHash: sha256(entry.bytes), mediaType: DEFAULT_REMOTE_ASSET_MEDIA_TYPE }));

  const canonicalEnvelope: SourceEnvelope = {
    schemaVersion: CONTRACT_VERSION,
    sourceType: 'directory',
    files: files.map(({ path, content, contentHash }) => ({ path, content, contentHash })),
    assets: assets.map(({ path, contentHash }) => ({ path, mediaType: DEFAULT_REMOTE_ASSET_MEDIA_TYPE, contentHash })),
    provenance: { sourceType: 'directory', locator: inspection.componentId },
  };
  let recomputedRevisionId: string;
  try {
    recomputedRevisionId = revisionHash(canonicalEnvelope);
  } catch (error) {
    throw new RemotePackageError(REMOTE_PACKAGE_ERROR_CODES.integrity, 'The stored revision contents could not be canonicalized to verify integrity.', {
      componentId: inspection.componentId,
      revisionId: inspection.revisionId,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (recomputedRevisionId !== inspection.revisionId) {
    throw new RemotePackageError(REMOTE_PACKAGE_ERROR_CODES.integrity, 'The stored revision contents do not match the immutable revision id; retrieval was refused.', {
      componentId: inspection.componentId,
      revisionId: inspection.revisionId,
    });
  }

  // Self-validates against the published RemoteComponentPackage contract (path safety, hash
  // agreement, bounds) and returns a freshly constructed value containing only known fields —
  // packagePath/revisionPath are never part of its input, so they cannot leak into the output.
  return parseRemoteComponentPackage({
    schemaVersion: CONTRACT_VERSION,
    componentId: inspection.componentId,
    revisionId: inspection.revisionId,
    manifest: inspection.manifest,
    files,
    assets,
  });
}

function rootFor(value: string | undefined, fallback: string | undefined): string {
  const configured = value ?? fallback ?? process.env.BLOCKBASE_HOME;
  if (!configured) return defaultCatalogRoot(process.platform, process.env, homedir());
  return basename(configured) === 'catalog.yaml' ? dirname(resolve(configured)) : resolve(configured);
}

type Filters = z.infer<typeof filtersSchema>;

function compatibilityFor(filters: Filters, project: ProjectProfile | undefined): CompatibilityInput | undefined {
  if (!filters && !project) return undefined;
  return {
    ...(filters?.framework ? { framework: filters.framework } : {}),
    ...(filters?.language ? { language: filters.language } : {}),
    ...(filters?.runtime ? { runtime: filters.runtime } : {}),
    ...(filters?.styling_modes ? { stylingModes: filters.styling_modes } : {}),
    ...(project ? { project } : {}),
  };
}

function registerTools(server: McpServer, options: McpServerOptions): void {
  const services: McpServices = {
    searchComponents,
    inspectComponent,
    inspectProject,
    prepareComponentAdaptation,
    validateAdaptation,
    ...options.services,
  };
  const bundles = new Map<string, AdaptationBundle>();

  server.registerTool('search_components', {
    description: 'Search the versioned Blockbase component index.',
    inputSchema: searchInputSchema,
  }, async (input) => {
    try {
      const project = input.project_path ? await services.inspectProject(input.project_path) : undefined;
      const result: SearchResponse = await services.searchComponents(rootFor(input.catalog_root, options.catalogRoot), input.query, {
        ...(input.filters?.limit !== undefined ? { limit: input.filters.limit } : {}),
        ...(input.filters?.confidence_margin !== undefined ? { confidenceMargin: input.filters.confidence_margin } : {}),
        ...(compatibilityFor(input.filters, project) ? { compatibility: compatibilityFor(input.filters, project) } : {}),
      });
      return toolSuccess(result);
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('get_component', {
    description: 'Inspect an exact component ID or alias and immutable revision.',
    inputSchema: getComponentInputSchema,
  }, async (input) => {
    try {
      const result = await services.inspectComponent(rootFor(input.catalog_root, options.catalogRoot), input.id, input.revision);
      return toolSuccess(result);
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('get_component_package', {
    description: 'Retrieve an exact component revision as a self-contained, integrity-checked immutable package (source files and assets). Read-only; returns no server filesystem paths.',
    inputSchema: getComponentPackageInputSchema,
  }, async (input) => {
    try {
      const inspection = await services.inspectComponent(rootFor(input.catalog_root, options.catalogRoot), input.id, input.revision);
      const result = await buildRemoteComponentPackage(inspection);
      return toolSuccess(result);
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('inspect_project', {
    description: 'Inspect bounded destination project conventions and validation commands.',
    inputSchema: inspectProjectInputSchema,
  }, async (input) => {
    try {
      const result = parseProjectProfile(await services.inspectProject(input.project_path));
      if (result.conflicts.length > 0) {
        throw new ProjectInspectionError(
          'PROJECT_CONFLICT',
          'Project inspection found material token conflicts; select a definition or add .blockbase/project.json overrides.',
          { conflicts: result.conflicts, profile: result },
        );
      }
      return toolSuccess(result);
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('prepare_adaptation', {
    description: 'Prepare a deterministic adaptation bundle without applying destination files.',
    inputSchema: prepareAdaptationInputSchema,
  }, async (input) => {
    try {
      const adaptationOptions = {
        catalogRoot: rootFor(input.catalog_root, options.catalogRoot),
        projectPath: input.project_path,
        ...(input.options?.revision ? { revision: input.options.revision } : {}),
        ...(input.options?.out_dir ? { outDir: input.options.out_dir } : {}),
      };
      const result = parseAdaptationBundle(await services.prepareComponentAdaptation(input.id, adaptationOptions));
      bundles.set(result.bundleId, result);
      return toolSuccess(result);
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('validate_adaptation', {
    description: 'Validate a prepared adaptation bundle without applying destination files.',
    inputSchema: validateAdaptationInputSchema,
  }, async (input) => {
    try {
      const parsedBundle = input.bundle === undefined ? undefined : parseAdaptationBundle(input.bundle);
      const bundleId = input.bundle_id ?? parsedBundle?.bundleId;
      if (!bundleId) throw new z.ZodError([{ code: 'custom', path: ['bundle_id'], message: 'bundle_id or bundle is required' }]);
      if (parsedBundle && parsedBundle.bundleId !== bundleId) throw new ValidationError('VALIDATE_BUNDLE_MISMATCH', 'The supplied adaptation bundle ID does not match bundle_id.', { expected: bundleId, received: parsedBundle.bundleId });
      const bundle = parsedBundle ?? bundles.get(bundleId);
      if (!bundle) throw new ValidationError('VALIDATE_BUNDLE_NOT_FOUND', 'The adaptation bundle is not available in this MCP session; provide bundle.', { bundleId });
      const result = parseValidationResult(await services.validateAdaptation(bundle, { projectPath: input.project_path }));
      return toolSuccess(result);
    } catch (error) {
      return toolError(error);
    }
  });
}

export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: options.serverName ?? 'blockbase', version: options.serverVersion ?? DEFAULT_SERVER_VERSION });
  registerTools(server, options);
  return server;
}

export async function startStdioServer(options: McpServerOptions = {}): Promise<void> {
  const server = createMcpServer(options);
  const transport = new StdioServerTransport();
  server.server.setRequestHandler(shutdownRequestSchema, async () => {
    // Let the JSON-RPC shutdown response flush before ending the stdio transport.
    setImmediate(() => { void server.close().catch(() => undefined); });
    return {};
  });
  server.server.setNotificationHandler(exitNotificationSchema, () => {
    void server.close().catch(() => undefined);
  });
  const close = () => {
    void server.close().catch(() => undefined);
  };
  process.stdin.once('end', close);
  process.stdin.once('close', close);
  process.stdin.once('error', close);
  await server.connect(transport);
}

const DEFAULT_MCP_HTTP_PATH = '/mcp';
const MAX_HTTP_BODY_BYTES = 8 * 1024 * 1024;

export type HttpServerOptions = McpServerOptions & {
  host: string;
  port: number;
  path?: string;
  /**
   * Pre-shared bearer token required on every request to the MCP HTTP path. Defaults to
   * `process.env.BLOCKBASE_MCP_TOKEN`. HTTP transport refuses to start when neither is a
   * non-empty string (see `resolveHttpAuthToken`); this option exists mainly for tests and
   * embedders that want to avoid mutating process env.
   */
  token?: string;
};

export type HttpServerHandle = {
  url: string;
  close(): Promise<void>;
};

function validateHttpServerOptions(options: HttpServerOptions): { host: string; port: number; path: string } {
  if (typeof options.host !== 'string' || options.host.trim().length === 0) {
    throw new RangeError('startHttpServer requires a non-empty "host".');
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new RangeError('startHttpServer requires "port" to be an integer between 0 and 65535.');
  }
  const path = options.path ?? DEFAULT_MCP_HTTP_PATH;
  if (typeof path !== 'string' || !path.startsWith('/') || path.length === 0) {
    throw new RangeError('startHttpServer requires "path" to start with "/".');
  }
  return { host: options.host, port: options.port, path };
}

/**
 * Resolves the pre-shared bearer token that HTTP transport requires on every `/mcp` request.
 * `options.token` wins when set; otherwise falls back to `BLOCKBASE_MCP_TOKEN`. Throws a
 * `RangeError` (mirroring `validateHttpServerOptions`) when neither is a non-empty string, so
 * HTTP mode refuses to start — and never opens a socket — without a configured token. The
 * thrown message never echoes the (absent) token value.
 */
function resolveHttpAuthToken(options: HttpServerOptions): string {
  const configured = options.token ?? process.env.BLOCKBASE_MCP_TOKEN;
  if (typeof configured !== 'string' || configured.trim().length === 0) {
    throw new RangeError(
      'startHttpServer requires a non-empty BLOCKBASE_MCP_TOKEN environment variable (or "token" option) to authenticate HTTP requests.',
    );
  }
  return configured;
}

const BEARER_PREFIX = 'Bearer ';

/**
 * Parses the `Authorization` header value against the `Bearer <token>` shape required by
 * RFC 6750. Returns `undefined` for anything else (wrong scheme, missing token, embedded
 * whitespace) so the caller can classify it as a malformed-credentials 401.
 */
function parseBearerToken(headerValue: string): string | undefined {
  if (!headerValue.startsWith(BEARER_PREFIX)) return undefined;
  const token = headerValue.slice(BEARER_PREFIX.length);
  if (token.length === 0 || /\s/.test(token)) return undefined;
  return token;
}

/**
 * Compares two tokens in time that does not depend on where they first differ or on their
 * length. SHA-256 digests both inputs to a fixed 32-byte length before calling
 * `crypto.timingSafeEqual`, so a length mismatch between `candidate` and `expected` can never
 * reach (and throw out of) `timingSafeEqual` itself — hashing sidesteps the length check
 * entirely rather than special-casing it.
 */
function timingSafeTokenMatch(candidate: string, expected: string): boolean {
  const candidateDigest = createHash('sha256').update(candidate, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

type AuthFailureReason = 'missing' | 'malformed' | 'duplicate' | 'invalid';

const AUTH_FAILURE_MESSAGES: Record<AuthFailureReason, string> = {
  missing: 'Unauthorized: an Authorization header is required.',
  malformed: 'Unauthorized: Authorization header must use the "Bearer <token>" scheme.',
  duplicate: 'Unauthorized: multiple Authorization headers are not allowed.',
  invalid: 'Unauthorized: invalid credentials.',
};

const AUTH_FAILURE_WWW_AUTHENTICATE_ERROR: Record<AuthFailureReason, string> = {
  missing: 'invalid_request',
  malformed: 'invalid_request',
  duplicate: 'invalid_request',
  invalid: 'invalid_token',
};

/**
 * Authenticates one HTTP request against `expectedToken`. Reads `req.rawHeaders` (rather than
 * `req.headers`) specifically to detect duplicate `Authorization` headers: Node's `IncomingMessage`
 * silently discards duplicates of several single-value header names — `authorization` among
 * them — when building `req.headers`, so that collapsed view cannot see a duplicate at all.
 */
function authenticateHttpRequest(req: IncomingMessage, expectedToken: string): { ok: true } | { ok: false; reason: AuthFailureReason } {
  const rawHeaders = req.rawHeaders;
  const authorizationValues: string[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index].toLowerCase() === 'authorization') authorizationValues.push(rawHeaders[index + 1]);
  }
  if (authorizationValues.length === 0) return { ok: false, reason: 'missing' };
  if (authorizationValues.length > 1) return { ok: false, reason: 'duplicate' };
  const candidateToken = parseBearerToken(authorizationValues[0]);
  if (candidateToken === undefined) return { ok: false, reason: 'malformed' };
  if (!timingSafeTokenMatch(candidateToken, expectedToken)) return { ok: false, reason: 'invalid' };
  return { ok: true };
}

/** Writes a bounded, non-secret 401 with a standard `WWW-Authenticate: Bearer error="..."` header. */
function writeUnauthorizedResponse(res: ServerResponse, reason: AuthFailureReason): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const payload = JSON.stringify(jsonRpcErrorBody(-32002, AUTH_FAILURE_MESSAGES[reason]));
  res.writeHead(401, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'www-authenticate': `Bearer error="${AUTH_FAILURE_WWW_AUTHENTICATE_ERROR[reason]}"`,
  });
  res.end(payload);
}

function writeJsonResponse(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function jsonRpcErrorBody(code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: null, error: { code, message: message.slice(0, 512) } };
}

class HttpBodyError extends Error {}

async function readJsonRequestBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_HTTP_BODY_BYTES) throw new HttpBodyError('Request body exceeds the maximum allowed size.');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim().length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpBodyError('Request body is not valid JSON.');
  }
}

/**
 * Starts a Streamable HTTP MCP server bound to `options.host`/`options.port`, serving
 * MCP exclusively at `options.path` (default `/mcp`) via the pinned SDK
 * `StreamableHTTPServerTransport`. Each initialized session gets its own `McpServer`
 * instance and transport, so concurrent clients never share session state.
 *
 * Every request to that path requires exactly one valid `Authorization: Bearer <token>`
 * header, checked with a timing-safe comparison against `options.token` /
 * `BLOCKBASE_MCP_TOKEN` (see `authenticateHttpRequest`). Startup itself refuses to run — and
 * never opens a listening socket — when no non-empty token is configured (see
 * `resolveHttpAuthToken`). This bearer-token boundary is HTTP-only: `startStdioServer` never
 * requires or reads a token.
 */
export async function startHttpServer(options: HttpServerOptions): Promise<HttpServerHandle> {
  const { host, port, path } = validateHttpServerOptions(options);
  const authToken = resolveHttpAuthToken(options);

  const transports = new Map<string, StreamableHTTPServerTransport>();

  async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawSessionId = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
    try {
      if (sessionId) {
        const transport = transports.get(sessionId);
        if (!transport) {
          writeJsonResponse(res, 404, jsonRpcErrorBody(-32001, 'Session not found.'));
          return;
        }
        const body = req.method === 'POST' ? await readJsonRequestBody(req) : undefined;
        await transport.handleRequest(req, res, body);
        return;
      }

      if (req.method !== 'POST') {
        writeJsonResponse(res, 400, jsonRpcErrorBody(-32000, 'Bad Request: no valid session ID provided.'));
        return;
      }

      const body = await readJsonRequestBody(req);
      if (!isInitializeRequest(body)) {
        writeJsonResponse(res, 400, jsonRpcErrorBody(-32000, 'Bad Request: no valid session ID provided.'));
        return;
      }

      const session = createMcpServer(options);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) transports.delete(sid);
        void session.close().catch(() => undefined);
      };
      await session.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (error instanceof HttpBodyError) {
        writeJsonResponse(res, 400, jsonRpcErrorBody(-32000, error.message));
        return;
      }
      writeJsonResponse(res, 500, jsonRpcErrorBody(-32603, 'Internal server error.'));
    }
  }

  const httpServer: HttpServer = createHttpServer((req, res) => {
    void (async () => {
      try {
        const requestUrl = new URL(req.url ?? '/', 'http://internal.invalid');
        if (requestUrl.pathname !== path) {
          writeJsonResponse(res, 404, jsonRpcErrorBody(-32601, 'Not Found: MCP is only served at the configured path.'));
          return;
        }
        if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') {
          writeJsonResponse(res, 405, jsonRpcErrorBody(-32601, `Method Not Allowed: ${req.method ?? 'UNKNOWN'}.`));
          return;
        }
        // Bearer-token boundary: must run after path/method validation and strictly before
        // handleMcpRequest, so a rejected request never creates a transport/session or reaches
        // any tool — no MCP or session code below this point runs for an unauthenticated caller.
        const auth = authenticateHttpRequest(req, authToken);
        if (!auth.ok) {
          writeUnauthorizedResponse(res, auth.reason);
          return;
        }
        await handleMcpRequest(req, res);
      } catch {
        writeJsonResponse(res, 500, jsonRpcErrorBody(-32603, 'Internal server error.'));
      }
    })();
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: unknown) => rejectListen(error);
    httpServer.once('error', onError);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', onError);
      resolveListen();
    });
  });

  const address = httpServer.address();
  const actualPort = address && typeof address === 'object' ? address.port : port;
  const url = `http://${host}:${actualPort}${path}`;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await Promise.all(Array.from(transports.values()).map((transport) => transport.close().catch(() => undefined)));
    transports.clear();
    await new Promise<void>((resolveClose, rejectClose) => {
      httpServer.close((error) => (error ? rejectClose(error) : resolveClose()));
    });
  };

  const onSignal = () => {
    void close();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  return { url, close };
}
