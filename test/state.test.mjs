import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ImportedState, importKey } from '../lib/host/state.js';

const logger = { warn() {} };

test('missing state file starts empty', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-import-state-'));
  const state = new ImportedState(home, logger);
  assert.deepEqual(state.all(), {});
});

test('legacy bare cursor ids migrate to source-qualified keys', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-import-state-'));
  mkdirSync(join(home, 'cursor-import'), { recursive: true });
  writeFileSync(join(home, 'cursor-import', 'imported.json'), JSON.stringify({ 'conv-1': { sessionId: 's1' } }));
  const state = new ImportedState(home, logger);
  assert.deepEqual(state.get(importKey('cursor', 'conv-1')), { sessionId: 's1' });
});

test('set() persists atomically and reloads', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-import-state-'));
  const state = new ImportedState(home, logger);
  state.set(importKey('codex', 'c1'), { sessionId: 'session-1', title: 'demo' });

  const written = JSON.parse(readFileSync(join(home, 'session-import', 'imported.json'), 'utf8'));
  assert.deepEqual(written, { 'codex:c1': { sessionId: 'session-1', title: 'demo' } });

  const reloaded = new ImportedState(home, logger);
  assert.equal(reloaded.get(importKey('codex', 'c1')).sessionId, 'session-1');
});
