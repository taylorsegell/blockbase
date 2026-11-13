import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { generatedRoot } from '../paths.js';

export const AGENT_PROVIDERS = ['claude-code', 'codex', 'cursor'] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];
export const AGENT_SCOPES = ['project', 'global'] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export type ProviderSpec = {
  provider: AgentProvider;
  projectDirectory: string;
  globalDirectory: string;
  skillRoot: string;
  executable: string;
  supportsProject: boolean;
  supportsGlobal: boolean;
  mcp: 'optional';
  mcpConfig: string;
};

export const PROVIDERS: Record<AgentProvider, ProviderSpec> = {
  'claude-code': { provider: 'claude-code', projectDirectory: '.claude', globalDirectory: '.claude', skillRoot: 'skills', executable: 'blockbase', supportsProject: true, supportsGlobal: true, mcp: 'optional', mcpConfig: 'mcp.json' },
  codex: { provider: 'codex', projectDirectory: '.codex', globalDirectory: '.codex', skillRoot: 'skills', executable: 'blockbase', supportsProject: true, supportsGlobal: true, mcp: 'optional', mcpConfig: 'mcp.json' },
  cursor: { provider: 'cursor', projectDirectory: '.cursor', globalDirectory: '.cursor', skillRoot: 'skills', executable: 'blockbase', supportsProject: true, supportsGlobal: true, mcp: 'optional', mcpConfig: 'mcp.json' },
};

export function isAgentProvider(value: string | undefined): value is AgentProvider {
  return value !== undefined && (AGENT_PROVIDERS as readonly string[]).includes(value);
}

export function isAgentScope(value: string | undefined): value is AgentScope {
  return value !== undefined && (AGENT_SCOPES as readonly string[]).includes(value);
}

export function generatedProviderRoot(provider: AgentProvider): string {
  return join(generatedRoot(), provider);
}

export function generatedManifest(provider: AgentProvider): { version: string; sourceHash: string } {
  const path = join(generatedProviderRoot(provider), 'manifest.json');
  if (!existsSync(path)) throw new Error(`Generated provider package is missing: ${path}`);
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; sourceHash?: unknown };
  if (typeof manifest.version !== 'string' || typeof manifest.sourceHash !== 'string') throw new Error(`Generated provider manifest is invalid: ${path}`);
  return { version: manifest.version, sourceHash: manifest.sourceHash };
}

export function providerRoot(provider: AgentProvider, scope: AgentScope, options: { home?: string; project?: string }): string {
  if (options.home) return resolve(options.home);
  if (scope === 'project') {
    if (!options.project) throw new Error('Project scope requires --project.');
    return join(resolve(options.project), PROVIDERS[provider].projectDirectory);
  }
  return join(resolve(options.project ?? process.env.HOME ?? process.env.USERPROFILE ?? process.cwd()), PROVIDERS[provider].globalDirectory);
}
