import assert from 'node:assert/strict';
import test from 'node:test';
import { sendHandoffToHost } from '../src/lib/hostHandoff.ts';

function fakeWindow({ framed, search }) {
  const posted = [];
  const win = { location: { search }, parent: undefined, postMessage() {} };
  win.parent = framed ? { postMessage: (message, target) => posted.push({ message, target }) } : win;
  return { win, posted };
}

test('posts the id to the parent when framed with host=vscode', () => {
  const { win, posted } = fakeWindow({ framed: true, search: '?embedded=1&host=vscode&theme=dark' });
  assert.equal(sendHandoffToHost('cmp_local_glow-card', win), true);
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].message, { type: 'blockbase:copy-handoff', componentId: 'cmp_local_glow-card' });
  assert.equal(posted[0].target, '*');
});

test('does nothing when the page is not framed', () => {
  const { win, posted } = fakeWindow({ framed: false, search: '?host=vscode' });
  assert.equal(sendHandoffToHost('cmp_local_x', win), false);
  assert.equal(posted.length, 0);
});

test('does nothing when framed without host=vscode', () => {
  const { win, posted } = fakeWindow({ framed: true, search: '?embedded=1' });
  assert.equal(sendHandoffToHost('cmp_local_x', win), false);
  assert.equal(posted.length, 0);
});

test('does not touch window at import time and is a no-op without one', () => {
  assert.equal(sendHandoffToHost('cmp_local_x'), false);
});
