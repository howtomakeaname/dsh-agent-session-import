import assert from 'node:assert/strict';
import test from 'node:test';

import { providers } from '../lib/host/providers/registry.js';

test('provider registry exposes every supported source exactly once', async () => {
  const list = await providers();
  const ids = list.map((provider) => provider.id);
  assert.equal(new Set(ids).size, ids.length, 'provider ids must be unique');
  assert.deepEqual([...ids].sort(), ['claude-code', 'codex', 'cursor', 'kimi', 'zcode']);
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
