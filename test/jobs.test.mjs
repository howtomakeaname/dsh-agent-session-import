import assert from 'node:assert/strict';
import test from 'node:test';

import { ImportJobs } from '../lib/host/jobs.js';

test('a job exposes progress and settles exactly once', () => {
  const jobs = new ImportJobs();
  const job = jobs.create(3, 'compatible');
  assert.equal(jobs.busy(), true);
  assert.equal(jobs.active(), job);

  job.completed = 1;
  job.results.push({ ok: true });
  const snapshot = jobs.status(job.jobId);
  assert.equal(snapshot.state, 'running');
  assert.equal(snapshot.completed, 1);

  jobs.finish(job, 'done');
  assert.equal(jobs.busy(), false);
  assert.equal(jobs.active(), null);
  assert.equal(jobs.status(job.jobId).state, 'done');
});

test('only the active job can be cancelled', () => {
  const jobs = new ImportJobs();
  const job = jobs.create(1, 'full');
  assert.deepEqual(jobs.cancel(job.jobId), { cancelled: true, state: 'cancelling' });
  assert.equal(jobs.cancelRequested, true);

  jobs.finish(job, 'cancelled');
  assert.deepEqual(jobs.cancel(job.jobId), { cancelled: false, state: 'cancelled' });
  assert.equal(jobs.cancel('missing'), null);
});

test('finished jobs beyond the retention window are pruned', () => {
  const jobs = new ImportJobs({ maxRetained: 2 });
  const first = jobs.create(1, 'full');
  jobs.finish(first, 'done');
  const second = jobs.create(1, 'full');
  jobs.finish(second, 'done');
  const third = jobs.create(1, 'full');
  jobs.finish(third, 'done');
  assert.equal(jobs.jobs.size, 2);
  assert.equal(jobs.status(first.jobId), null);
  assert.equal(jobs.status(third.jobId).state, 'done');
});
