// Copies the agent files the CLI needs at runtime into packages/cli/payload so an npm install
// works without the monorepo checkout. src/paths.ts prefers the checkout and falls back to this.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(cliRoot, '..', '..', 'integrations', 'agent');
const payload = join(cliRoot, 'payload');

if (!existsSync(join(source, 'generate.mjs'))) {
  console.error(`copy-agent-payload: ${source} not found; run from the Blockbase checkout.`);
  process.exit(1);
}

rmSync(payload, { recursive: true, force: true });
mkdirSync(payload, { recursive: true });

// Generated provider packages (claude-code, codex, cursor).
cpSync(join(source, 'generated'), join(payload, 'generated'), { recursive: true });

// Canonical skill tree used by `blockbase agent link`: everything except tests, generator output and harness.
const skip = new Set(['generated', 'harness', 'cutover-dry-run.mjs', 'generate.mjs']);
mkdirSync(join(payload, 'agent'), { recursive: true });
for (const name of readdirSync(source)) {
  if (skip.has(name) || name.endsWith('.test.mjs')) continue;
  cpSync(join(source, name), join(payload, 'agent', name), { recursive: true });
}
console.log(`copy-agent-payload: wrote ${payload}`);
