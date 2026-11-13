import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_CODES, type OperationName } from '@blockbase/contracts';
import { canonicalAgentRoot } from './paths.js';
import { OPERATION_REGISTRY, type OperationDefinition } from './registry.js';

/**
 * `blockbase --help` and `blockbase help [command]`. The overview comes from the
 * operation registry; a command's manual is the same reference page the agent
 * skills load, so people and agents read one contract.
 */

type HelpEntry = { command: string; description: string; operation?: OperationName };

const GROUPS: Array<{ title: string; matches: (operation: string) => boolean }> = [
  { title: 'Capture', matches: (operation) => operation === 'import' || operation.startsWith('inbox.') },
  { title: 'Find and fit', matches: (operation) => ['search', 'inspect', 'project.inspect', 'adapt', 'add', 'validate'].includes(operation) },
  { title: 'Organize', matches: (operation) => /^(tag|collection|family)\./.test(operation) },
  { title: 'History', matches: (operation) => operation.startsWith('history.') },
  { title: 'Catalog health', matches: (operation) => operation === 'doctor' || operation.startsWith('catalog.') },
  { title: 'Catalog page', matches: (operation) => operation === 'setup' || operation === 'ui' || operation.startsWith('ui.') },
  { title: 'Agents', matches: (operation) => operation.startsWith('agent.') },
];

// Commands outside the operation registry: they emit their own envelopes or run a server.
const EXTRA: Array<{ group: string; entry: HelpEntry }> = [
  { group: 'Themes', entry: { command: 'theme init <name>', description: 'Write a starter theme manifest.' } },
  { group: 'Themes', entry: { command: 'theme validate <path>', description: 'Validate a theme manifest.' } },
  { group: 'Themes', entry: { command: 'theme add <path>', description: 'Register a theme in the catalog as an immutable revision.' } },
  { group: 'Themes', entry: { command: 'theme derive --project <path>', description: 'Draft a theme from a project\'s tokens.' } },
  { group: 'Agents', entry: { command: 'mcp', description: 'Serve the read-only catalog MCP tools over stdio (or --transport http with BLOCKBASE_MCP_TOKEN).' } },
];

/** The literal words of a registry command, e.g. `history restore <component>` → ['history', 'restore']. */
function words(command: string): string[] {
  const result: string[] = [];
  for (const token of command.split(/\s+/)) {
    if (/^[<[(-]/.test(token)) break;
    result.push(token);
  }
  return result;
}

export function isHelpRequest(argv: string[]): boolean {
  return argv[0] === 'help' || argv.includes('--help') || argv.includes('-h');
}

function argumentHints(): Record<string, string> {
  try {
    const metadata = JSON.parse(readFileSync(join(canonicalAgentRoot(), 'command-metadata.json'), 'utf8')) as Record<string, { argumentHint?: string }>;
    return Object.fromEntries(Object.entries(metadata).map(([command, entry]) => [command, entry.argumentHint ?? '']));
  } catch {
    return {};
  }
}

function wrap(text: string): string {
  const width = Math.max(40, Math.min(process.stdout.columns || 80, 100));
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

// The reference pages double as agent instructions; this guardrail is for agents, not people at a terminal.
const AGENT_ONLY = /confirm with the user/i;

/** Turns a reference page into terminal text: no title (the usage line replaces it), indented examples, and no agent-only sentences. */
function manualBody(markdown: string): string {
  const blocks: string[] = [];
  let prose: string[] = [];
  const flush = () => {
    const text = prose.join(' ').replace(/`([^`]+)`/g, '$1').trim();
    prose = [];
    const kept = text.split(/(?<=[.:])\s+(?=[A-Z])/).filter((sentence) => !AGENT_ONLY.test(sentence)).join(' ');
    if (kept) blocks.push(wrap(kept));
  };
  let code: string[] | undefined;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) {
      if (code) {
        blocks.push(code.join('\n'));
        code = undefined;
      } else {
        flush();
        code = [];
      }
    } else if (code) code.push(`  ${line}`);
    else if (line.startsWith('# ')) continue;
    else if (line.trim() === '') flush();
    else prose.push(line.trim());
  }
  flush();
  return `${blocks.join('\n\n')}\n`;
}

function table(entries: HelpEntry[], width = Math.max(...entries.map((entry) => entry.command.length))): string {
  return entries.map((entry) => `  ${entry.command.padEnd(width)}  ${entry.description}`).join('\n');
}

function overview(): string {
  const sections = GROUPS.map((group) => ({
    title: group.title,
    entries: [
      ...OPERATION_REGISTRY.filter((entry) => group.matches(entry.operation)).map(({ command, description, operation }) => ({ command, description, operation })),
      ...EXTRA.filter((extra) => extra.group === group.title).map((extra) => extra.entry),
    ],
  }));
  sections.splice(sections.length - 1, 0, { title: 'Themes', entries: EXTRA.filter((extra) => extra.group === 'Themes').map((extra) => extra.entry) });
  const width = Math.max(...sections.flatMap((section) => section.entries.map((entry) => entry.command.length)));
  const exitCodes = Object.entries(EXIT_CODES).map(([name, code]) => `${code} ${name}`).join(', ');
  return [
    'blockbase: a local catalog of UI components you can import, organize, and adapt into projects.',
    '',
    'Usage: blockbase <command> [options]',
    '       blockbase help <command>    the manual for one command (or: blockbase <command> --help)',
    '',
    ...sections.filter((section) => section.entries.length > 0).flatMap((section) => [section.title, table(section.entries, width), '']),
    'Common options',
    table([
      { command: '--json', description: 'Print one JSON envelope on stdout; diagnostics go to stderr.' },
      { command: '--catalog <path>', description: 'Use this catalog instead of BLOCKBASE_HOME or ~/.blocks.' },
    ], width),
    '',
    'Environment',
    table([
      { command: 'BLOCKBASE_HOME', description: 'Catalog directory (default ~/.blocks).' },
      { command: 'BLOCKBASE_HISTORY=off', description: 'Stop recording catalog changes in the catalog\'s git history.' },
      { command: 'BLOCKBASE_ACTOR', description: 'Who is making changes, recorded on each history entry (default cli).' },
      { command: 'BLOCKBASE_REMOTE_URL', description: 'Search, inspect, adapt, and add against a remote catalog (needs BLOCKBASE_MCP_TOKEN).' },
    ], width),
    '',
    `Exit codes: ${exitCodes}.`,
    '',
  ].join('\n');
}

function findEntry(tokens: string[]): OperationDefinition | undefined {
  let best: OperationDefinition | undefined;
  let bestLength = 0;
  for (const entry of OPERATION_REGISTRY) {
    const literal = words(entry.command);
    if (literal.length > bestLength && literal.every((word, index) => tokens[index] === word)) {
      best = entry;
      bestLength = literal.length;
    }
  }
  return best;
}

function manual(entry: OperationDefinition): string {
  const literal = words(entry.command);
  const hint = argumentHints()[entry.command] ?? '';
  const page = join(canonicalAgentRoot(), 'references', 'commands', `${literal.join('-')}.md`);
  const body = existsSync(page) ? manualBody(readFileSync(page, 'utf8')) : `${entry.description}\n`;
  return [`Usage: blockbase ${entry.command}${hint ? ` ${hint}` : ''}`, '', body].join('\n');
}

/** Renders help for `argv`; `ok` is false for an unknown command so the caller can exit with the usage code. */
export function renderHelp(argv: string[]): { ok: boolean; text: string } {
  const tokens = argv.filter((token) => token !== 'help' && !token.startsWith('-'));
  if (tokens.length === 0) return { ok: true, text: overview() };
  const entry = findEntry(tokens);
  if (entry) return { ok: true, text: manual(entry) };
  const group = [...OPERATION_REGISTRY.map(({ command, description }) => ({ command, description })), ...EXTRA.map((extra) => extra.entry)].filter((candidate) => words(candidate.command)[0] === tokens[0]);
  if (group.length > 0) return { ok: true, text: [`Usage: blockbase ${tokens[0]} <command> [options]`, '', table(group), '', `Run blockbase help ${tokens[0]} <command> for the manual.`, ''].join('\n') };
  return { ok: false, text: `Unknown command '${tokens.join(' ')}'.\n\n${overview()}` };
}
