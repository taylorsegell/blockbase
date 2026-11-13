import assert from 'node:assert/strict';
import { CONTRACT_VERSION, parseSourceEnvelope } from '@blockbase/contracts';

assert.equal(CONTRACT_VERSION, '1');
assert.equal(typeof parseSourceEnvelope, 'function');
