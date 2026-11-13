import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { IMPORT_ERROR_CODES, ImportError, parseTwentyFirstPaste } from '../dist/index.js';

const fixture = (name) => readFile(resolve(import.meta.dirname, 'fixtures/twentyfirst', name), 'utf8');

function unreadable(text) {
  try {
    parseTwentyFirstPaste(text);
  } catch (error) {
    assert.ok(error instanceof ImportError, 'expected an ImportError');
    assert.equal(error.code, IMPORT_ERROR_CODES.pasteUnreadable);
    assert.ok(Array.isArray(error.details.reasons));
    return error.details.reasons;
  }
  assert.fail('expected IMPORT_PASTE_UNREADABLE');
}

const byRole = (reading, role) => reading.files.filter((file) => file.role === role);

test('current-format paste yields component and demo as separate files', async () => {
  const reading = parseTwentyFirstPaste(await fixture('current-format.txt'));
  assert.equal(reading.format, 'filename-fences');
  assert.equal(reading.hasFilenames, true);
  assert.deepEqual(reading.files.map((file) => [file.path, file.role]), [['skyline-card.tsx', 'component'], ['demo.tsx', 'demo']]);
  assert.equal(reading.entryPoint, 'skyline-card.tsx');
  const [component] = byRole(reading, 'component');
  const [demo] = byRole(reading, 'demo');
  assert.ok(component.content.startsWith('"use client"\n'));
  assert.ok(component.content.endsWith('export default SkylineCard;\n'));
  assert.ok(component.content.includes('keeps a \\` backtick'));
  assert.ok(!component.content.includes('demo.tsx'));
  assert.ok(demo.content.startsWith('import { SkylineCard } from "@/components/ui/skyline-card"\n'));
  assert.ok(demo.content.endsWith('}\n') && !demo.content.endsWith('}\n\n'));
  assert.deepEqual(reading.suspicions, []);
});

test('old-marker paste yields the same files as the current format', async () => {
  const current = parseTwentyFirstPaste(await fixture('current-format.txt'));
  const markers = parseTwentyFirstPaste(await fixture('old-markers.txt'));
  assert.equal(markers.format, 'markers');
  assert.equal(markers.hasFilenames, false);
  assert.deepEqual(markers.files.map((file) => file.role), ['component', 'demo']);
  assert.equal(byRole(markers, 'component')[0].content, byRole(current, 'component')[0].content);
  assert.equal(byRole(markers, 'demo')[0].content, byRole(current, 'demo')[0].content);
  assert.equal(markers.entryPoint, 'component.tsx');
  assert.deepEqual(markers.importPackages, current.importPackages);
});

test('a fence closes only on a bare run of at least its opening length', () => {
  const text = [
    '<!-- SYNTHETIC FIXTURE -->',
    '````tsx',
    'fence-card.tsx',
    'export const sample = `',
    '```tsx',
    'x```',
    '```',
    '`;',
    'export function FenceCard() { return <div>{sample}</div>; }',
    ' ````  ',
  ].join('\n');
  const reading = parseTwentyFirstPaste(text);
  assert.equal(reading.files.length, 1);
  assert.ok(reading.files[0].content.includes('```tsx\nx```\n```\n`;\n'));
  assert.ok(reading.files[0].content.endsWith('FenceCard() { return <div>{sample}</div>; }\n'));
  assert.ok(!reading.suspicions.some((item) => item.reason === 'unterminated-fence'));
});

test('a template literal line of three backticks still splits the file, and the brackets reveal it', () => {
  const text = ['<!-- SYNTHETIC FIXTURE -->', '```tsx', 'early-card.tsx', 'export const s = `', '```', '`;', '```'].join('\n');
  const reading = parseTwentyFirstPaste(text);
  assert.deepEqual(reading.files.map((file) => file.path), ['early-card.tsx']);
  assert.ok(reading.suspicions.some((item) => item.file === 'early-card.tsx' && item.reason === 'unbalanced-brackets'));
  assert.ok(!reading.suspicions.some((item) => item.reason === 'unterminated-fence'));
});

test('a fence opener with an info string such as a title is read as a fence', () => {
  const text = ['<!-- SYNTHETIC FIXTURE -->', '```tsx title="x"', 'title-card.tsx', 'export function A() { return <div />; }', '```'].join('\n');
  assert.deepEqual(parseTwentyFirstPaste(text).files.map((file) => file.path), ['title-card.tsx']);
});

test('indented and tilde fences open and close', () => {
  const text = ['<!-- SYNTHETIC FIXTURE -->', '  ~~~tsx', 'tilde-card.tsx', 'export function A() { return <div />; }', '  ~~~'].join('\n');
  assert.deepEqual(parseTwentyFirstPaste(text).files.map((file) => file.path), ['tilde-card.tsx']);
});

test('a custom prompt with an inline example before the files is still read', async () => {
  const reading = parseTwentyFirstPaste(await fixture('current-format-custom-prompt.txt'));
  assert.deepEqual(reading.files.map((file) => file.path), ['quiet-panel.tsx', 'demo.tsx']);
});

test('a fenced example before the real files is dropped and the real file imports', () => {
  const text = ['<!-- SYNTHETIC FIXTURE -->', 'Example:', '```tsx', 'import { X } from "x"', '```', '```tsx', 'real-card.tsx', 'export function RealCard() { return <div />; }', '```'].join('\n');
  const reading = parseTwentyFirstPaste(text);
  assert.deepEqual(reading.files.map((file) => file.path), ['real-card.tsx']);
  assert.ok(reading.normalizations.includes('dropped-example-fence'));
});

test('CRLF pastes keep carriage returns in content and still match structure', () => {
  const text = ['<!-- SYNTHETIC FIXTURE -->', '```tsx', 'crlf-card.tsx', 'export function CrlfCard() {', '  return <div />;', '}', '```', ''].join('\r\n');
  const reading = parseTwentyFirstPaste(text);
  assert.deepEqual(reading.files.map((file) => file.path), ['crlf-card.tsx']);
  assert.equal(reading.files[0].content, 'export function CrlfCard() {\r\n  return <div />;\r\n}\r\n');
});

test('bare code yields one file and requires a name', async () => {
  for (const name of ['bare-fenced.txt', 'bare-unfenced.txt']) {
    const reading = parseTwentyFirstPaste(await fixture(name));
    assert.equal(reading.format, 'bare-code');
    assert.equal(reading.hasFilenames, false);
    assert.equal(reading.files.length, 1);
    assert.equal(reading.files[0].path, 'component.tsx');
    assert.equal(reading.files[0].role, 'component');
  }
  assert.ok(parseTwentyFirstPaste(await fixture('bare-unfenced.txt')).files[0].content.startsWith('// SYNTHETIC FIXTURE'));
  assert.deepEqual(unreadable('just some words about a card'), ['format:no-code-found']);
});

test('a paste without a demo yields only the component', async () => {
  const reading = parseTwentyFirstPaste(await fixture('no-demo.txt'));
  assert.deepEqual(reading.files.map((file) => [file.path, file.role]), [['plain-badge.tsx', 'component']]);
});

test('only empty, oversized, codeless and componentless pastes are refused', async () => {
  assert.deepEqual(unreadable('   \n\n'), ['damaged:empty']);
  assert.deepEqual(unreadable('​ \n'), ['damaged:empty']);
  assert.deepEqual(unreadable('x'.repeat(5 * 1024 * 1024 + 1)), ['format:too-large']);
  assert.deepEqual(unreadable(await fixture('unreadable-prose.txt')), ['format:no-code-found']);
  assert.deepEqual(unreadable(['Install NPM dependencies:', '```bash', 'motion', '```'].join('\n')), ['format:no-code-found']);
  assert.deepEqual(unreadable(['```css', 'styles.css', '.a { color: red; }', '```'].join('\n')), ['format:no-component']);
  assert.deepEqual(unreadable(['```tsx', '// --- Demo ---', 'export default 1;', '```'].join('\n')), ['format:no-component']);
});

test('two bare fences import as component and demo', async () => {
  const reading = parseTwentyFirstPaste(await fixture('two-bare-fences.txt'));
  assert.equal(reading.format, 'bare-code');
  assert.deepEqual(reading.files.map((file) => [file.path, file.role]), [['component.tsx', 'component'], ['demo.tsx', 'demo']]);
  assert.ok(reading.files[1].content.includes('export default function Demo'));
  assert.ok(reading.normalizations.includes('guessed-demo-fence'));
});

test('three bare fences keep the extra one as its own file with a suspicion', () => {
  const text = [
    '```tsx', 'export default function Demo() { return <A />; }', '```',
    '```tsx', 'export function A() { return <div />; }', '```',
    '```tsx', 'export function B() { return <span />; }', '```',
  ].join('\n');
  const reading = parseTwentyFirstPaste(text);
  assert.deepEqual(reading.files.map((file) => [file.path, file.role]), [['demo.tsx', 'demo'], ['component.tsx', 'component'], ['component-2.tsx', 'other']]);
  assert.ok(reading.suspicions.some((item) => item.file === 'component-2.tsx' && item.reason === 'unnamed-file'));
});

test('structural oddities become normalizations or suspicions instead of refusals', () => {
  const stray = parseTwentyFirstPaste(['```tsx', 'stray text', 'a.tsx', 'export const a = 1;', '```'].join('\n'));
  assert.deepEqual(stray.files.map((file) => file.path), ['a.tsx']);
  assert.equal(stray.files[0].content, 'export const a = 1;\n');
  assert.ok(stray.normalizations.includes('dropped-stray-text'));

  const strayCode = parseTwentyFirstPaste(['```tsx', 'import x from "y"', 'a.tsx', 'export const a = 1;', '```'].join('\n'));
  assert.ok(strayCode.files[0].content.startsWith('import x from "y"\n'));
  assert.deepEqual(strayCode.suspicions.filter((item) => item.reason === 'stray-text'), [{ file: 'a.tsx', reason: 'stray-text', line: 1 }]);

  const duplicate = parseTwentyFirstPaste(['```tsx', 'a.tsx', 'export const a = 1;', 'a.tsx', 'export const b = 2;', '```'].join('\n'));
  assert.deepEqual(duplicate.files.map((file) => file.path), ['a.tsx', 'a-2.tsx']);
  assert.ok(duplicate.suspicions.some((item) => item.file === 'a-2.tsx' && item.reason === 'duplicate-filename'));

  const mixed = parseTwentyFirstPaste(['```tsx', 'a.tsx', 'export const a = 1;', '// --- Demo ---', 'export default 1;', '```'].join('\n'));
  assert.equal(mixed.format, 'filename-fences');
  assert.ok(mixed.files[0].content.includes('// --- Demo ---\n'));

  const demos = parseTwentyFirstPaste(['```tsx', 'a.tsx', 'export const a = 1;', 'demo.tsx', 'export default 1;', 'Demo.jsx', 'export default 2;', '```'].join('\n'));
  assert.deepEqual(demos.files.map((file) => [file.path, file.role]), [['a.tsx', 'component'], ['demo.tsx', 'demo'], ['Demo.jsx', 'other']]);
  assert.ok(demos.suspicions.some((item) => item.file === 'Demo.jsx' && item.reason === 'duplicate-demo'));

  const unmarked = parseTwentyFirstPaste(['```tsx', 'export function A() { return <div />; }', '// --- Demo ---', 'export default function Demo() { return <A />; }', '```'].join('\n'));
  assert.deepEqual(unmarked.files.map((file) => [file.path, file.role]), [['component.tsx', 'component'], ['demo.tsx', 'demo']]);
  assert.ok(unmarked.normalizations.includes('unmarked-component'));
});

test('a loose marker is read as a marker', async () => {
  const reading = parseTwentyFirstPaste(await fixture('messy-loose-marker.txt'));
  assert.equal(reading.format, 'markers');
  assert.deepEqual(reading.files.map((file) => file.role), ['component', 'demo']);
  assert.ok(reading.normalizations.includes('loose-marker'));
  assert.ok(!reading.files[0].content.includes('Component --'));
});

test('a replacement character imports with a suspicion and the byte kept', async () => {
  const reading = parseTwentyFirstPaste(await fixture('messy-replacement-char.txt'));
  assert.ok(reading.files[0].content.includes('Caf� menu'));
  assert.deepEqual(reading.suspicions, [{ file: 'garbled-card.tsx', reason: 'replacement-character', line: 2 }]);
});

test('an unterminated fence closes at the end of the paste with a suspicion', async () => {
  const reading = parseTwentyFirstPaste(await fixture('messy-unterminated.txt'));
  assert.deepEqual(reading.files.map((file) => file.path), ['cut-card.tsx']);
  assert.ok(reading.files[0].content.endsWith('}\n'));
  assert.ok(reading.suspicions.some((item) => item.file === 'cut-card.tsx' && item.reason === 'unterminated-fence' && item.line === 3));
});

test('invisible characters and stray whitespace never hide structure, and content bytes stay', () => {
  const text = [
    '﻿<!-- SYNTHETIC FIXTURE -->',
    '```tsx​',
    'nbsp-card.tsx ',
    'export function NbspCard() {',
    '  return <div>a b</div>;',
    '}',
    '``` ',
    '​```tsx',
    '⁠demo.tsx',
    'export default function Demo() { return <NbspCard />; }',
    '``` ',
  ].join('\n');
  const reading = parseTwentyFirstPaste(text);
  assert.deepEqual(reading.files.map((file) => [file.path, file.role]), [['nbsp-card.tsx', 'component'], ['demo.tsx', 'demo']]);
  assert.ok(reading.files[0].content.includes('a b'));
  assert.ok(reading.normalizations.includes('stripped-bom'));
  assert.deepEqual(reading.suspicions, []);
});

test('decorated filenames are read and a path prefix keeps only the basename', () => {
  const text = [
    '```tsx',
    '// components/ui/deco-card.tsx',
    'export function DecoCard() { return <div />; }',
    '',
    '**demo.tsx**:',
    'export default function Demo() { return <DecoCard />; }',
    '',
    '`extra.ts`',
    'export const extra = 1;',
    '// note.ts',
    'export const tail = 2;',
    '```',
  ].join('\n');
  const reading = parseTwentyFirstPaste(text);
  assert.deepEqual(reading.files.map((file) => file.path), ['deco-card.tsx', 'demo.tsx', 'extra.ts']);
  assert.ok(reading.files[2].content.includes('// note.ts\n'));
  assert.ok(reading.normalizations.includes('dropped-path-prefix:deco-card.tsx'));
  assert.ok(reading.normalizations.includes('decorated-filename:demo.tsx'));
});

test('a fence of install commands is an install list even without the heading', () => {
  const text = ['```tsx', 'a.tsx', 'export const A = () => <div />;', '```', '```bash', 'npm install motion @scope/kit@^2.0.0', '```'].join('\n');
  const reading = parseTwentyFirstPaste(text);
  assert.deepEqual(reading.files.map((file) => file.path), ['a.tsx']);
  assert.deepEqual(reading.installPackages, [{ name: 'motion', range: '*' }, { name: '@scope/kit', range: '^2.0.0' }]);
});

test('a path-like line is never read as a filename', () => {
  const reading = parseTwentyFirstPaste(['```tsx', '../evil.tsx', 'export const a = 1;', '```'].join('\n'));
  assert.deepEqual(reading.files.map((file) => file.path), ['component.tsx']);
  assert.ok(reading.files[0].content.startsWith('../evil.tsx\n'));
});

test('npm packages come from the install list and import lines with subpaths collapsed', async () => {
  const reading = parseTwentyFirstPaste(await fixture('current-format.txt'));
  assert.deepEqual(reading.installPackages, [{ name: 'gsap', range: '3.12.5' }]);
  assert.deepEqual(reading.importPackages, ['gsap']);
  const scoped = parseTwentyFirstPaste([
    '<!-- SYNTHETIC FIXTURE -->',
    'Install NPM dependencies:',
    '```bash',
    'npm install @scope/kit@^2.0.0',
    'motion',
    '```',
    'Component:',
    '```tsx',
    'kit-card.tsx',
    'import { Kit } from "@scope/kit/sub"',
    'import {',
    '  motion,',
    '} from "motion/react"',
    "import 'side-effect-lib/styles.css'",
    'import { useState } from "react"',
    'import { createPortal } from "react-dom"',
    'import local from "./local"',
    'import { cn } from "@/lib/utils"',
    'import thing from "~/thing"',
    'import fs from "node:fs"',
    'export function KitCard() { return <Kit />; }',
    '```',
  ].join('\n'));
  assert.deepEqual(scoped.installPackages, [{ name: '@scope/kit', range: '^2.0.0' }, { name: 'motion', range: '*' }]);
  assert.deepEqual(scoped.importPackages, ['@scope/kit', 'motion', 'side-effect-lib']);
  assert.deepEqual(scoped.aliasImports, ['@/lib/utils', '~/thing']);
});

test('alias imports come from non-demo files only', async () => {
  const reading = parseTwentyFirstPaste(await fixture('with-shadcn-and-remote.txt'));
  assert.deepEqual(reading.aliasImports, ['@/components/ui/button', '@/lib/utils']);
  assert.deepEqual(reading.importPackages, []);
});

test('author hint comes from a Built using comment', async () => {
  const reading = parseTwentyFirstPaste(await fixture('author-built-using.txt'));
  assert.equal(reading.authorHint, 'Example Studio');
  assert.equal(parseTwentyFirstPaste(await fixture('no-demo.txt')).authorHint, undefined);
});

test('advisory suspicions are reported and never thrown', async () => {
  const truncated = parseTwentyFirstPaste(await fixture('suspect-truncated.txt'));
  assert.ok(truncated.suspicions.some((item) => item.file === 'short-card.tsx' && item.reason === 'truncated-tail'));
  const placeholder = parseTwentyFirstPaste(await fixture('suspect-placeholder.txt'));
  assert.deepEqual(placeholder.suspicions, [{ file: 'long-list.tsx', reason: 'placeholder-ellipsis', line: 2 }]);
  const brackets = parseTwentyFirstPaste(await fixture('suspect-brackets.txt'));
  assert.deepEqual(brackets.suspicions.map((item) => [item.file, item.reason]), [['open-card.tsx', 'unbalanced-brackets']]);
});

test('clean pastes with apostrophes in JSX text raise no suspicions', async () => {
  for (const name of ['jsx-apostrophes-clean.txt', 'current-format.txt', 'with-shadcn-and-remote.txt', 'old-markers.txt', 'no-demo.txt', 'author-built-using.txt']) {
    assert.deepEqual(parseTwentyFirstPaste(await fixture(name)).suspicions, [], name);
  }
});
