import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { SourceEnvelope } from '@blockbase/contracts';
import { canonicalizeSourceEnvelope } from '../import/local.js';
import { disposePreviewRoot, preparePreview, type PreviewPreparation, type PreviewPreparationResult } from './paths.js';
import { PREVIEW_CSP, previewContentHeaders, previewDocument } from './sandbox.js';
import { PREVIEW_EXECUTION_POLICY, type PreviewRefusal, type PreviewRefusalResult } from './policy.js';

export type PreviewBuildRequest = {
  command: string;
  args?: string[];
  plugins?: string[];
};

export type PreviewRequest = {
  schemaVersion?: '1';
  source: SourceEnvelope;
  build?: PreviewBuildRequest;
  /** A reviewed, already-built document. It is never interpreted by Node. */
  renderedHtml?: string;
  timeoutMs?: number;
};

export type PreviewSessionStatus = 'running' | 'stopped' | 'timed-out' | 'cleanup-failed';

export type PreviewSession = {
  schemaVersion: '1';
  status: PreviewSessionStatus;
  sessionId: string;
  host: '127.0.0.1';
  port: number;
  url: string;
  rootPath: string;
  csp: string;
  getStatus: () => PreviewSessionStatus;
  close: () => Promise<{ status: PreviewSessionStatus; sessionId: string; refusal?: PreviewRefusal }>;
  waitForClose: () => Promise<void>;
};

export type PreviewStartResult = PreviewSession | PreviewRefusalResult;

export type PreviewRunnerOptions = {
  allowedBuildCommands?: readonly string[];
  host?: '127.0.0.1';
  spawnProcess?: typeof spawn;
};

function refused(refusal: PreviewRefusal): PreviewRefusalResult {
  return { schemaVersion: '1', status: 'refused', refusal };
}

function commandName(command: string): string {
  return basename(command);
}

async function runBuild(rootPath: string, build: PreviewBuildRequest, timeoutMs: number, allowedCommands: readonly string[], spawnProcess: typeof spawn): Promise<PreviewRefusal | undefined> {
  if (!allowedCommands.includes(commandName(build.command))) {
    return { code: 'unsupported-build-plugin', message: `Build command '${commandName(build.command)}' is not allowlisted.`, details: { command: build.command, allowlistedCommands: [...allowedCommands] } };
  }
  const plugin = build.plugins?.find((value) => !PREVIEW_EXECUTION_POLICY.buildPolicy.allowlistedPlugins.includes(value));
  if (plugin) return { code: 'unsupported-build-plugin', message: `Build plugin '${plugin}' is not supported by the constrained preview runner.`, details: { plugin } };
  return new Promise<PreviewRefusal | undefined>((resolve) => {
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawnProcess(build.command, build.args ?? [], {
        cwd: rootPath,
        shell: false,
        env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: 'build-failed', message: error instanceof Error ? error.message : String(error) });
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ code: 'timeout', message: `Preview build exceeded the ${timeoutMs}ms timeout.`, details: { timeoutMs } });
    }, timeoutMs);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 'build-failed', message: error.message });
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) resolve({ code: signal === 'SIGKILL' ? 'timeout' : 'build-failed', message: `Preview build exited unsuccessfully (${signal ?? code}).`, details: { code, signal } });
      else resolve(undefined);
    });
  });
}

export async function startPreviewSession(request: PreviewRequest, options: PreviewRunnerOptions = {}): Promise<PreviewStartResult> {
  const timeoutMs = Math.max(1, Math.min(request.timeoutMs ?? 10_000, 120_000));
  let preparation: PreviewPreparationResult;
  try {
    preparation = await preparePreview(canonicalizeSourceEnvelope(request.source), { plugins: request.build?.plugins });
  } catch (error) {
    return refused({ code: 'invalid-request', message: error instanceof Error ? error.message : 'The preview request is invalid.' });
  }
  if (preparation.status === 'refused') return preparation;
  const rootPath = preparation.rootPath;
  if (request.build) {
    const buildRefusal = await runBuild(rootPath, request.build, timeoutMs, options.allowedBuildCommands ?? PREVIEW_EXECUTION_POLICY.buildPolicy.allowlistedCommands, options.spawnProcess ?? spawn);
    if (buildRefusal) {
      await disposePreviewRoot(rootPath);
      return refused(buildRefusal);
    }
  }
  const sessionId = randomBytes(24).toString('base64url');
  const route = `/${sessionId}`;
  const renderedHtml = request.renderedHtml ?? (request.build ? await readFile(join(rootPath, 'preview.html'), 'utf8').catch(() => undefined) : undefined);
  if (!renderedHtml && request.build) {
    await disposePreviewRoot(rootPath);
    return refused({ code: 'build-failed', message: "The allowlisted preview build did not emit 'preview.html'." });
  }
  const innerDocument = renderedHtml ?? `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"></head><body><pre>Prepared ${preparation.entryPoint}</pre></body></html>`;
  const host = '127.0.0.1' as const;
  let lifecycle: PreviewSessionStatus = 'running';
  let server!: Server;
  let child: ChildProcess | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolvePromise) => { resolveClosed = resolvePromise; });
  const close = async (reason: PreviewSessionStatus = 'stopped'): Promise<{ status: PreviewSessionStatus; sessionId: string; refusal?: PreviewRefusal }> => {
    if (lifecycle !== 'running') return { status: lifecycle, sessionId };
    lifecycle = reason;
    child?.kill('SIGKILL');
    const serverError = await new Promise<Error | undefined>((resolveClose) => server.close((error) => resolveClose(error)));
    const cleanup = await disposePreviewRoot(rootPath);
    if (serverError || !cleanup.removed) {
      lifecycle = 'cleanup-failed';
      const error = serverError?.message ?? cleanup.error ?? 'Preview cleanup failed.';
      resolveClosed();
      return { status: lifecycle, sessionId, refusal: { code: 'cleanup-failed', message: error } };
    }
    resolveClosed();
    return { status: lifecycle, sessionId };
  };
  const timer = setTimeout(() => { void close('timed-out'); }, timeoutMs);
  const handler = async (requestUrl: URL, response: import('node:http').ServerResponse): Promise<void> => {
    const path = requestUrl.pathname.slice(route.length) || '/';
    if (!requestUrl.pathname.startsWith(`${route}/`) && requestUrl.pathname !== route) { response.writeHead(404); response.end(); return; }
    if (path === '/' || path === '/index.html') {
      const body = previewDocument(`${route}/content`);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...previewContentHeaders() });
      response.end(body); return;
    }
    if (path === '/content') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...previewContentHeaders() });
      response.end(innerDocument); return;
    }
    response.writeHead(404); response.end();
  };
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server = createServer((request, response) => { void handler(new URL(request.url ?? '/', `http://${host}`), response); });
      server.once('error', rejectListen);
      server.listen(0, host, () => resolveListen());
    });
  } catch (error) {
    clearTimeout(timer);
    await disposePreviewRoot(rootPath);
    return refused({ code: 'build-failed', message: error instanceof Error ? error.message : String(error) });
  }
  const address = server.address();
  if (!address || typeof address === 'string') {
    clearTimeout(timer); await disposePreviewRoot(rootPath); return refused({ code: 'build-failed', message: 'Preview server did not receive an ephemeral port.' });
  }
  const port = address.port;
  return { schemaVersion: '1', status: lifecycle, sessionId, host, port, url: `http://${host}:${port}${route}/`, rootPath, csp: PREVIEW_CSP, getStatus: () => lifecycle, close: async () => { clearTimeout(timer); return close(); }, waitForClose: () => closed };
}

export { PREVIEW_CSP } from './sandbox.js';
