import { IMPORT_ERROR_CODES, ImportError } from './errors.js';
import { assertSafeRelativePath } from './local.js';

/** Pure reader for what 21st.dev hands people when they copy a component. No file or network access. */

export type TwentyFirstFormat = 'filename-fences' | 'markers' | 'bare-code';
export type TwentyFirstFileRole = 'component' | 'demo' | 'other';

export type TwentyFirstFile = { path: string; content: string; role: TwentyFirstFileRole };
export type TwentyFirstPackage = { name: string; range: string };
export type TwentyFirstSuspicionReason =
  | 'unbalanced-brackets'
  | 'truncated-tail'
  | 'placeholder-ellipsis'
  | 'replacement-character'
  | 'unterminated-fence'
  | 'stray-text'
  | 'duplicate-filename'
  | 'duplicate-demo'
  | 'unnamed-file';
export type TwentyFirstSuspicion = { file: string; reason: TwentyFirstSuspicionReason; line?: number };

export type TwentyFirstReading = {
  format: TwentyFirstFormat;
  hasFilenames: boolean;
  /** Every pasted file, the demo included; importPaste separates the demo from the block. */
  files: TwentyFirstFile[];
  entryPoint: string;
  installPackages: TwentyFirstPackage[];
  importPackages: string[];
  aliasImports: string[];
  authorHint?: string;
  suspicions: TwentyFirstSuspicion[];
  normalizations: string[];
};

export const TWENTYFIRST_MAX_PASTE_BYTES = 5 * 1024 * 1024;
export const TWENTYFIRST_PLACEHOLDER_COMPONENT = 'component.tsx';
export const TWENTYFIRST_PLACEHOLDER_DEMO = 'demo.tsx';

// Fences follow CommonMark: up to three spaces of indent, a run of three or more backticks or tildes, and for
// backtick fences an info string without backticks. A fence closes on the same character, a run at least as long,
// and nothing else but whitespace.
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const FILENAME_LINE = /^[\w.-]+\.(tsx?|jsx?|css)$/;
const PATH_SEGMENT = /^[\w@.-]+$/;
const COMPONENT_MARKER = '// --- Component ---';
const DEMO_MARKER = '// --- Demo ---';
const MARKER_LIKE = /^\/\/\s*-{2,}\s*(component|demo)\s*-*\s*$/i;
const INSTALL_HEADING = /install npm dependencies/i;
const INSTALL_PREFIXES = ['npm install ', 'npm i ', 'pnpm add ', 'yarn add ', 'bun add '];
const PACKAGE_SPEC = /^(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*|[a-z0-9][\w.-]*)(?:@(\S+))?$/i;
const AUTHOR_HINTS = [/^\s*\/\/\s*Built using\s+(.+?)\s*$/i, /^\s*\/\/\s*by\s+(.+?)\s*$/i];
const CODE_HINT = /\bimport\b|\bexport\b|<[A-Za-z]/;
const EXPORT_HINT = /\bexport\b/;
const DEMO_HINT = /\bexport\s+default\s+function\s+Demo\b/;
const SKIPPED_SPECIFIER_PREFIXES = ['.', '/', '@/', '~/', '#', 'node:'];
const FRAMEWORK_PACKAGES = new Set(['react', 'react-dom']);
const PLACEHOLDER_WORDS = /rest of the (code|file|component)|omitted|truncated|unchanged/i;
// Characters a clipboard or chat client slips into a line. They only matter when a line is read as structure.
const INVISIBLE = /[​‌‍⁠﻿]/g;
const NBSP = / /g;

/** `raw` is the pasted bytes, `text` drops a trailing CR, `shape` and `key` are cleaned copies used only for structure. */
type Line = { raw: string; text: string; shape: string; key: string };
type Fence = { lines: Line[]; install: boolean; closed: boolean };
type Segment = { path: string; lines: Line[]; demoMarker: boolean };
type Notes = { normalizations: string[]; suspicions: TwentyFirstSuspicion[] };

function unreadable(reasons: string[]): never {
  const damaged = reasons.filter((reason) => reason.startsWith('damaged:'));
  const rest = reasons.filter((reason) => !reason.startsWith('damaged:'));
  const ordered = [...new Set([...damaged, ...rest])];
  throw new ImportError(IMPORT_ERROR_CODES.pasteUnreadable, 'The paste could not be read as a 21st.dev paste.', { reasons: ordered });
}

const isBlank = (line: Line): boolean => line.key === '';

function splitLines(text: string): Line[] {
  return text.split('\n').map((raw) => {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const shape = text.replace(INVISIBLE, '').replace(NBSP, ' ').trimEnd();
    return { raw, text, shape, key: shape.trim() };
  });
}

/** Drop surrounding blank lines and keep exactly one final newline; every other byte stays as pasted. */
function fileContent(path: string, lines: Line[], normalizations: string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlank(lines[start]!)) start += 1;
  while (end > start && isBlank(lines[end - 1]!)) end -= 1;
  if (start > 0 || end < lines.length) normalizations.push(`trimmed-blank-lines:${path}`);
  const kept = lines.slice(start, end);
  if (kept.length === 0) return '';
  const last = kept[kept.length - 1]!;
  const lineEnd = last.raw.endsWith('\r') ? '\r\n' : '\n';
  return kept.map((line) => line.raw).join('\n').replace(/\r$/, '') + lineEnd;
}

/** A fence still open at the end of the paste is closed there and marked so the reader can report it. */
function scanFences(lines: Line[]): Fence[] {
  const fences: Fence[] = [];
  let current: Fence | undefined;
  let char = '';
  let size = 0;
  let lastOutside = '';
  for (const line of lines) {
    if (current) {
      const close = FENCE_CLOSE.exec(line.shape);
      if (close && close[1]![0] === char && close[1]!.length >= size) {
        fences.push(current);
        current = undefined;
      } else {
        current.lines.push(line);
      }
      continue;
    }
    const open = FENCE_OPEN.exec(line.shape);
    if (open && !(open[1]![0] === '`' && open[2]!.includes('`'))) {
      current = { lines: [], install: INSTALL_HEADING.test(lastOutside), closed: true };
      char = open[1]![0]!;
      size = open[1]!.length;
      continue;
    }
    if (line.key !== '') lastOutside = line.key;
  }
  if (current) {
    current.closed = false;
    fences.push(current);
  }
  return fences;
}

/** Package specs on one install line, with the install command and any `-D` style options removed. */
function installSpecs(value: string): { specs: string[]; prefixed: boolean } {
  const prefix = INSTALL_PREFIXES.find((item) => value.startsWith(item));
  const rest = prefix ? value.slice(prefix.length) : value;
  return { specs: rest.split(/\s+/).filter((item) => item !== '' && !item.startsWith('-')), prefixed: Boolean(prefix) };
}

/** A fence with no heading is an install list when every line is an install command or a package spec and at least one is clearly one. */
function looksLikeInstall(fence: Fence): boolean {
  const values = fence.lines.map((line) => line.key).filter((value) => value !== '');
  if (values.length === 0) return false;
  let clear = false;
  for (const value of values) {
    if (FILENAME_LINE.test(value) || CODE_HINT.test(value)) return false;
    const { specs, prefixed } = installSpecs(value);
    if (specs.length === 0 || !specs.every((spec) => PACKAGE_SPEC.test(spec))) return false;
    if (prefixed || specs.some((spec) => spec.startsWith('@') || /.@/.test(spec))) clear = true;
  }
  return clear;
}

function installPackagesFrom(fences: Fence[]): TwentyFirstPackage[] {
  const packages = new Map<string, string>();
  for (const fence of fences.filter((item) => item.install)) {
    for (const line of fence.lines) {
      for (const spec of installSpecs(line.key).specs) {
        const match = PACKAGE_SPEC.exec(spec);
        if (match && !packages.has(match[1]!)) packages.set(match[1]!, match[2] ?? '*');
      }
    }
  }
  return [...packages].map(([name, range]) => ({ name, range }));
}

type FoundName = { name: string; decorated: boolean; prefixed: boolean };

/**
 * A filename line. Plain names count anywhere. Decorated names (`// a.tsx`, `**a.tsx**`, a backtick-wrapped name,
 * a trailing colon) only count at a fence start or after a blank line, so a comment inside code is never split on.
 * A path prefix keeps only the basename, and any `..` or `.` segment, leading slash or backslash keeps the line as content.
 */
function filenameOf(key: string, boundary: boolean): FoundName | undefined {
  if (FILENAME_LINE.test(key)) return { name: key, decorated: false, prefixed: false };
  let value = key;
  if (boundary) {
    value = value.replace(/^\/\/\s*/, '').replace(/:$/, '').trim();
    const wrapped = /^(\*\*|`)(.+)\1$/.exec(value);
    if (wrapped) value = wrapped[2]!.replace(/:$/, '').trim();
  }
  const decorated = value !== key;
  if (value.includes('\\')) return undefined;
  const parts = value.split('/');
  const name = parts.pop()!;
  if (!FILENAME_LINE.test(name)) return undefined;
  if (!parts.every((part) => PATH_SEGMENT.test(part) && part !== '.' && part !== '..')) return undefined;
  if (!decorated && parts.length === 0) return undefined;
  return { name, decorated, prefixed: parts.length > 0 };
}

function fenceHasFilename(fence: Fence): boolean {
  let boundary = true;
  for (const line of fence.lines) {
    if (line.key !== '' && filenameOf(line.key, boundary)) return true;
    boundary = line.key === '';
  }
  return false;
}

function markerOf(key: string): { kind: 'component' | 'demo'; loose: boolean } | undefined {
  if (key === COMPONENT_MARKER) return { kind: 'component', loose: false };
  if (key === DEMO_MARKER) return { kind: 'demo', loose: false };
  const match = MARKER_LIKE.exec(key);
  return match ? { kind: match[1]!.toLowerCase() as 'component' | 'demo', loose: true } : undefined;
}

const hasMarker = (lines: Line[]): boolean => lines.some((line) => markerOf(line.key));
const exportsSomething = (fence: Fence): boolean => fence.lines.some((line) => EXPORT_HINT.test(line.text));

/** Text before the first file is dropped when it is prose, and kept on the first file with a suspicion when it looks like code. */
function attachStray(before: Line[], segment: Segment, notes: Notes): void {
  if (!before.some((line) => !isBlank(line))) return;
  if (!before.some((line) => CODE_HINT.test(line.text))) {
    notes.normalizations.push('dropped-stray-text');
    return;
  }
  segment.lines.unshift(...before);
  notes.suspicions.push({ file: segment.path, reason: 'stray-text', line: 1 });
}

function suffixed(path: string, count: number): string {
  const dot = path.lastIndexOf('.');
  return `${path.slice(0, dot)}-${count}${path.slice(dot)}`;
}

function filenameSegments(fences: Fence[], notes: Notes): Segment[] {
  const segments: Segment[] = [];
  const seen = new Map<string, number>();
  for (const fence of fences) {
    let current: Segment | undefined;
    let boundary = true;
    const before: Line[] = [];
    for (const line of fence.lines) {
      const found = line.key !== '' ? filenameOf(line.key, boundary) : undefined;
      boundary = line.key === '';
      if (!found) {
        (current ? current.lines : before).push(line);
        continue;
      }
      if (found.decorated) notes.normalizations.push(`decorated-filename:${found.name}`);
      if (found.prefixed) notes.normalizations.push(`dropped-path-prefix:${found.name}`);
      const count = (seen.get(found.name) ?? 0) + 1;
      seen.set(found.name, count);
      const path = count === 1 ? found.name : suffixed(found.name, count);
      if (count > 1) notes.suspicions.push({ file: path, reason: 'duplicate-filename' });
      current = { path, lines: [], demoMarker: false };
      segments.push(current);
      if (before.length > 0) {
        attachStray(before, current, notes);
        before.length = 0;
      }
    }
  }
  return segments;
}

function markerSegments(lines: Line[], notes: Notes): Segment[] {
  const segments: Segment[] = [];
  let current: Segment | undefined;
  const before: Line[] = [];
  let components = 0;
  let demos = 0;
  for (const line of lines) {
    const marker = markerOf(line.key);
    if (!marker) {
      (current ? current.lines : before).push(line);
      continue;
    }
    if (marker.loose) notes.normalizations.push('loose-marker');
    const first = segments.length === 0;
    if (marker.kind === 'demo' && first && before.some((item) => CODE_HINT.test(item.text))) {
      // A demo marker with code above it and no component marker: the code above is the component.
      components += 1;
      segments.push({ path: TWENTYFIRST_PLACEHOLDER_COMPONENT, lines: [...before], demoMarker: false });
      notes.normalizations.push('unmarked-component');
      before.length = 0;
    }
    if (marker.kind === 'demo') {
      demos += 1;
      current = { path: demos === 1 ? TWENTYFIRST_PLACEHOLDER_DEMO : suffixed(TWENTYFIRST_PLACEHOLDER_DEMO, demos), lines: [], demoMarker: demos === 1 };
      if (demos > 1) notes.suspicions.push({ file: current.path, reason: 'duplicate-demo' });
    } else {
      components += 1;
      current = { path: components === 1 ? TWENTYFIRST_PLACEHOLDER_COMPONENT : suffixed(TWENTYFIRST_PLACEHOLDER_COMPONENT, components), lines: [], demoMarker: false };
      if (components > 1) notes.suspicions.push({ file: current.path, reason: 'unnamed-file' });
    }
    segments.push(current);
    if (before.length > 0) {
      attachStray(before, current, notes);
      before.length = 0;
    }
  }
  return segments;
}

/**
 * Bare fences with no names or markers. One fence is the component. With more, the fence holding
 * `export default function Demo` is the demo (or the second of exactly two), the first other fence is the
 * component, and any further fences are kept as component-2.tsx and so on with an `unnamed-file` suspicion.
 */
function bareSegments(fences: Fence[], notes: Notes): Segment[] {
  if (fences.length === 1) return [{ path: TWENTYFIRST_PLACEHOLDER_COMPONENT, lines: fences[0]!.lines, demoMarker: false }];
  let demoIndex = fences.findIndex((fence) => fence.lines.some((line) => DEMO_HINT.test(line.text)));
  if (demoIndex === -1 && fences.length === 2) demoIndex = 1;
  if (demoIndex !== -1) notes.normalizations.push('guessed-demo-fence');
  const segments: Segment[] = [];
  let count = 0;
  fences.forEach((fence, index) => {
    if (index === demoIndex) {
      segments.push({ path: TWENTYFIRST_PLACEHOLDER_DEMO, lines: fence.lines, demoMarker: true });
      return;
    }
    count += 1;
    const path = count === 1 ? TWENTYFIRST_PLACEHOLDER_COMPONENT : suffixed(TWENTYFIRST_PLACEHOLDER_COMPONENT, count);
    if (count > 1) notes.suspicions.push({ file: path, reason: 'unnamed-file' });
    segments.push({ path, lines: fence.lines, demoMarker: false });
  });
  return segments;
}

function packageName(specifier: string): string | undefined {
  if (SKIPPED_SPECIFIER_PREFIXES.some((prefix) => specifier.startsWith(prefix))) return undefined;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  return name && !FRAMEWORK_PACKAGES.has(name) ? name : undefined;
}

/** Static import specifiers, read line by line so a multi-line import is followed to its `from`. */
function staticImportSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  let inImport = false;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!inImport) {
      if (!/^import\b/.test(line) || /^import\s*\(/.test(line)) continue;
      const bare = /^import\s*(['"])([^'"]+)\1/.exec(line);
      if (bare) {
        specifiers.push(bare[2]!);
        continue;
      }
      inImport = true;
    }
    const from = /\bfrom\s*(['"])([^'"]+)\1/.exec(line);
    if (from) {
      specifiers.push(from[2]!);
      inImport = false;
    } else if (line.endsWith(';')) {
      inImport = false;
    }
  }
  return specifiers;
}

/** Net bracket balance after skipping comments, strings that close on their own line, and template literals. */
function bracketsBalanced(content: string): boolean {
  const counts = { '{': 0, '(': 0, '[': 0 };
  const closers: Record<string, keyof typeof counts> = { '}': '{', ')': '(', ']': '[' };
  // Stack frames: 'template' while inside a template literal, or a number (brace depth) inside `${ ... }`.
  const stack: Array<'template' | number> = [];
  let index = 0;
  const length = content.length;
  while (index < length) {
    const top = stack[stack.length - 1];
    const char = content[index]!;
    if (top === 'template') {
      if (char === '\\') index += 2;
      else if (char === '`') { stack.pop(); index += 1; }
      else if (char === '$' && content[index + 1] === '{') { stack.push(0); index += 2; }
      else index += 1;
      continue;
    }
    if (char === '/' && content[index + 1] === '/') {
      const end = content.indexOf('\n', index);
      index = end === -1 ? length : end;
      continue;
    }
    if (char === '/' && content[index + 1] === '*') {
      const end = content.indexOf('*/', index + 2);
      index = end === -1 ? length : end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      let cursor = index + 1;
      while (cursor < length && content[cursor] !== '\n' && content[cursor] !== char) cursor += content[cursor] === '\\' ? 2 : 1;
      index = cursor < length && content[cursor] === char ? cursor + 1 : index + 1;
      continue;
    }
    if (char === '`') { stack.push('template'); index += 1; continue; }
    if (typeof top === 'number') {
      if (char === '{') stack[stack.length - 1] = top + 1;
      else if (char === '}') {
        if (top === 0) { stack.pop(); index += 1; continue; }
        stack[stack.length - 1] = top - 1;
      }
    }
    if (char in counts) counts[char as keyof typeof counts] += 1;
    else if (char in closers) counts[closers[char]!] -= 1;
    index += 1;
  }
  return stack.length === 0 && counts['{'] === 0 && counts['('] === 0 && counts['['] === 0;
}

function suspicionsFor(file: TwentyFirstFile): TwentyFirstSuspicion[] {
  const found: TwentyFirstSuspicion[] = [];
  const lines = file.content.split('\n').map((line) => line.replace(/\r$/, ''));
  const script = /\.(tsx?|jsx?)$/.test(file.path);
  const css = file.path.endsWith('.css');
  if (!bracketsBalanced(file.content)) found.push({ file: file.path, reason: 'unbalanced-brackets' });
  let lastIndex = lines.length - 1;
  while (lastIndex >= 0 && lines[lastIndex]!.trim() === '') lastIndex -= 1;
  if (lastIndex >= 0 && (script || css)) {
    const last = lines[lastIndex]!.trimEnd();
    const endings = script ? ['}', ';', ')', '>', ']', '*/'] : ['}', '*/'];
    if (!endings.some((ending) => last.endsWith(ending))) found.push({ file: file.path, reason: 'truncated-tail', line: lastIndex + 1 });
  }
  lines.forEach((raw, position) => {
    if (raw.includes('\uFFFD')) found.push({ file: file.path, reason: 'replacement-character', line: position + 1 });
    const line = raw.trim();
    if (line === '...' || line === '…') {
      found.push({ file: file.path, reason: 'placeholder-ellipsis', line: position + 1 });
      return;
    }
    const comment = /^(?:\/\/|\/\*|\{\/\*)\s*(.*)$/.exec(line);
    if (comment && (/^(\.\.\.|…)/.test(comment[1]!) || PLACEHOLDER_WORDS.test(comment[1]!))) {
      found.push({ file: file.path, reason: 'placeholder-ellipsis', line: position + 1 });
    }
  });
  return found;
}

function authorHintFrom(files: TwentyFirstFile[]): string | undefined {
  for (const file of files) {
    for (const raw of file.content.split('\n')) {
      const line = raw.replace(/\r$/, '');
      for (const pattern of AUTHOR_HINTS) {
        const match = pattern.exec(line);
        if (match) return match[1];
      }
    }
  }
  return undefined;
}

export function parseTwentyFirstPaste(text: string): TwentyFirstReading {
  if (typeof text !== 'string') unreadable(['format:no-code-found']);
  if (Buffer.byteLength(text, 'utf8') > TWENTYFIRST_MAX_PASTE_BYTES) unreadable(['format:too-large']);
  if (text.replace(INVISIBLE, '').replace(NBSP, ' ').trim() === '') unreadable(['damaged:empty']);
  const notes: Notes = { normalizations: [], suspicions: [] };
  let body = text;
  if (body.startsWith('﻿')) {
    body = body.slice(1);
    notes.normalizations.push('stripped-bom');
  }

  const lines = splitLines(body);
  const fences = scanFences(lines);
  for (const fence of fences) {
    if (!fence.install && looksLikeInstall(fence)) fence.install = true;
  }
  const installPackages = installPackagesFrom(fences);
  let codeFences = fences.filter((fence) => !fence.install && fence.lines.some((line) => !isBlank(line)));
  // A fence with no export next to fences that do export is a prose example, not a file.
  if (codeFences.some(exportsSomething)) {
    const kept = codeFences.filter((fence) => exportsSomething(fence) || fenceHasFilename(fence) || hasMarker(fence.lines));
    if (kept.length < codeFences.length) notes.normalizations.push('dropped-example-fence');
    codeFences = kept;
  }
  const unterminated = fences.some((fence) => !fence.closed && fence.lines.some((line) => !isBlank(line)));

  let segments: Segment[];
  let format: TwentyFirstFormat;
  let hasFilenames = false;
  if (fences.length === 0) {
    if (hasMarker(lines)) {
      format = 'markers';
      segments = markerSegments(lines, notes);
    } else {
      format = 'bare-code';
      if (!CODE_HINT.test(body)) unreadable(['format:no-code-found']);
      segments = [{ path: TWENTYFIRST_PLACEHOLDER_COMPONENT, lines, demoMarker: false }];
    }
  } else if (codeFences.length === 0) {
    unreadable(['format:no-code-found']);
  } else if (codeFences.some(fenceHasFilename)) {
    // Filenames win over markers; a marker line beside filenames stays ordinary content.
    format = 'filename-fences';
    hasFilenames = true;
    segments = filenameSegments(codeFences.filter(fenceHasFilename), notes);
    for (const fence of codeFences.filter((item) => !fenceHasFilename(item))) {
      if (!exportsSomething(fence)) {
        notes.normalizations.push('dropped-example-fence');
        continue;
      }
      const taken = new Set(segments.map((segment) => segment.path));
      let count = 1;
      let path = TWENTYFIRST_PLACEHOLDER_COMPONENT;
      while (taken.has(path)) path = suffixed(TWENTYFIRST_PLACEHOLDER_COMPONENT, ++count);
      notes.suspicions.push({ file: path, reason: 'unnamed-file' });
      segments.push({ path, lines: fence.lines, demoMarker: false });
    }
  } else if (codeFences.some((fence) => hasMarker(fence.lines))) {
    format = 'markers';
    segments = markerSegments(codeFences.flatMap((fence) => fence.lines), notes);
  } else {
    format = 'bare-code';
    segments = bareSegments(codeFences, notes);
  }

  const normalizations = notes.normalizations;
  const files: TwentyFirstFile[] = segments.map((segment) => {
    const path = assertSafeRelativePath(segment.path);
    const demo = segment.demoMarker || /^demo\.(tsx|jsx)$/i.test(path);
    return { path, content: fileContent(path, segment.lines, normalizations), role: demo ? 'demo' : 'other' };
  });
  // The first demo wins; any later demo is kept as an ordinary file.
  for (const extra of files.filter((file) => file.role === 'demo').slice(1)) {
    extra.role = 'other';
    notes.suspicions.push({ file: extra.path, reason: 'duplicate-demo' });
  }
  const component = files.find((file) => file.role !== 'demo' && /\.(tsx|jsx)$/i.test(file.path));
  if (!component) unreadable(['format:no-component']);
  component.role = 'component';
  const last = files[files.length - 1]!;
  if (unterminated) notes.suspicions.push({ file: last.path, reason: 'unterminated-fence', line: last.content.split('\n').length - 1 });

  const importPackages: string[] = [];
  const aliasImports: string[] = [];
  for (const file of files.filter((item) => item.role !== 'demo')) {
    for (const specifier of staticImportSpecifiers(file.content)) {
      if ((specifier.startsWith('@/') || specifier.startsWith('~/')) && !aliasImports.includes(specifier)) aliasImports.push(specifier);
      const name = packageName(specifier);
      if (name && !importPackages.includes(name)) importPackages.push(name);
    }
  }

  const authorHint = authorHintFrom(files);
  return {
    format,
    hasFilenames,
    files,
    entryPoint: component.path,
    installPackages,
    importPackages,
    aliasImports,
    ...(authorHint ? { authorHint } : {}),
    suspicions: [...files.flatMap(suspicionsFor), ...notes.suspicions],
    normalizations: [...new Set(normalizations)],
  };
}
