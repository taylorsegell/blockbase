import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where this CLI finds the files it ships. Two layouts are supported:
 *  - checkout: `packages/cli/dist` inside the monorepo, which has `integrations/agent` two levels up;
 *  - installed: an npm package whose `payload/` directory was copied in by scripts/copy-agent-payload.mjs.
 * The checkout wins when it exists so development, tests and drift checks see live files.
 */

/** The CLI package directory (parent of dist/), in both layouts. */
export function cliPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

/** This CLI's own entry point. Used for agent `bin/blockbase` links and the login service program. */
export function cliEntry(): string {
  return join(cliPackageRoot(), 'dist', 'index.js');
}

function checkoutIntegrationRoot(): string | undefined {
  // Both markers are required: an installed package sits in node_modules, where neither the workspace
  // file nor integrations/agent can appear two levels up, whatever directory the user is in.
  const repo = resolve(cliPackageRoot(), '..', '..');
  const candidate = join(repo, 'integrations', 'agent');
  return existsSync(join(repo, 'pnpm-workspace.yaml')) && existsSync(join(candidate, 'generate.mjs')) ? candidate : undefined;
}

export function payloadRoot(): string {
  return join(cliPackageRoot(), 'payload');
}

/** Canonical skill tree (SKILL.md, skills/, references/, ...) that `agent link` points into. */
export function canonicalAgentRoot(): string {
  return checkoutIntegrationRoot() ?? join(payloadRoot(), 'agent');
}

/** Directory holding generated provider packages (`<root>/<provider>/manifest.json`). */
export function generatedRoot(): string {
  const checkout = checkoutIntegrationRoot();
  return checkout ? join(checkout, 'generated') : join(payloadRoot(), 'generated');
}
