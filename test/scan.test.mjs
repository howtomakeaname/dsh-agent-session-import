import assert from 'node:assert/strict';
import test from 'node:test';

import { SourceScanner } from '../lib/host/scan.js';

test('payload merges imported-session ids into the cached scan', () => {
  const scanner = new SourceScanner();
  scanner.scanAt = 1234;
  scanner.scan = {
    error: null,
    sources: [
      {
        id: 'codex',
        label: 'Codex',
        description: '',
        available: true,
        location: '',
        error: null,
        conversations: [{ source: 'codex', id: 'c1', title: 'demo' }],
      },
    ],
  };
  const payload = scanner.payload({ 'codex:c1': { sessionId: 'session-1' } });
  assert.equal(payload.total, 1);
  assert.equal(payload.scannedAt, 1234);
  assert.equal(payload.sources[0].count, 1);
  assert.equal(payload.sources[0].conversations[0].key, 'codex:c1');
  assert.equal(payload.sources[0].conversations[0].importedSessionId, 'session-1');
});
