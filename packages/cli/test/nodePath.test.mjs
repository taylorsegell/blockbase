import assert from 'node:assert/strict';
import test from 'node:test';
import { stableNodePath } from '../dist/service/nodePath.js';

function deps(links) {
  return { exists: (p) => p in links, realpath: (p) => links[p] ?? p };
}

test('Cellar node maps to the opt symlink', () => {
  const exec = '/opt/homebrew/Cellar/node/26.11.1/bin/node';
  const d = deps({ '/opt/homebrew/opt/node/bin/node': exec });
  assert.equal(stableNodePath(exec, d), '/opt/homebrew/opt/node/bin/node');
});

test('Cellar node@24 maps to opt/node@24', () => {
  const exec = '/opt/homebrew/Cellar/node@24/24.3.0/bin/node';
  const d = deps({ '/opt/homebrew/opt/node@24/bin/node': exec });
  assert.equal(stableNodePath(exec, d), '/opt/homebrew/opt/node@24/bin/node');
});

test('Linuxbrew prefix maps correctly', () => {
  const exec = '/home/linuxbrew/.linuxbrew/Cellar/node/26.11.1/bin/node';
  const d = deps({ '/home/linuxbrew/.linuxbrew/opt/node/bin/node': exec });
  assert.equal(stableNodePath(exec, d), '/home/linuxbrew/.linuxbrew/opt/node/bin/node');
});

test('missing candidate falls back to execPath', () => {
  const exec = '/opt/homebrew/Cellar/node/26.11.1/bin/node';
  assert.equal(stableNodePath(exec, deps({})), exec);
});

test('candidate resolving to a different binary falls back to execPath', () => {
  const exec = '/opt/homebrew/Cellar/node/26.11.1/bin/node';
  const d = deps({ '/opt/homebrew/opt/node/bin/node': '/opt/homebrew/Cellar/node/25.0.0/bin/node' });
  assert.equal(stableNodePath(exec, d), exec);
});

test('nvm path is unchanged', () => {
  const exec = '/Users/me/.nvm/versions/node/v24.1.0/bin/node';
  assert.equal(stableNodePath(exec, deps({})), exec);
});
