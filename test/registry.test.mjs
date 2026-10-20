import assert from 'node:assert/strict';
import test from 'node:test';

import { providers } from '../lib/host/providers/registry.js';

test('provider registry exposes the documented display order', async () => {
  const list = await providers();
  assert.deepEqual(list.map((provider) => provider.id), ['codex', 'claude-code', 'cursor', 'zcode', 'kimi']);
});

test('every provider implements the provider contract', async () => {
  const list = await providers();
  for (const provider of list) {
    assert.equal(typeof provider.id, 'string');
    assert.equal(typeof provider.label, 'string');
    assert.equal(typeof provider.status, 'function');
    assert.equal(typeof provider.list, 'function');
    assert.equal(typeof provider.load, 'function');
  }
});
