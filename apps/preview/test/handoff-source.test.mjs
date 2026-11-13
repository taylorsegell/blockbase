import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { handoffText } from '@blockbase/contracts';

// The page, sidebar and panel must copy the same text, so the page uses the shared builder.
test('the copy button builds its handoff with handoffText from @blockbase/contracts', async () => {
  const source = await readFile(new URL('../src/components/BlockHandoff.tsx', import.meta.url), 'utf8');
  assert.match(source, /import \{ handoffText[^}]*\} from '@blockbase\/contracts';/);
  assert.doesNotMatch(source, /function handoffText/);
  assert.match(source, /const prompt = handoffText\(block\);/);
  assert.equal(typeof handoffText, 'function');
});
