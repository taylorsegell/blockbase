import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parseSourceEnvelope, stableStringify } from '@blockbase/contracts';
import { AdapterError } from './errors.js';
import type { AdapterExecutionOptions, AdapterExecutionResult, AdapterManifest, AdapterRequest } from './types.js';

const PROTOCOL_VERSION = '1' as const;

function parseManifest(value: unknown): AdapterManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdapterError('ADAPTER_INVALID_MANIFEST', 'Adapter manifest must be an object.');
  const item = value as Record<string, unknown>;
  const capabilities = item.capabilities as Record<string, unknown> | undefined;
  if (item.schemaVersion !== PROTOCOL_VERSION || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.version !== 'string' || !capabilities || !['none', 'fetch'].includes(String(capabilities.network))) throw new AdapterError('ADAPTER_INVALID_MANIFEST', 'Adapter manifest must declare schemaVersion, id, name, version, and network capability.');
  return { schemaVersion: PROTOCOL_VERSION, id: item.id, name: item.name, version: item.version, capabilities: { network: capabilities.network as 'none' | 'fetch' } };
}

export async function readAdapterManifest(path: string): Promise<AdapterManifest> {
  try { return parseManifest(JSON.parse(await readFile(resolve(path), 'utf8'))); } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError('ADAPTER_INVALID_MANIFEST', `Adapter manifest could not be read: ${error instanceof Error ? error.message : String(error)}`, { path: resolve(path) });
  }
}

function assertRequest(request: AdapterRequest, adapter: AdapterManifest): 'none' | 'fetch' {
  if (request.schemaVersion !== PROTOCOL_VERSION || request.operation !== 'acquire' || typeof request.locator !== 'string' || !request.locator) throw new AdapterError('ADAPTER_INCOMPATIBLE_VERSION', 'Adapter request uses an unsupported protocol version or operation.');
  if (request.fetch === true && adapter.capabilities.network !== 'fetch') throw new AdapterError('ADAPTER_NETWORK_DENIED', 'Network access requires an adapter manifest with fetch capability.');
  if (request.allowRoot) {
    const root = resolve(request.allowRoot);
    const target = resolve(request.locator);
    const path = relative(root, target);
    if (!(path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)))) throw new AdapterError('ADAPTER_PATH_ESCAPE', 'Adapter locator must remain inside the declared allow root.', { locator: target, allowRoot: root });
  }
  return request.fetch === true ? 'fetch' : 'none';
}

export async function executeSourceAdapter(options: AdapterExecutionOptions): Promise<AdapterExecutionResult> {
  const adapter = await readAdapterManifest(options.manifestPath);
  const network = assertRequest(options.request, adapter);
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 10_000, 120_000));
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(options.command, options.args ?? [], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', BLOCKBASE_ADAPTER_NETWORK: network } });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: AdapterError, result?: AdapterExecutionResult) => { if (settled) return; settled = true; clearTimeout(timer); error ? rejectResult(error) : resolveResult(result!); };
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => finish(new AdapterError('ADAPTER_EXIT_FAILED', error.message)));
    child.once('exit', (code, signal) => {
      if (code !== 0) return finish(new AdapterError('ADAPTER_EXIT_FAILED', `Adapter exited unsuccessfully (${signal ?? code}).`, { code, signal, stderr: stderr.slice(0, 2048) }));
      try { finish(undefined, { schemaVersion: PROTOCOL_VERSION, adapter: { id: adapter.id, version: adapter.version }, envelope: parseSourceEnvelope(JSON.parse(stdout)), network }); }
      catch (error) { finish(new AdapterError('ADAPTER_MALFORMED_OUTPUT', `Adapter did not emit one schema-valid SourceEnvelope: ${error instanceof Error ? error.message : String(error)}`, { stderr: stderr.slice(0, 2048) })); }
    });
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new AdapterError('ADAPTER_TIMEOUT', `Adapter exceeded the ${timeoutMs}ms timeout.`, { timeoutMs })); }, timeoutMs);
    child.stdin.end(stableStringify(options.request));
  });
}
