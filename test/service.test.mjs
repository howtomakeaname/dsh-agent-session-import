import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ImportService } from '../lib/host/service.js';

function createService() {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-import-service-'));
  const logger = { info() {}, warn() {} };
  const ctx = { logger, get: () => undefined };
  const service = new ImportService(ctx);
  return { service, restore: () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; } };
}

test('unknown endpoints answer a structured failure', async () => {
  const { service, restore } = createService();
  try {
    const result = await service.handle('nope', {});
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'unknown-endpoint');
  } finally {
    restore();
  }
});

test('status and cancel propagate not-found failures at the top level', async () => {
  const { service, restore } = createService();
  try {
    const status = await service.handle('status', { jobId: 'missing' });
    assert.equal(status.ok, false);
    assert.equal(status.error.code, 'not-found');

    const cancel = await service.handle('cancel', { jobId: 'missing' });
    assert.equal(cancel.ok, false);
    assert.equal(cancel.error.code, 'not-found');
  } finally {
    restore();
  }
});

test('import rejects an empty selection before touching persistence', async () => {
  const { service, restore } = createService();
  try {
    const result = await service.handle('import', { items: [], options: { mode: 'compatible' } });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'bad-request');
  } finally {
    restore();
  }
});
