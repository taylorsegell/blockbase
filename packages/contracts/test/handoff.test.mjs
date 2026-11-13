import assert from 'node:assert/strict';
import test from 'node:test';
import { handoffText } from '../dist/index.js';

test('handoffText names the block, its category and the commands to run', () => {
  assert.equal(
    handoffText({ componentId: 'cmp_local_static-card', displayName: 'Static Card', category: 'cards' }),
    [
      'Add "Static Card" (cards) from my Blockbase catalog to this project. Show me the add plan before applying it.',
      '',
      'blockbase inspect cmp_local_static-card --json',
      'blockbase adapt cmp_local_static-card --project . --json',
    ].join('\n'),
  );
});

test('handoffText falls back to the id when there is no display name or category', () => {
  assert.equal(
    handoffText({ componentId: 'cmp_x' }).split('\n')[0],
    'Add cmp_x from my Blockbase catalog to this project. Show me the add plan before applying it.',
  );
});
